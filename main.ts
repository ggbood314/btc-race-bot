// Dip-buying bot for the make.fun cbBTC bars-replay race. This file is
// the whole entry: it speaks the agent-fun/bars-replay/v1 wire protocol
// itself and runs the strategy on top.
//
// The wire, as the harness speaks it: one JSON object per line on stdin.
// First a hello naming the universe, the starting capital, the caps and
// the fees. Then one batch per minute bar, carrying that bar's candles,
// the fills of the orders decided on the previous bar, and the full
// account after them. Every batch is answered with exactly one reply
// line, {"type":"reply","seq":<the batch's seq>,"orders":[...]}, and a
// done message ends the run. Orders decided on a batch fill at the next
// bar's open, moved by slippage and pool impact and charged the fee, so
// size and frequency both cost money. Amounts on the wire are u64
// decimal strings at each symbol's scales; client ids are the bot's own
// (o1, o2, ... below). Positions still open at the end are flattened by
// the harness at the last close. The bot reads nothing but stdin and
// keeps no clock, so two runs over the same tape answer byte for byte
// the same.
//
// The strategy: on a one-minute tape most movement is noise and every
// round trip pays fees, slippage and impact, so this bot trades rarely.
// It waits for a genuinely washed-out tape: RSI(14) under 30, the close
// near a 90-bar low and at least 1.5% under the 240-bar high, plus one
// uptick as proof the fall has stalled. Then it buys with almost all of
// its cash and gives the bounce room: +1.2% over cost take-profit, -0.6%
// under cost stop-loss, or 360 bars held, whichever comes first. After
// an exit it cools down (45 bars, 120 after a stop-loss), it never
// enters in the last stretch of the window, and it never enters more
// than 6 times in a run, so a choppy day cannot bleed it through
// repeated round trips.

import { createInterface } from 'node:readline';

// ---------------------------------------------------------------- tape

interface SymbolInfo {
  symbol: string;
  priceScale: number;
  qtyScale: number;
}

interface Held {
  qty: bigint;
  cost: bigint;
}

/** Everything the harness has told us, folded batch by batch. */
class Tape {
  symbols: SymbolInfo[] = [];
  quoteScale = 0;
  maxWeightBps = 0;
  minNotional = 0n;
  warmupBars = 0;
  seq = -1;
  cash = 0n;
  equity = 0n;
  positions = new Map<string, Held>();
  latestClose = new Map<string, bigint>();
  #sent = 0;

  readHello(hello: any): void {
    this.symbols = hello.symbols.map((s: any) => ({
      symbol: s.symbol,
      priceScale: s.price_scale,
      qtyScale: s.qty_scale,
    }));
    this.quoteScale = hello.capital.quote_scale;
    this.maxWeightBps = hello.caps.max_weight_bps;
    this.minNotional = BigInt(hello.fees.min_notional_quote_units);
    this.warmupBars = hello.warmup_bars ?? 0;
    this.cash = this.equity = BigInt(hello.capital.quote_units);
  }

  /** Fold one batch in (its bars, then its account); returns its bars. */
  fold(batch: any): any[] {
    this.seq = batch.seq;
    for (const bar of batch.bars) {
      this.latestClose.set(bar.symbol, BigInt(bar.c));
    }
    const account = batch.account;
    this.cash = BigInt(account.cash_quote_units);
    this.equity = BigInt(account.equity_quote_units);
    this.positions.clear();
    for (const p of account.positions) {
      this.positions.set(p.symbol, { qty: BigInt(p.qty), cost: BigInt(p.cost_quote_units) });
    }
    return batch.bars;
  }

  /** True on warm-up batches, whose orders the harness always refuses. */
  get warmingUp(): boolean {
    return this.warmupBars > 0 && this.seq < this.warmupBars;
  }

  /** What qty of the symbol is worth at its latest close, in quote units. */
  valueOf(symbol: string, qty: bigint): bigint {
    const info = this.symbols.find((s) => s.symbol === symbol);
    const price = this.latestClose.get(symbol);
    if (info === undefined || price === undefined) return 0n;
    return (qty * price * 10n ** BigInt(this.quoteScale)) / 10n ** BigInt(info.qtyScale + info.priceScale);
  }

  /** The most one buy of the symbol may spend under the weight cap. */
  roomFor(symbol: string): bigint {
    const held = this.positions.get(symbol);
    const room = (BigInt(this.maxWeightBps) * this.equity) / 10_000n - this.valueOf(symbol, held?.qty ?? 0n);
    return room > 0n ? room : 0n;
  }

  /** Client ids o1, o2, ... in the order orders are sent. */
  nextClientId(): string {
    this.#sent += 1;
    return `o${this.#sent}`;
  }
}

// ------------------------------------------------------------ strategy

const RSI_PERIOD = 14;
const RSI_ENTER = 30;
const LOW_WINDOW = 90;
const LOW_TOLERANCE = 1.008;
const HIGH_WINDOW = 240;
const HIGH_DROP = 0.985;
const MAX_HOLD_BARS = 360;
const LAST_ENTRY_BAR = 1080;
const COOLDOWN_BARS = 45;
const STOP_COOLDOWN_BARS = 120;
const MAX_ENTRIES = 6;
const BUY_SLIPPAGE_BPS = 100;
const SELL_SLIPPAGE_BPS = 200;

const closes: number[] = [];
let avgGain: number | null = null;
let avgLoss: number | null = null;
let barNo = -1;
let entryBar = -1;
let cooldownUntil = -1;
let entries = 0;

function pushClose(c: number): void {
  closes.push(c);
  if (closes.length > RSI_PERIOD + 1) {
    if (avgGain === null || avgLoss === null) {
      let g = 0;
      let l = 0;
      for (let i = closes.length - RSI_PERIOD; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) g += d;
        else l -= d;
      }
      avgGain = g / RSI_PERIOD;
      avgLoss = l / RSI_PERIOD;
    } else {
      const d = closes[closes.length - 1] - closes[closes.length - 2];
      const up = d > 0 ? d : 0;
      const down = d < 0 ? -d : 0;
      avgGain = (avgGain * (RSI_PERIOD - 1) + up) / RSI_PERIOD;
      avgLoss = (avgLoss * (RSI_PERIOD - 1) + down) / RSI_PERIOD;
    }
  }
}

function rsi(): number | null {
  if (avgGain === null || avgLoss === null) return null;
  const moved = avgGain + avgLoss;
  return moved === 0 ? 50 : (100 * avgGain) / moved;
}

/** The orders decided on this batch, already in wire shape. */
function decide(tape: Tape, bars: any[]): any[] {
  const symbol = tape.symbols[0].symbol;
  let fresh = false;
  for (const bar of bars) {
    if (bar.symbol === symbol) {
      pushClose(Number(bar.c));
      fresh = true;
    }
  }
  if (!fresh) return [];
  barNo += 1;
  const r = rsi();
  const held = tape.positions.get(symbol);

  if (held !== undefined && held.qty > 0n) {
    const value = tape.valueOf(symbol, held.qty);
    const takeProfit = value * 1000n >= held.cost * 1012n;
    const stopLoss = value * 1000n <= held.cost * 994n;
    const timedOut = barNo - entryBar >= MAX_HOLD_BARS;
    if (takeProfit || stopLoss || timedOut) {
      cooldownUntil = barNo + (stopLoss ? STOP_COOLDOWN_BARS : COOLDOWN_BARS);
      return [
        {
          side: 'sell',
          client_id: tape.nextClientId(),
          symbol,
          qty: held.qty.toString(),
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  if (tape.warmingUp) return [];
  if (tape.seq - tape.warmupBars > LAST_ENTRY_BAR) return [];
  if (entries >= MAX_ENTRIES) return [];
  if (barNo < cooldownUntil) return [];
  if (r === null || closes.length < HIGH_WINDOW) return [];
  let windowLow = Infinity;
  for (let i = closes.length - LOW_WINDOW; i < closes.length; i++) {
    if (closes[i] < windowLow) windowLow = closes[i];
  }
  let windowHigh = -Infinity;
  for (let i = closes.length - HIGH_WINDOW; i < closes.length; i++) {
    if (closes[i] > windowHigh) windowHigh = closes[i];
  }
  const last = closes[closes.length - 1];
  const stalled = last > closes[closes.length - 2];
  const washedOut = last <= windowLow * LOW_TOLERANCE && last <= windowHigh * HIGH_DROP;
  if (r < RSI_ENTER && stalled && washedOut) {
    let spend = (tape.cash * 98n) / 100n;
    const room = tape.roomFor(symbol);
    if (room < spend) spend = room;
    if (spend <= 0n || spend < tape.minNotional) return [];
    entries += 1;
    entryBar = barNo;
    return [
      {
        side: 'buy',
        client_id: tape.nextClientId(),
        symbol,
        notional_quote_units: spend.toString(),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

// ------------------------------------------------------------ the loop

const tape = new Tape();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    tape.readHello(msg);
  } else if (msg.type === 'batch') {
    const bars = tape.fold(msg);
    const orders = decide(tape, bars);
    process.stdout.write(`${JSON.stringify({ type: 'reply', seq: msg.seq, orders })}\n`);
  } else if (msg.type === 'done') {
    break;
  }
}
