// Dip-buying bot for the make.fun cbBTC bars-replay race.
//
// Strategy in one paragraph: on a one-minute tape, most movement is noise
// and every round trip costs fees, slippage and pool impact, so this bot
// trades rarely. It waits for a genuinely washed-out tape: RSI(14) under
// 30, the close near a 90-bar low and at least 1.5% under the 240-bar
// high, plus one uptick as proof the fall has stalled. Then it
// buys with almost all of its cash and gives the bounce room: +1.2% over
// cost take-profit, -0.6% under cost stop-loss, or 360 bars held,
// whichever comes first. After an exit it cools down (45 bars, 120 after
// a stop-loss) and it never enters more than 6 times in a run, so a
// choppy day cannot bleed it through repeated round trips.
//
// Deterministic: it reads nothing but the bars the harness sends it, and
// the indicators run in float64 on + - * / alone, so the same bars give
// the same orders, run after run.

import { runBars, type Bar, type BuyInput, type SellInput } from './makefun-bars.ts';

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

await runBars({
  onBatch(state, batch) {
    const symbol = state.hello.symbols[0].symbol;
    let fresh = false;
    for (const bar of batch.bars as Bar[]) {
      if (bar.symbol === symbol) {
        pushClose(Number(bar.c));
        fresh = true;
      }
    }
    if (!fresh) return undefined;
    barNo += 1;
    const r = rsi();
    const held = state.positions.get(symbol);

    if (held !== undefined && held.qty > 0n) {
      const value = state.value(symbol, held.qty);
      const takeProfit = value * 1000n >= held.cost * 1012n;
      const stopLoss = value * 1000n <= held.cost * 994n;
      const timedOut = barNo - entryBar >= MAX_HOLD_BARS;
      if (takeProfit || stopLoss || timedOut) {
        cooldownUntil = barNo + (stopLoss ? STOP_COOLDOWN_BARS : COOLDOWN_BARS);
        const sell: SellInput = { side: 'sell', symbol, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS };
        return [sell];
      }
      return undefined;
    }

    if (state.warmingUp) return undefined;
    if (state.seq - state.warmupBars > LAST_ENTRY_BAR) return undefined;
    if (entries >= MAX_ENTRIES) return undefined;
    if (barNo < cooldownUntil) return undefined;
    if (r === null || closes.length < HIGH_WINDOW) return undefined;
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
      let spend = (state.cash * 98n) / 100n;
      const room = state.weightRoom(symbol);
      if (room < spend) spend = room;
      if (spend <= 0n || spend < BigInt(state.hello.fees.min_notional_quote_units)) return undefined;
      entries += 1;
      entryBar = barNo;
      const buy: BuyInput = { side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: BUY_SLIPPAGE_BPS };
      return [buy];
    }
    return undefined;
  },
});
