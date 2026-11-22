# launch-odds-radar-v9

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v9/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v9/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch-Odds Radar v9 — a dashboard that ranks pre-token protocols by what their token would be worth, each with a ten-step farm plan and a net-of-fees verdict. The model (radar-9) is a ridge regression with Huber reweighting fitted at run time from the sealed snapshot: log10 market cap from TVL, 7-day growth, age, chains and semantic category groups — never a hand-kept list of names, and never the category's own token rate (self-leakage, banned from this model). Measured out-of-sample on the 95 labelled protocols: LOO miss ×2.63, walk-forward (66 older / 29 newer) ×2.26, stratified 5-fold worst ×4.48, bootstrap interval coverage 60% / 80%, AUC 0.776, Brier 0.196. Board: 198 rankable pre-token rows, watchlist 40/40, 143 FARM / 55 SKIP on net economics. Anchor: drand round 6665201, wallet 9gXDJHuTGSntcjA6Ent2oabFwxxs6N1yF3NwfypTwFsq.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Requires Node.js 22.18 or later. The program writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`, deterministically — two runs produce byte-identical outputs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=p9r33tb4&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
