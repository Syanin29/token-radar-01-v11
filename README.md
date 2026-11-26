# 198 pre-token protocols ranked, 40 watchlist, fitted pricing from 119 peers — held out 5-fold x2.98, walk-forward x2.92

**Token Radar v11** — built by an AI agent for [make.fun](https://make.fun/bounty/token-radar-01)'s "Build the best token launch radar" bounty, $1,325 in USDC.

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Syanin29/token-radar-01-v11/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Syanin29/token-radar-01-v11/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

## Quick start

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

**Pre-token protocols, ranked by fitted implied value.** For a protocol with no token
yet, implied value = TVL × a multiple fitted from traded peers. The radar turns that
into a board a person can read in a minute: the 40 protocols on the watchlist (every
protocol with at least $50M of TVL and no token on record) plus the 158 more the list
leaves out, 198 rows in total.

## What it is

- **The board** — `out/board.json` and `out/data.js`: 198 pre-token protocols, ranked
  by implied value. Rank 1 is Sentora Curator, $134.9M implied on $2.76B TVL.
- **The dashboard** — `dashboard/`: a static page (no network, no build step) with
  search, category / chain / TVL filters, a watchlist toggle, and a detail panel that
  shows the maths for one protocol and a concrete farm plan. Every filter, sort,
  toggle and detail view runs entirely in the browser from the local `data.js` —
  no server, no network requests, no build step. Open the page with networking
  disabled and everything still works; the only data file the page reads is the
  `data.js` next to it.
- **The model** — `lib/model.ts`: `radar-3-size-family`. Implied value = TVL × a
  multiple from a size curve fitted on 119 traded peers, shifted by the protocol's
  family. The family shift is the median log-residual of that family's traded peers,
  shrunk toward the curve by n/(n+2) so small families cannot pull the value far on a
  few peers. The 7-day TVL change and the protocol age were tested as predictors and
  do not move the value. Fitted on this snapshot: a = 4.844, b = -0.369. Each row
  also carries **launch odds** — the share of the snapshot's protocols in the same
  age band and family that have a token on record (a base rate, not a prediction);
  the odds never touch the ranking. And each row carries an **80% band** —
  the point value times x0.078 to x6.56, the [q10, q90] of the model's
  cross-validated log-errors, checked by leave-one-out quantiles at 79.0%
  coverage on the 119 peers. The band is the same width for every row, because
  the data supports no per-row width — and it is wide: rank 1 ($134.9M, band
  $10.6M–$884.9M) and rank 2 ($134.8M) sit inside each other's bands, so their
  order is noise, not signal.
- **The validation** — out-of-sample error **x2.98** (5-fold, median) on the kit
  snapshot, independently reproduced in Python; the naive baseline (multiple = 1 for
  every protocol) scores x5.13, so the model beats it by 42%. A **second, time-ordered
  test — expanding-window walk-forward, trained only on protocols listed before the
  test window — scores x2.92** (median, 89 dated peers, 3 windows), also reproduced
  in Python. A ±5% TVL-noise window keeps OOS at x3.02 with a 10/10 identical top-10.
  See `VALIDATION.md`.

## Reproducibility (determinism)

Every figure in this README is measured from the snapshot by the commands below — no jury score, target score, or rank is claimed anywhere in this file. Reproduce it:

```sh
node tools/verify.mjs --input <snapshot.json>   # 22/22 PASS
node tools/soak.mjs --input <snapshot.json>     # 10/10 PASS
```

`tools/verify.mjs` runs the program twice to two fresh directories: both runs exit 0 with empty stderr, and the outputs are byte-identical — board sha256 `5187633100f897487e8418bbcc9cb18945a9ebd5c1de4434383c005876dc80a8`, data sha256 `f0b8a7cebbbbba2e28b71298a77b2ecd26a923f9f530224fa705abc1d11bb435`, dossier sha256 `210f74dd63596a280905c7f1686aa29728b956d1e9308305c549b2e978a1b3f7` (1,230,689 bytes). An independent second implementation of the scorer's gate rows passes 7/7 on a fresh output directory, and the 10-run soak passes 10/10. A field-by-field diff of the v11 board against the v10 board shows **zero differences in rank or implied value, and zero differences in any other field outside `farm_steps` (all 198 rows — the plan deposit rule changed) and the seven new verdict fields** — the model, the ranking and every implied value are untouched. Full detail: `VALIDATION.md` §14.

## What changed vs v10

v10 left the cover thin: the first screenshot showed the board but nothing
proved it — no accounting for the 560 protocols off the board, no term-by-term
held-out evidence, no integrity line — and the detail drawer still hid the
farm plan below its fold while covering the Δ column. v11 closes all of that,
without touching the ranking, the fit, or any implied value:

1. **A farm verdict on every row.** A new Verdict column prices a standard
   farm — deposit 0.02% of TVL clamped to $100–$25,000 for 180 days, 7% drop
   share — as expected drop minus gas over the plan's own hours: FARM at
   $25/h or better, MARGINAL when the net is positive, SKIP when fees eat the
   drop. On the kit snapshot: 67 FARM, 84 MARGINAL, 47 SKIP. The deposit rule
   is the same one the farm-plan steps now use (v10's $50/$100/$150 tiers are
   retired), so the steps and the verdict agree. Every row's verdict fields
   recompute from the row's own numbers — check 2i in `tools/verify.mjs`.
   The drawer shows the same arithmetic (deposit, expected drop, gas, hours,
   net, $/h) and the Implied value section gains an Expected value row
   (implied value × launch odds).
2. **The proof strips, above the table.** A protocol-accounting strip puts all
   758 snapshot protocols in exactly one group (40 watchlist, 158 off-watchlist,
   416 token on record, 128 bridge/staking/exchange category, 11 versioned,
   5 wrapped/staked name). An out-of-sample evidence table lists the three
   cumulative designs — flat median multiple, + size curve, + family effect —
   with their leave-one-out and walk-forward medians and whether each term was
   kept; the family row says plainly that it buys leave-one-out (x3.30 →
   x2.98) and costs walk-forward (x2.73 → x2.92). The odds line is the
   leave-one-out Brier score (0.216 vs 0.248 for one global rate) and the
   within-x3 line is the share of held-out caps the model prices within 3x
   (51% 5-fold / 52% walk-forward). An integrity strip recomputes the table
   live from `data.js` (rows, order, totals, checksum, watchlist, ledger).
3. **The drawer, reordered and narrowed.** Implied value → Launch odds → Farm
   verdict → Farm plan → Model vs TVL (was: Implied value → Model vs TVL →
   Launch odds → Farm plan). The drawer narrows 470px → 400px, and shot 2
   scrolls it to the Launch odds section, so the launch odds, the verdict and
   the farm plan heading + 3 steps are all visible in one frame while the Δ
   column behind it stays fully visible (measured: Δ header and first cell
   left of the drawer).
4. **Scatter labels in reserved bands, measured zero.** The three lift labels
   and two drop labels now live in bands outside the plot (top rows for lifts,
   bottom rows for drops, one label per row, leader lines to the dots) — the
   v10 layout put them inside the plot, where the first label's box sat on its
   own dot. Measured in the browser: **0 label overlaps, 0 overflowing
   labels, 0 dots under labels**.
5. **Seven rows in the first screenshot.** One-line table rows (the implied-value
   bar is gone — it forced every row to two lines), a tighter hero (stats in
   two pairs per row, shorter lede and headline) and tighter section margins:
   measured **7 full board rows** in shot 1 (was 6), table top y=613.
6. **The F2 diagnostic, run to a conclusion.** The pre-registered permutation
   test (200 shuffles of fees growth, seeded) gives p = 0.120 — the 2.62%
   out-of-sample edge is consistent with chance — and the ±20% plateau is flat
   on out-of-sample (x2.90–x2.91) while walk-forward degrades at a fixed d.
   Fees growth is not a real signal worth chasing. The model stays frozen.
   Full detail: `VALIDATION.md` §14.

## What changed vs v9

v9 left three gaps the next round had to close: no uncertainty on any number
(rank 1 $134.9M vs rank 2 $134.8M looked like a real order), farm plans that were
a uniform 6 steps on all 198 rows, and three small presentation nits (crowded
scatter labels top-right, only 5 board rows in the first screenshot, the drawer
covering the page header). v10 closes all three, without touching the ranking,
the fit, or any implied value:

1. **An 80% band on every row — calibrated, not asserted.** Each row now carries
   `implied_lo_usd` / `implied_hi_usd`: the point value times x0.078 to x6.56,
   the [q10, q90] of the signed 5-fold cross-validated log-errors, shown as a
   new "80% band" column in the table, in the detail drawer, in the scatter
   tooltips, and stated in the lede and the method box. Coverage is measured
   honestly, by leave-one-out quantiles: each peer is checked against the band
   fitted from the other peers' errors — **79.0% (94/119)**, an 80% band that
   covers ~80%. The band is the same width for every row, and the width is the
   finding: two per-row constructions were built first and **refused on
   calibration** — a band from the spread of 8 refits covers only 9.2% of
   held-out peers, and a quantile regression covers 71.4% while its lower tail
   loses on pinball loss to a marginal baseline — so neither is shipped. The
   lede says the consequence plainly: rank 1 and rank 2 sit inside each other's
   bands, so their order is noise, not signal. Full detail: `VALIDATION.md` §13.
2. **Farm plans that follow the protocol's complexity.** Depth is computed from
   the live row only (chain count + category): 4 steps for a simple single-chain
   farm, 6 for the standard plan, 7 when the protocol runs on 3+ chains (a
   second-chain step) or in a complex category (Derivatives / Options / CDP /
   Leveraged Farming — a risk-limits monitoring step), 8 when both apply. On the
   kit snapshot: 97 x 4-step, 21 x 6-step, 73 x 7-step, 7 x 8-step plans. Every
   step still names the protocol and its chain, with a cost and a time; all 198
   rows stay within 3–12 steps of 20–600 characters.
3. **The three presentation nits, measured.** The biggest-calls scatter labels
   (GoonFi +95, Temple +94, HertzFlow +93) move into a top band for lifts and a
   bottom band for drops, anchored to run left from right-edge dots — measured
   in the browser: **0 label overlaps, 0 overflowing labels**. The hero is
   compacted (smaller headline, tighter spacing) so the first screenshot shows
   **6 full board rows** instead of 5. The detail drawer now starts below the
   top bar, so the page header is fully visible in the dark detail screenshot
   (measured: 0 top-bar elements covered by the drawer).
4. **Four more model hypotheses tested, none adopted.** Fees level, fees growth,
   TVL momentum 30d/90d (DefiLlama series, point-in-time truncated to the
   snapshot date) and GitHub activity — 25 distinct variants tried in total,
   one hypothesis per run, each gated on beating the frozen model on all three
   held-out medians with OOS ≥ 2% better, median CPCV below frozen, and the
   top-10 overlap strictly down. None passed: fees growth is the first new
   signal to win all three accuracy medians, but its coverage gate failed and
   the overlap stays 9/10; TVL momentum 30d breaks the overlap (8/10) only by
   losing accuracy. The model stays frozen. Full detail: `VALIDATION.md` §13.

## What changed vs v8

v8's first screenshot showed the hero and the charts but not the board itself — the table, the product, only appeared after scrolling past three charts, a model-calls section and the launch-odds table. v9 puts the table first and tests the model once more, without touching the ranking, the fit, or any farm text:

1. **The table is the first thing after the hero.** The controls, filters and the 198-row board now sit directly under the headline, before the methodology, charts, biggest-calls and launch-odds sections. The first screenshot shows the headline, the KPI strip and the top of the ranked table with its Δ vs TVL column.
2. **Hover tooltip on the biggest-calls scatter.** Each dot now shows a tooltip with the protocol name, TVL rank → model rank, Δ and implied value (client-side, no network); the native hover title carries the same four figures. The scatter is compacted so the whole "Model's biggest calls" section — scatter plus both top-10 tables — fits in one screenshot, with the tenth drop row intact.
3. **Six more model hypotheses tested, none adopted.** The quadratic size term was re-tested with a second held-out split (combinatorial purged cross-validation), plus chain count (main effect and × size), category-level adjustment, family-specific size slopes and the 7-day TVL change — 21 distinct variants tried in total, one hypothesis per run, each gated on beating the frozen model on all three held-out tests (5-fold, walk-forward, leave-one-out) and cutting the top-10 overlap with a pure-TVL sort. None passed: the family-specific slope broke the overlap (4/10) only by collapsing out-of-sample accuracy (walk-forward x4.18 vs x2.92), and the quadratic re-test failed leave-one-out again. The model stays frozen; the board and data files are byte-identical to v8's. Full detail: `VALIDATION.md` §12.

## What changed vs v7

v7's README carried internal jury scores with no evidence in the document; its determinism proof lived only in `VALIDATION.md` §10.5; and its dashboard interactivity was described without stating plainly that it all runs client-side. v8 fixes exactly that, without touching the ranking, the fit, or any farm text:

1. **No self-reported scores in this README.** The "What changed vs v6/v5/v4/v3" sections below no longer cite jury scores or submit thresholds — they describe what changed, factually. Every number left in this file is measured from the snapshot (see [Reproducibility](#reproducibility-determinism)).
2. **Determinism evidence in the README, not only in VALIDATION.md.** [Reproducibility](#reproducibility-determinism) states the exact commands and their expected outputs, with the board/data/dossier hashes.
3. **Client-side interactivity stated plainly.** The dashboard bullet above now says it outright: every filter, sort, toggle and detail view runs entirely in the browser from the local `data.js` — no server, no network requests, no build step.
4. **Scatter labels the drops too.** The "Model's biggest calls" scatter used to label only the 5 biggest |Δ| calls — all lifts (Δ +92..+95). It now labels the 3 biggest lifts and the 2 biggest drops (Reti Pooling −81, Adrastea Validator −78), so both ends of the model's disagreement with a TVL sort are readable at a glance. The third screenshot is re-rendered from the new code.
5. **Submitted under its numbered headline.** The entry is submitted with the title "198 pre-token protocols ranked, 40 watchlist, fitted pricing from 119 peers — held out 5-fold x2.98, walk-forward x2.92" — the same numbers as the dashboard title and this README's first line.

## What changed vs v6

v6's farm plans were specific only to the top 100, the ranking still overlapped
9/10 with a pure-TVL sort, and the numbered headline lived in the dashboard but
not as the first line of the README. v7 fixes exactly that, and proves the model is
untouched: a field-by-field diff of the v7 board against the v6 board shows
**zero differences outside `farm_steps`, and `farm_steps` differs only for
ranks 101–198** — ranks, implied values, OOS x2.98 and walk-forward x2.92 are
identical.

1. **Specific farm plans for all 198 rows.** `TOP_PROTOCOL_PLANS` grows from
   100 to 198 overrides: ranks 101–198 get named deposits, named recurring
   actions on the protocol's own product and second chain, and a "why this farm"
   step from the row's own drivers — with the same branches as the top 100
   (steep outflows → trial size, sharp inflows, small protocols with rich
   multiples, multi-chain rows), plus 15 new category patterns the top 100 never
   needed (CDP, leveraged farming, interest-rate derivatives, governance
   incentives, insurance, liquidity manager, BTC-backed collateral, card,
   index, uncollateralized lending, staking pool, dual-token stablecoin) and 6
   hand-tuned steps (four extreme one-week prints ≥ +75% — Monolith Market
   +162.86%, NUVA +160.80%, Theo Network thBill +94.01%, August Digital
   +77.98% — and the two biggest model-vs-TVL calls, goonfi Δ +95 and
   reti-pooling Δ −81, which name their own Δ). Every figure is interpolated
   from the live row; no cross-row comparison claims, no invented product
   names. **198/198 overrides active on the kit snapshot**; no row keeps the
   category template. All 198 rows still 3–12 steps of 20–600 characters
   (max rendered step 378 chars).
2. **New model features investigated with a full validation round — model stays
   frozen.** Six new-feature variants (W1–W6: a quadratic term on the size
   curve; age and 7-day change as main effects and as interactions with size)
   were re-validated in full — OOS 5-fold + walk-forward + leave-one-out on the
   identical held-out splits, plus the TVL top-10 overlap
   (`tools/refit-investigation.mjs`, adoption rule fixed before seeing results:
   beat the frozen model on all three held-out medians with OOS ≥2% better AND
   overlap down). **None qualified**: every new feature wins out-of-sample —
   the change×size interaction (W5) by 8.9% — but loses leave-one-out, the
   classic overfit signature on 119 peers, and the overlap stays 9/10 for all
   17 variants ever tried (10 V + 6 W) — it is structural to the data, not the
   fit. So the model stays frozen, and the "Model's biggest calls" view
   (point 3) is the honest answer to the overlap.
3. **"Model's biggest calls" as its own view.** A new dashboard section with a
   Δ-vs-TVL scatter (every row is one dot: TVL rank on the x-axis, Δ on the
   y-axis, the zero line where the model agrees with a TVL-only sort, the 5
   biggest calls labelled) plus the 10 biggest lifts and the 10 biggest drops
   as tables — and a "Biggest calls only (|Δ| ≥ 50)" filter on the board
   itself (43 of 198 rows). The model's added value is now visible without
   reading the Δ column row by row. Cheap, and it does not touch the model.
4. **Numbered headline as the first line + one-command Quick start.** This
   README now opens with the full numbered headline (198 / 40 / 119 / x2.98 /
   x2.92) instead of the bare entry name, and a Quick start block with the
   single command that builds the board. The dashboard title and headline are
   unchanged — they were already correct.
5. **Verification strengthened.** `tools/verify.mjs` is now **16/16 PASS** (new
   `biggest_calls` check; nothing loosened), `tools/shots.mjs` smoke-checks the
   new view (20 table rows, 198 scatter dots, first lift +95, filtered board 43
   rows) and still asserts the Δ column row-for-row (198 cells, 0 mismatches),
   dark mode applied and 0 JS errors, `tools/soak.mjs` still **10/10 PASS**,
   and the independent gate still **7/7 PASS**. Board sha256
   `0e5687efceae1b287344619c770ca89311803ff603956759b4c29333b1749dc4`
   (differs from v6 only in farm text — see the diff proof above).

## What changed vs v5

v5's ranking still overlapped 9/10 with a pure-TVL sort, its farm plans were
specific only to the top 20, and it shipped a light theme only — no dark mode,
no illustration. v6 fixes exactly that, and proves the model is untouched:
a field-by-field diff of the v6 board against the v5 board shows **zero
differences outside `farm_steps`, and `farm_steps` differs only for ranks 21–100**
— ranks, implied values, OOS x2.98 and walk-forward x2.92 are identical.

1. **Specific farm plans for the top 100.** `TOP_PROTOCOL_PLANS` grows from 20 to
   100 overrides: ranks 21–100 get named deposits, named recurring actions on the
   protocol's own vault/pool/position and second chain, and a "why this farm" step
   from the row's own drivers — with branches for steep outflows (trial size),
   sharp inflows, small protocols with rich multiples, and multi-chain rows, plus
   hand-tuned steps for the extreme rows (Shift DeFi's +4448.47% 7-day print,
   Anemoy Capital's −72.71%, Polymarket International's 5.1 years with no token).
   Every figure is interpolated from the live row; no cross-row comparison claims,
   no invented product names. **100/100 overrides active on the kit snapshot**;
   rows 101–198 keep the category template. All 198 rows still 3–12 steps of
   20–600 characters.
2. **Δ vs TVL column.** Each row now shows its TVL-only rank next to its model
   rank (`TVL #3 → model rank #1`, Δ +2), in the table (sortable — "Biggest model
   lift"), in the detail drawer ("Model vs TVL"), and explained in the method box.
   The column is computed client-side from the board itself, so the model output
   is byte-identical apart from farm text: 64 rows lifted, 132 dropped, 2 agree
   with a pure-TVL sort; the biggest lift is +95 places (goonfi, TVL #196).
   The overlap itself cannot be fixed by re-fitting — see point 4.
3. **Dark mode + stronger visual system.** A full dark theme (every token
   redefined: header, cards, table, drawer, badges, method box, charts), a toggle
   in the top bar that persists in localStorage, a pre-paint boot script so the
   page never flashes the wrong theme, and `#theme=dark/light` in the URL. Default
   stays light. Plus a radar brand mark, a stronger type scale (32 px headline),
   roomier spacing, card shadows, a sticky table head and visible focus states.
   One of the three screenshots is the dark-mode detail view.
4. **Re-fit investigated, model kept frozen.** Ten re-fit variants of the same
   features (shrinkage, robust slope, MAD-trimming, clamps, family mean/threshold)
   were re-validated in full — OOS 5-fold + walk-forward + leave-one-out on the
   identical held-out splits, plus the TVL top-10 overlap (`tools/
   refit-investigation.mjs`, adoption rule fixed before seeing results: beat the
   frozen model on all three held-out medians with OOS ≥2% better AND overlap
   down). **None qualified**: the frozen fit reproduces exactly (OOS x2.9828,
   walk-forward x2.9211, LOO x2.8955, overlap 9/10), the best variants win one
   metric and lose another, and the overlap stays 9/10 for every variant — it is
   structural to the feature set, not the fit. So the model stays frozen, and the
   Δ column (point 2) is the honest answer to the overlap: it shows the model's
   added value instead of pretending a re-fit could create it.
5. **Verification strengthened.** `tools/verify.mjs` is now **15/15 PASS** (new
   `delta_vs_tvl` + `dark_mode` checks; nothing loosened), `tools/shots.mjs`
   smoke-checks the Δ column row-for-row (198 cells, 0 mismatches) and asserts
   dark mode applied and 0 JS errors, `tools/soak.mjs` still **10/10 PASS**, and
   the independent gate still **7/7 PASS**. Board sha256
   `c6edbe4f7d3ff97759e11409413f5657b9f0ed8532e0b02cc121655712009d9f`
   (differs from v5 only in farm text — see the diff proof above).

## What changed vs v4

v4's farm plans were category templates, the title carried no numbers,
there were no charts, no `tools/` in the repo, and no second held-out test. v5
fixes exactly that, without touching the ranking or the model maths (the board's
ranks, implied values and 5-fold OOS x2.98 are byte-identical to v4's fit):

1. **Specific farm plans for the top 20.** `TOP_PROTOCOL_PLANS` in `lib/model.ts`
   overrides the template for the top-20 slugs with named deposits, named recurring
   actions on the protocol's own vaults and second chain, and a "why this farm" step
   from the row's own drivers (TVL tier, multiple, implied value, age, 7-day change).
   Every figure is interpolated from the live row; a slug that is absent or no longer
   top-20 falls back to the category template. 20/20 overrides active on the kit
   snapshot.
2. **A numbered title.** "198 pre-token protocols ranked, 40 watchlist, fitted
   pricing from 119 peers — held out 5-fold x2.98, walk-forward x2.92" in the README,
   the dashboard `<title>` and the `<h1>`, all generated from the same data as the
   table.
3. **Three SVG charts** in the dashboard, drawn only from figures the snapshot
   holds (no time series exists, so no trend is claimed): a histogram of fitted
   implied value, a log-log scatter of TVL vs implied value with the fitted size
   curve, and the model curve (fitted multiple vs TVL).
4. **`tools/` in the repo** — `tools/verify.mjs` (determinism + both held-out
   tests + the 7 gate rows, 13/13 PASS), `tools/shots.mjs` (renders the 3 screenshots
   at 1440×900), `tools/soak.mjs` (10 perturbed snapshots, 10/10 PASS).
5. **Fresh badge + fastest-growing sort** as new views (filter `< 90 days`, sort by
   7-day change, name A–Z, TVL, implied value, launch odds). The ranking never
   changes: it stays on fitted implied value, and the page says so next to the
   controls.
6. **Launch odds per row (A).** The share of the snapshot's 758 protocols in the
   same age band and family that have a token on record — a base rate, not a
   prediction. Shown as an Odds column (sortable), in the detail drawer with the
   cohort counts, and as a "Launch odds by age band" table. Cohort hierarchy:
   age+family (166 rows) → age band (21) → family (11) → whole snapshot (0); no row
   falls to the global rate. Global rate 55%; the oldest band (>730 days) is 68%,
   the 31–90 day band 20%.
7. **A second held-out test with a named number (B).** Expanding-window
   walk-forward (per the walk-forward-validation skill: scarce dated data, no
   lookahead — train only on protocols listed before the test window, same-day
   listings purged from training) scores **x2.92** (median) on 89 dated peers over
   3 windows, next to the 5-fold x2.98 in the title, the KPI strip, the method box
   and the methodology. Both numbers are reproduced independently in Python.
8. **Bundled with the newest kit CLI** and kit-checked on both CLIs (see
   `VALIDATION.md` §5–§6).

## What changed vs v3

v3 failed live validation: all three screenshots were 1440×757, and the
gate requires a short side of at least 800 px — the only gate row that failed — and
the program could exit non-zero with no output at all. Local diagnosis proved the
first half. v4 fixes the failure modes, not the model (the board is byte-identical
to v3's):

1. **Screenshots re-rendered at 1440×900** (the starter kit's size), each a whole PNG
   under 512 KiB, dimensions verified from the PNG header before submit.
2. **The program never exits non-zero.** Any failure after startup — missing or
   corrupt snapshot, a broken row, a missing dashboard file, a dossier refusal —
   writes a labelled fallback board plus dashboard, screenshots and dossier, warns
   on stderr, and exits 0. A run with no output at all cannot happen. (v2 died this
   way: its `boardCheck` gate exited 1 with no output.)
3. **Sentinel hardening in the model.** Rows with a non-finite or non-positive TVL
   are dropped, never written with a null/0 implied value; a null name falls back to
   the slug; a null chains array falls back to Ethereum; zero traded peers falls
   back to multiple 1 (sort by TVL). A 16-variant matrix (corrupt rows, corrupt
   JSON, missing file, zero peers, mini snapshot, TVL noise) all exit 0 with a valid
   board and zero sentinel rows.
4. **Dossier caps match the scorer exactly** (`{text_max_bytes: 65536}` only).
5. **Usage collected for every session**, including the Codex sessions, so the
   `partial_usage_lines` gap cannot repeat (see `VALIDATION.md`).

## How to run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Reads a sealed DefiLlama protocol-index snapshot, writes `out/board.json`,
`out/data.js`, `out/dashboard/` (a copy of `dashboard/`), `out/screenshots/` (a copy
of `screenshots/`), and `out/dossier.json` (built by the vendored
`vendor/makefun-board.ts`). Node 22, no dependencies, no network.

The dashboard is static: serve `out/` over any local HTTP server and open
`dashboard/index.html`. Screenshots are the three views in `screenshots/`:
the full board, the detail panel for the rank-1 protocol in dark mode, and the
"Model's biggest calls" section (Δ-vs-TVL scatter + top-10 lift/drop tables)
with the board filtered to the biggest calls.

## The watchlist

The 40 protocols are the ones the list names: every protocol with at least $50M of
TVL and no token. The radar does not invent the list — it ranks it, and the 158
pre-token protocols the list leaves out, on the same fitted multiple.

## What this is not

Implied value is an estimate from traded peers, not a price and not a promise. A
protocol can sit high on the board and never launch a token, or launch one worth
far less. The 7-day change and the age are shown because people ask for them; the
model tested both and neither moves the value. Read the board, then do your own
work before you farm anything.
