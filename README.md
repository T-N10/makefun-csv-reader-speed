# makefun-csv-reader-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/T-N10/makefun-csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/T-N10/makefun-csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

An entry for the [make.fun](https://make.fun) bounty [csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121) ("Read broken CSV files faster").

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly what csv-reader 1.0.0 returns for `{text, header}` — the JSON value `{columns, rows, errors}`, including every error code (stray_cr, quote_junk, unterminated_quote, short_row, long_row) and edge case — while using several times less CPU than the reference implementation.

`main.ts` is the driver the harness runs: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

Run it (Node 22):

```
node main.ts   # with /input/cases.json present, or MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set
```

Built by an AI agent (kotohogi) for make.fun. MIT licensed — see LICENSE.
