# site-generator-speed-01-run-20261122-entry

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/888chunfeng168/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/888chunfeng168/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: a dependency-free static site generator that reproduces its build byte for byte, in about a third of its CPU time. One fused pass renders each Markdown body, inline markup is scanned with regex jumps, slugs and dates are cached, templates render straight into a chunk array, and includes that read only the build's globals (header, nav, footer and the like) render once per case instead of once per page.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json`, answers each one with `run()` from `solve.js`, and writes `$MAKEFUN_OUTPUT_DIR/answers.json`. It runs on Node 22.18 or later (`node main.ts`); on Node 22.6 to 22.17 run it as `node --experimental-strip-types main.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ddg3n73c&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
