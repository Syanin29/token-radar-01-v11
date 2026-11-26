// tools/refit-v10.mjs — v10 model investigation: can a NEW signal outside TVL
// break the 9/10 top-10 overlap with a pure-TVL sort? (Node 22, stdlib only.)
//
// Frozen model ("radar-3-size-family"): OLS log(multiple) on log(TVL) +
// family median residual shrunk n/(n+2), clamp [0.005, 2.0]. Frozen numbers
// on the kit snapshot (119 traded peers, as_of 2026-11-14): OOS x2.9828,
// walk-forward x2.9211, LOO x2.8955, CPCV x2.8664, overlap 9/10.
// 21 variants already tried and ALL rejected (V0–V10, W1–W6, R1, N1–N5).
// This script tries the next hypotheses, ONE per invocation, and never
// changes the model — adoption is a separate, deliberate edit if the rule is met.
// Features come from tools/data/features.json (built by
// tools/build-features-v10.mjs from cached raw DefiLlama responses in
// tools/data/ — NO network in this script, fully reproducible offline).
//
// ============================================================================
// PRE-REGISTRATION (written BEFORE any run — the adoption rules below are
// fixed now and MUST NOT be changed after seeing results; when in doubt,
// reject the variant).
// ----------------------------------------------------------------------------
// (1) Adoption rule (v10, warisan v9 + CPCV kini gerbang, rencana §4):
//     a variant is ADOPTED only if it beats frozen on ALL THREE held-out
//     medians (OOS 5-fold + walk-forward expanding + LOO), with OOS >= 2%
//     better, AND median CPCV < frozen median CPCV (x2.8664), AND top-10
//     overlap strictly < 9/10. All four conditions, no exceptions.
// (2) Gates BEFORE a run (rencana §3) — a failed gate is BINDING: the
//     variant is REJECTED without an adoption run. A diagnostic-only run
//     may still be executed and MUST be labelled DIAGNOSTIC in its verdict
//     line; it can never adopt.
//       F1/F2: DQ suite (tools/dq-v10.mjs) exit 0; PIT audit lolos
//         (knowledge time <= as_of 2026-11-14); fees coverage peers >= 80%
//         (>= 115/144). NOTE, recorded before fetching: the plan's own §2
//         states overview overlap with peers is 91/144 = 63.2% — already
//         below the 80% gate. The gate is nevertheless applied as written
//         to the FETCHED per-protocol coverage (overview membership is not
//         the same as fetchability); if fetched coverage is still < 80%,
//         F1/F2 are gate-REJECTED and any run is diagnostic only.
//       M1/M2: TVL-history coverage peers >= 80%; corr(mom, change_7d) and
//         corr(mom, log TVL) reported; if |r| > 0.7 vs change_7d, priority
//         drops (run still executes — the gate is a priority note, not a
//         kill, per rencana §3 wording "turunkan prioritas").
//       G1: coverage gate — >= 50% of board rows have a resolvable GitHub
//         org in the fetched /summary/fees responses. If below, G1 is
//         gate-REJECTED with NO run (no GitHub API calls are made).
// (3) Deflated multiple-testing (skill walk-forward-validation DSR +
//     quant-strategy-research, rencana §4 item 4) — HONEST FORMULATION
//     PROBLEM, recorded before any run: the DSR formula is defined for the
//     Sharpe ratio of a RETURN series (needs backtest length in return
//     observations, return skewness/kurtosis, and a null distribution of
//     max-Sharpe). Our metric is a cross-sectional MEDIAN ERROR FACTOR
//     over 119 peers — there is no return series, no Sharpe, and no
//     sampling distribution of "best-of-N median error" with a closed
//     form. Forcing DSR onto it would be numerology, not a correction.
//     SUBSTITUTE, agreed in the plan: (a) trial count disclosed in full
//     (21 prior + every v10 run, incl. diagnostics); (b) a variant that
//     passes the main gates must ALSO pass a PERMUTATION test — the new
//     feature is shuffled across peers 200x, OOS re-fit each time, and
//     the fraction of permutations with OOS improvement >= the observed
//     one is reported as the permutation p-value (pre-registered
//     threshold p < 0.05); (c) PLATEAU check ±20% on the fitted
//     coefficient d (skill quant-trading-validation): re-fit with d fixed
//     at 0.8x and 1.2x — OOS must not flip sign vs frozen; (d) OPTIMISM
//     AUDIT table (skill quant-trading-validation) listing every
//     optimistic default and its pessimistic re-run. (b)–(d) run ONLY for
//     a variant that passes the main gates; if none passes, they are
//     recorded as NOT TRIGGERED, not as passed.
// (4) Fidelity ladder (skill quant-trading-validation): ALL numbers here
//     are RUNG 4 — signal-only cross-sectional fit error (median
//     |log(pred/actual)|). There are no fills, no execution, no returns.
//     Nothing here claims tradability or live profitability.
// (5) Forward test (skill paper-trading-and-forward-test-protocol): the
//     go/no-go criteria above were fixed BEFORE any test. HONEST LIMIT:
//     there is no new prospective snapshot, so NO genuine forward test
//     exists in this round — held-out + jury are the only evidence. A
//     variant adopted here would still need a forward check on the next
//     snapshot before it could be called confirmed.
// (6) One hypothesis per run; every run re-fits V0 as a sanity check —
//     V0 MUST reproduce the frozen table (OOS 2.9828 / WF 2.9211 /
//     LOO 2.8955 / CPCV 2.8664 / overlap 9/10) or the run is invalid.
// (7) If NOTHING passes: the model STAYS FROZEN, v10 is NOT submitted on
//     model grounds, and the report records the full failure table.
// (8) Missing-feature rule (fixed here): a peer/board row without a
//     measured feature value gets the TRAINING-SET MEDIAN of that feature
//     (computed inside each fit, never a global constant) — documented in
//     the report with the imputation rate per variant.
// ============================================================================
//
// Hypotheses, one per run (invocation: node tools/refit-v10.mjs --variant
// <id> --input <snapshot.json> --features <features.json>).
//   F1  fees level: + d*log(fees_T30d) [USD fees, trailing 30d to as_of].
//       DIAGNOSTIC-ONLY unless the >=80% coverage gate passes.
//   F2  fees growth: + d*log(fees_T30d / fees_prior30d).
//       DIAGNOSTIC-ONLY unless the >=80% coverage gate passes.
//   M1  TVL momentum 30d: + d*mom30 (OLS slope of log TVL, 30d to as_of).
//   M2  TVL momentum 90d: + d*mom90 (OLS slope of log TVL, 90d to as_of).
//   G1  GitHub activity: + d*log1p(commits_90d). Runs ONLY if the >=50%
//       board-coverage gate passes; otherwise gate-REJECTED with no run.
// Exit 0 always (it reports; it never changes the model).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { parseSnapshot, passesScreen } = await import(join(repoRoot, 'lib', 'model.ts'));

function flagValue(argv, flag, fallback) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(`--${flag}=`)) return argv[i].slice(flag.length + 3);
  }
  return fallback;
}
const input = flagValue(process.argv.slice(2), 'input', '');
const featuresPath = flagValue(process.argv.slice(2), 'features', '');
const variant = flagValue(process.argv.slice(2), 'variant', '');
const VARIANTS = ['F1', 'F2', 'M1', 'M2', 'G1'];
if (!input || !featuresPath || !VARIANTS.includes(variant)) {
  console.error('usage: node tools/refit-v10.mjs --variant <F1|F2|M1|M2|G1> --input <snapshot.json> --features <features.json>');
  process.exit(1);
}

const { snapshot } = parseSnapshot(readFileSync(input, 'utf8'));
const FEAT = JSON.parse(readFileSync(featuresPath, 'utf8'));
const feat = (slug) => FEAT.features[slug] ?? {};

// --- shared helpers (same formulas as lib/model.ts / refit-v9.mjs) ---
const FAMILY_OF = {
  'Risk Curators': 'Yield & management', 'Onchain Capital Allocator': 'Yield & management',
  Yield: 'Yield & management', 'Yield Aggregator': 'Yield & management', 'Basis Trading': 'Yield & management',
  Dexs: 'Trading', Derivatives: 'Trading', Options: 'Trading',
  Lending: 'Lending', CDP: 'Lending', 'Leveraged Farming': 'Lending',
  'Liquid Staking': 'Staking', 'Liquid Restaking': 'Staking', Restaking: 'Staking', 'Staking Pool': 'Staking',
  Bridge: 'Bridging', 'Canonical Bridge': 'Bridging', 'Cross Chain Bridge': 'Bridging',
  CEX: 'Exchanges', RWA: 'Real-world assets',
};
const familyOf = (c) => (c === null ? 'Other' : (FAMILY_OF[c] ?? 'Other'));
const median = (vs) => {
  if (vs.length === 0) return 0;
  const s = [...vs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (vs) => vs.reduce((a, b) => a + b, 0) / vs.length;
function foldOf(slug) {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0;
  return Math.abs(h) % 5;
}
const peers = snapshot.protocols.filter((p) => {
  if (p.mcap_usd === null || !Number.isFinite(p.tvl_usd) || p.tvl_usd <= 0) return false;
  const m = p.mcap_usd / p.tvl_usd;
  return Number.isFinite(m) && m >= 0.001 && m <= 10;
});
const ageDaysOf = (p) => {
  if (p.listed_at === null) return null;
  const s = Date.parse(`${p.listed_at}T00:00:00Z`);
  const e = Date.parse(`${snapshot.as_of}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return Math.max(0, Math.round((e - s) / 86_400_000));
};

// Feature triple, extended with the v10 signals. Same fallbacks as
// lib/model.ts: null age -> 365 days, null change -> 0, change clipped.
// New features are raw values from features.json (null = not measured);
// the fitter imputes the TRAINING median for nulls (see makeFitterDesign).
const featOf = (p) => {
  const g = p.change_7d === null ? 0 : Math.max(-50, Math.min(50, p.change_7d)) / 100;
  const f = feat(p.slug);
  return {
    x: Math.log(p.tvl_usd),
    a: Math.log((ageDaysOf(p) ?? 365) + 30),
    g,
    lf: f.log_fees_t30d ?? null,       // F1: log trailing-30d fees (USD)
    lg: f.log_fees_growth ?? null,     // F2: log(fees_T30d / fees_prior30d)
    m30: f.mom30 ?? null,              // M1: slope log TVL, 30d
    m90: f.mom90 ?? null,              // M2: slope log TVL, 90d
    gh: f.log_commits_90d ?? null,     // G1: log1p(commits 90d) — null unless gate passed
  };
};
const extraOf = (p) => ({ ageDays: ageDaysOf(p), change7d: p.change_7d, slug: p.slug });

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

function fitOLS(train) {
  const xs = train.map((p) => Math.log(p.tvl_usd));
  const ys = train.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

function familyAdjustments(train, predictLogMult) {
  const resByFam = new Map();
  for (const p of train) {
    const r = Math.log(p.mcap_usd / p.tvl_usd) - predictLogMult(featOf(p));
    const f = familyOf(p.category);
    if (!resByFam.has(f)) resByFam.set(f, []);
    resByFam.get(f).push(r);
  }
  const fams = new Map();
  for (const [f, list] of resByFam) {
    const raw = list.length >= 3 ? median(list) : 0;
    fams.set(f, raw * (list.length / (list.length + 2)));
  }
  return fams;
}

// Design builders: one extra column on top of [1, log TVL]. The extra column
// is taken from the feature triple; nulls are imputed with the TRAINING-set
// median of the observed values (computed inside the fit — no leakage).
const EXTRA_KEY = { F1: 'lf', F2: 'lg', M1: 'm30', M2: 'm90', G1: 'gh' };
function makeFitterDesign(variantId) {
  const key = EXTRA_KEY[variantId];
  return (train) => {
    const observed = train.map((p) => featOf(p)[key]).filter((v) => v !== null && Number.isFinite(v));
    const imp = observed.length ? median(observed) : 0;
    const rows = train.map((p) => {
      const t = featOf(p);
      const v = t[key] === null || !Number.isFinite(t[key]) ? imp : t[key];
      return [1, t.x, v];
    });
    const y = train.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
    const k = 3;
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
    const Xty = new Array(k).fill(0);
    for (let i = 0; i < rows.length; i++) {
      for (let a = 0; a < k; a++) {
        Xty[a] += rows[i][a] * y[i];
        for (let b = 0; b < k; b++) XtX[a][b] += rows[i][a] * rows[i][b];
      }
    }
    let beta = solveLinear(XtX, Xty);
    let predictLogMult;
    if (beta === null) {
      const curve = fitOLS(train);
      predictLogMult = (t) => curve.intercept + curve.slope * t.x;
      beta = null;
    } else {
      predictLogMult = (t) => {
        const v = t[key] === null || !Number.isFinite(t[key]) ? imp : t[key];
        return beta[0] + beta[1] * t.x + beta[2] * v;
      };
    }
    const fams = familyAdjustments(train, predictLogMult);
    return (tvl, category, extra) => {
      if (!Number.isFinite(tvl) || tvl <= 0) return 1;
      // Rebuild a pseudo-proto so featOf can read the slug's features.
      const pseudo = { slug: extra?.slug ?? '', tvl_usd: tvl, category, change_7d: extra?.change7d ?? null, listed_at: null };
      // ageDays is irrelevant for these designs (no age column); keep null.
      const t = featOf(pseudo);
      const base = Math.exp(predictLogMult(t));
      const adj = fams.get(familyOf(category)) ?? 0;
      return Math.min(2.0, Math.max(0.005, base * Math.exp(adj)));
    };
  };
}

// V0 frozen fitter (sanity check — must reproduce the frozen table exactly).
function makeFitterV0() {
  return (train) => {
    const curve = fitOLS(train);
    const fams = familyAdjustments(train, (t) => curve.intercept + curve.slope * t.x);
    return (tvl, category) => {
      if (!Number.isFinite(tvl) || tvl <= 0) return 1;
      const base = Math.exp(curve.intercept + curve.slope * Math.log(tvl));
      const adj = fams.get(familyOf(category)) ?? 0;
      return Math.min(2.0, Math.max(0.005, base * Math.exp(adj)));
    };
  };
}

function fitterFor(id) {
  if (id === 'V0') return makeFitterV0();
  return makeFitterDesign(id);
}

// --- validators (identical metric + identical held-out splits as refit-v9) ---
function summarize(errors) {
  const s = [...errors].sort((a, b) => a - b);
  if (s.length === 0) return { median: 1, p70: 1 };
  return { median: Math.exp(s[Math.floor(s.length / 2)]), p70: Math.exp(s[Math.floor(s.length * 0.7)]) };
}
function errOf(fitFn, p) {
  return Math.abs(Math.log((p.tvl_usd * fitFn(p.tvl_usd, p.category, extraOf(p))) / p.mcap_usd));
}
function oos(fit) {
  const errors = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = peers.filter((p) => foldOf(p.slug) !== fold);
    const test = peers.filter((p) => foldOf(p.slug) === fold);
    if (!train.length || !test.length) continue;
    const f = fit(train);
    for (const p of test) errors.push(errOf(f, p));
  }
  return summarize(errors);
}
function walkForward(fit) {
  const dated = peers.filter((p) => p.listed_at !== null).sort((a, b) => {
    const d = a.listed_at.localeCompare(b.listed_at);
    return d !== 0 ? d : a.slug < b.slug ? -1 : 1;
  });
  if (dated.length < 12) return { median: 1, p70: 1, peers: dated.length, windows: 0 };
  const quarters = [[], [], [], []];
  dated.forEach((p, i) => quarters[Math.min(3, Math.floor((i * 4) / dated.length))].push(p));
  const errors = [];
  let windows = 0;
  for (let k = 0; k < 3; k++) {
    const test = quarters[k + 1];
    if (!test.length) continue;
    const first = test[0].listed_at;
    const train = quarters.slice(0, k + 1).flat().filter((p) => p.listed_at < first);
    if (train.length < 3) continue;
    const f = fit(train);
    for (const p of test) errors.push(errOf(f, p));
    windows++;
  }
  return { ...summarize(errors), peers: dated.length, windows };
}
function loo(fit) {
  const errors = [];
  for (let i = 0; i < peers.length; i++) {
    const train = peers.filter((_, j) => j !== i);
    const f = fit(train);
    errors.push(errOf(f, peers[i]));
  }
  return summarize(errors);
}
function cpcv(fit) {
  const dated = peers.filter((p) => p.listed_at !== null).sort((a, b) => {
    const d = a.listed_at.localeCompare(b.listed_at);
    return d !== 0 ? d : a.slug < b.slug ? -1 : 1;
  });
  if (dated.length < 12) return { median: 1, p70: 1, peers: dated.length, paths: 0 };
  const groups = [[], [], [], []];
  dated.forEach((p, i) => groups[Math.min(3, Math.floor((i * 4) / dated.length))].push(p));
  const errors = [];
  let paths = 0;
  for (let k = 0; k < 4; k++) {
    const test = groups[k];
    if (!test.length) continue;
    const testDates = new Set(test.map((p) => p.listed_at));
    const train = groups.flatMap((g, j) => (j === k ? [] : g)).filter((p) => !testDates.has(p.listed_at));
    if (train.length < 3) continue;
    const f = fit(train);
    for (const p of test) errors.push(errOf(f, p));
    paths++;
  }
  return { ...summarize(errors), peers: dated.length, paths };
}
function overlapTop10(fit) {
  const cands = snapshot.protocols.filter((p) => passesScreen(p) && Number.isFinite(p.tvl_usd) && p.tvl_usd > 0);
  const f = fit(peers);
  const scored = cands.map((p) => ({ slug: p.slug, implied: Math.max(1, Math.round(p.tvl_usd * f(p.tvl_usd, p.category, extraOf(p)))), tvl: p.tvl_usd }));
  scored.sort((a, b) => b.implied - a.implied || b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1));
  const modelTop = scored.slice(0, 10).map((r) => r.slug);
  const tvlTop = [...cands].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1)).slice(0, 10).map((p) => p.slug);
  let overlap = 0;
  for (const s of modelTop) if (tvlTop.includes(s)) overlap++;
  return { overlap, modelTop, tvlTop };
}

const labels = {
  V0: 'baseline (frozen: OLS + median fam n/(n+2) + clamp [0.005,2])',
  F1: 'NEW fees level + d*log(fees_T30d) — DIAGNOSTIC unless coverage gate >=80% passes',
  F2: 'NEW fees growth + d*log(fees_T30d/fees_prior30d) — DIAGNOSTIC unless coverage gate >=80% passes',
  M1: 'NEW TVL momentum 30d + d*mom30',
  M2: 'NEW TVL momentum 90d + d*mom90',
  G1: 'NEW GitHub activity + d*log1p(commits_90d) — runs ONLY if board-coverage gate >=50% passes',
};

console.log(`refit-v10 run: variant ${variant}, ${peers.length} traded peers, ${snapshot.protocols.length} protocols, as_of ${snapshot.as_of}, features ${featuresPath}`);
console.log(`gates (from features.json): fees peers coverage ${FEAT.coverage?.fees_peers_144 ?? '?'} /144, fees peers119 ${FEAT.coverage?.fees_peers_119 ?? '?'} /119, tvl-history peers ${FEAT.coverage?.tvl_peers_119 ?? '?'} /119, github board ${FEAT.coverage?.github_board ?? '?'} /${FEAT.coverage?.board_n ?? '?'}`);
function runOne(id) {
  const fit = fitterFor(id);
  const o = oos(fit);
  const w = walkForward(fit);
  const l = loo(fit);
  const c = cpcv(fit);
  const ov = overlapTop10(fit);
  console.log(
    `${id} ${labels[id]}\n` +
    `    OOS 5-fold  median x${o.median.toFixed(4)}  p70 x${o.p70.toFixed(4)}\n` +
    `    walk-fwd    median x${w.median.toFixed(4)}  p70 x${w.p70.toFixed(4)}  (${w.peers} peers, ${w.windows} windows)\n` +
    `    LOO         median x${l.median.toFixed(4)}  p70 x${l.p70.toFixed(4)}\n` +
    `    CPCV        median x${c.median.toFixed(4)}  p70 x${c.p70.toFixed(4)}  (${c.peers} peers, ${c.paths} paths)\n` +
    `    TVL top-10 overlap ${ov.overlap}/10\n` +
    `    model top-10: ${ov.modelTop.join(', ')}`,
  );
  return { id, o, w, l, c, ov };
}

const base = runOne('V0');
const sanity =
  Math.abs(base.o.median - 2.9828) < 0.0005 &&
  Math.abs(base.w.median - 2.9211) < 0.0005 &&
  Math.abs(base.l.median - 2.8955) < 0.0005 &&
  Math.abs(base.c.median - 2.8664) < 0.0005 &&
  base.ov.overlap === 9;
console.log(`SANITY V0 reproduces frozen table: ${sanity ? 'PASS' : 'FAIL — RUN INVALID, conclude nothing'}`);
if (!sanity) process.exit(0);

// Gate evaluation (pre-registered §3) — computed from features.json, before verdict.
const gates = {
  F1: (FEAT.coverage?.fees_peers_144 ?? 0) >= 115,
  F2: (FEAT.coverage?.fees_peers_144 ?? 0) >= 115,
  M1: (FEAT.coverage?.tvl_peers_119 ?? 0) >= Math.ceil(119 * 0.8),
  M2: (FEAT.coverage?.tvl_peers_119 ?? 0) >= Math.ceil(119 * 0.8),
  G1: (FEAT.coverage?.github_board ?? 0) >= Math.ceil((FEAT.coverage?.board_n ?? 0) * 0.5),
};
console.log(`GATE ${variant}: ${gates[variant] ? 'PASS' : 'FAIL'}`);
if (variant === 'G1' && !gates.G1) {
  console.log('G1 verdict: GATE-REJECT — board GitHub coverage < 50%; NO RUN performed (no GitHub API calls made).');
  console.log(`frozen top-10 (TVL): ${base.ov.tvlTop.join(', ')}`);
  process.exit(0);
}

const t = runOne(variant);
const oosBetter2 = t.o.median < base.o.median * 0.98;
const allBetter = t.o.median < base.o.median && t.w.median < base.w.median && t.l.median < base.l.median;
const overlapDown = t.ov.overlap < base.ov.overlap;
const cpcvBetter = t.c.median < base.c.median;
const mainGates = oosBetter2 && allBetter && overlapDown && cpcvBetter;
const diagnosticOnly = (variant === 'F1' || variant === 'F2') && !gates[variant];
if (diagnosticOnly) {
  console.log(
    `${variant} verdict: DIAGNOSTIC ONLY — coverage gate FAILED (fees peers ${FEAT.coverage?.fees_peers_144}/144 < 115), so this run CANNOT adopt whatever the numbers say. ` +
    `Main gates would be: OOS>=2% ${oosBetter2 ? 'yes' : 'no'}, all-three ${allBetter ? 'yes' : 'no'}, overlap<9 ${overlapDown ? 'yes' : 'no'}, CPCV<2.8664 ${cpcvBetter ? 'yes' : 'no'} -> REJECT (gate)`,
  );
} else {
  console.log(
    `${variant} verdict: main gates ${mainGates ? 'PASS' : 'FAIL'} (OOS>=2% ${oosBetter2 ? 'yes' : 'no'}, all-three ${allBetter ? 'yes' : 'no'}, overlap<9 ${overlapDown ? 'yes' : 'no'}, CPCV ${cpcvBetter ? 'better' : 'worse/equal'})` +
    ` -> ${mainGates ? 'PROVISIONAL PASS — permutation p<0.05 + plateau ±20% + optimism audit REQUIRED before ADOPT (see header §3)' : 'REJECT'}`,
  );
}
console.log(`frozen top-10 (TVL): ${base.ov.tvlTop.join(', ')}`);
