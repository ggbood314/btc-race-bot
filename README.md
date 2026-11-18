# btc-race-bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/ggbood314/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/ggbood314/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A dip-buying bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, in a replay of its on-chain prices. It trades rarely on purpose: every round trip pays fees, slippage and pool impact, so it waits for a washed-out tape (RSI(14) under 30, the close near a 90-bar low and at least 1.5% under the 240-bar high, plus one uptick as proof the fall has stalled), buys with almost all of its cash, and leaves on a +1.2% take-profit, a -0.6% stop-loss or after 360 bars. One file, `main.ts`, speaks the bars-replay protocol itself and runs the strategy; it reads nothing but stdin, so two runs over the same tape answer byte for byte the same. On the published dev window it nets +$5.74 while all four house baselines lose money.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin and stdout: send it a hello line, then one batch line per bar, and read one reply line per batch.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ez1wpb8k&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
