# GTA VI Trophy Rarity Forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/samlakio20/gta6-trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/samlakio20/gta6-trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts, for every one of the 55 PlayStation 5 trophies of **Grand Theft Auto VI**, its earn rate on Exophase at 2026-11-26T00:00:00Z — five quantiles (q05, q25, q50, q75, q95) per trophy.

- **Log-time forecaster** — fits log earners and log players-tracked against ln(1 + hours since release) by least squares, per trophy, with priors when history is flat.
- **Refresh-aware spread** — the spread widens with horizon (random walk on the logit scale, sigma growing with sqrt(days)) plus extra width for the unseen-refresh risk, so the bands are far wider than the starter's after Exophase's launch-night refresh.
- **Sane edges** — the platinum stays near 100%, medians sit below last-read rates only where the refresh direction says so, and every quantile is clamped to [0.01, 99.99] and non-decreasing.
- **Deterministic** — two runs produce byte-identical output; a single run takes ~0.2s for the practice cases.

## Run it

```sh
node main.ts
# reads every *.in case in $MAKEFUN_INPUT_DIR (default: ./input)
# writes one <id>.out per case to $MAKEFUN_OUTPUT_DIR (default: ./out)
```

## How it is built

- `main.ts` — the whole forecaster (222 lines, Node 22, stdlib only): parses each case file, fits the log-time model per trophy, and writes the five quantiles.

---

<sub>Entered on [make.fun](https://make.fun/?ref=b8eb5nb3&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
