// tools/refit-investigation.mjs — v6 investigation: can a re-fit of the SAME
// features (log TVL size curve + family adjustment) beat the frozen model?
//
// The frozen model ("radar-3-size-family", v4/v5) is: OLS log(multiple) on
// log(TVL), family median residual shrunk by n/(n+2), multiple clamped to
// [0.005, 2.00]. It scores OOS 5-fold x2.9828 and walk-forward x2.9211 on the
// kit snapshot, with 9/10 overlap between the model top-10 and a pure-TVL
// top-10 — the overlap the v5 jury flagged (dimension A).
//
// This script re-implements the three held-out validators EXACTLY (same fold
// assignment by slug hash, same walk-forward quarters, same error metric) and
// adds leave-one-out (LOO) on the 119 traded peers. It first proves the
// re-implementation by reproducing the frozen numbers, then tries re-fit
// variants that use the SAME features — no new predictors, no new data:
//   V0 baseline (must reproduce frozen numbers exactly)
//   V1 family shrinkage n/(n+1)      V2 shrinkage n/(n+5)
//   V3 no shrinkage                  V4 no family adjustment at all
//   V5 family mean residual (shrunk n/(n+2))
//   V6 Theil-Sen robust slope + median intercept
//   V7 OLS with 2 rounds of MAD-trimming (|resid| > 2.5 * MAD dropped)
//   V8 clamp [0.01, 1.50]            V9 no clamp
//   V10 family threshold n>=2 (median from 2 peers instead of 3)
//
// Adoption rule (decided BEFORE seeing results, per the forward-test
// protocol skill): a variant is adopted ONLY if it beats the frozen model on
// ALL THREE held-out metrics (OOS median, walk-forward median, LOO median),
// with OOS improving by >= 2% relative, AND the TVL top-10 overlap strictly
// drops. Anything else — including a win on one metric only, or a win within
// noise — keeps the model frozen. 10 variants tried is disclosed, not hidden:
// picking the best of 10 on the same held-out data is itself a selection
// effect, which is why the bar is "beats on all three + overlap" and not
// "beats on one".
//
// v7 — NEW-FEATURE variants (W1-W6), pre-registered here BEFORE the run:
// the v6 jury asked for a new feature as the only way past the 9/10 overlap,
// and the v6 log records age / 7-day change as the candidates (both correlate
// ~0.00 as single predictors — tested here as interactions, plus a quadratic
// size term). Feature definitions, written before seeing any result:
//   W1 quadratic size: log(mult) = a + b*x + c*(x-mx)^2, x = log(TVL)
//   W2 age main effect: + d*log(ageDays+30)
//   W3 age x size interaction: + d*(x-mx)*(log(ageDays+30)-ma)
//   W4 7-day change main effect: + d*clip(change_7d,-50,50)/100
//   W5 change x size interaction: + d*(x-mx)*clip(change_7d,-50,50)/100
//   W6 quadratic + change x size: c*(x-mx)^2 + d*(x-mx)*clip(change)/100
// Centring (mx, ma) is the training mean, recomputed inside every fold /
// window / LOO training set — never from the test set. Missing-data fallbacks
// are the SAME ones lib/model.ts already uses for its correlations (null age
// -> 365 days, null change -> 0, change clipped to +/-50%). Family
// adjustment, shrinkage n/(n+2) and clamp [0.005, 2.00] are unchanged.
// The SAME adoption rule above applies to W1-W6, and the trial count is now
// 16 (10 V + 6 W) — disclosed, not hidden. Walk-forward caveat: age/change
// are snapshot-at-as_of values (the same point-in-time definition the board
// uses); the walk-forward split still trains only on earlier-listed peers
// with the same-day purge, and no feature uses the label (market cap).
// A W-variant that passes still needs a separate deliberate edit to adopt:
// this script never changes the model.
//
// Usage: node tools/refit-investigation.mjs --input <snapshot.json>
// Exit 0 always (it reports; it never changes the model — adoption is a
// separate, deliberate edit if the rule is met).
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
if (!input) { console.error('usage: node tools/refit-investigation.mjs --input <snapshot.json>'); process.exit(1); }

const { snapshot } = parseSnapshot(readFileSync(input, 'utf8'));

// --- shared helpers (same formulas as lib/model.ts) ---
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

// --- v7 new-feature triples (x = log TVL, a = log age, g = clipped 7d change) ---
// featOfProto builds the triple from a snapshot protocol; featOf builds it
// from a candidate's (tvl, ageDays, change7d). Both use the lib/model.ts
// fallbacks (null age -> 365 days, null change -> 0).
const featOf = (tvl, ageDays, change7d) => ({
  x: Math.log(tvl),
  a: Math.log((ageDays ?? 365) + 30),
  g: change7d === null ? 0 : Math.max(-50, Math.min(50, change7d)) / 100,
});
const featOfProto = (p) => featOf(p.tvl_usd, ageDaysOf(p), p.change_7d);
const extraOf = (p) => ({ ageDays: ageDaysOf(p), change7d: p.change_7d });

// Small dense OLS solver: normal equations + Gaussian elimination with
// partial pivoting. Only used by the W-variants (<= 4 parameters, 119 peers).
// Returns null when the system is (near-)singular — the caller then falls
// back to the frozen 2-parameter fit instead of emitting NaN.
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

// Design-matrix OLS on the new-feature triples. buildFeatures(train) returns
// vec(triple) including the intercept; centring stats come from train only.
function fitDesignOLS(train, buildFeatures) {
  const vec = buildFeatures(train);
  const rows = train.map((p) => vec(featOfProto(p)));
  const y = train.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
  const k = rows[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += rows[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += rows[i][a] * rows[i][b];
    }
  }
  const beta = solveLinear(XtX, Xty);
  if (beta === null) return null;
  return (triple) => {
    const v = vec(triple);
    let s = 0;
    for (let i = 0; i < k; i++) s += beta[i] * v[i];
    return s;
  };
}

const W_BUILDERS = {
  W1: (train) => {
    const mx = mean(train.map((p) => featOfProto(p).x));
    return (t) => [1, t.x, (t.x - mx) ** 2];
  },
  W2: () => (t) => [1, t.x, t.a],
  W3: (train) => {
    const mx = mean(train.map((p) => featOfProto(p).x));
    const ma = mean(train.map((p) => featOfProto(p).a));
    return (t) => [1, t.x, (t.x - mx) * (t.a - ma)];
  },
  W4: () => (t) => [1, t.x, t.g],
  W5: (train) => {
    const mx = mean(train.map((p) => featOfProto(p).x));
    return (t) => [1, t.x, (t.x - mx) * t.g];
  },
  W6: (train) => {
    const mx = mean(train.map((p) => featOfProto(p).x));
    return (t) => [1, t.x, (t.x - mx) ** 2, (t.x - mx) * t.g];
  },
};

function makeFitterW(variant) {
  return (train) => {
    let logMult = fitDesignOLS(train, W_BUILDERS[variant]);
    if (logMult === null) {
      // Singular design: fall back to the frozen 2-parameter fit.
      const curve = fitOLS(train);
      logMult = (t) => curve.intercept + curve.slope * t.x;
    }
    const resByFam = new Map();
    for (const p of train) {
      const r = Math.log(p.mcap_usd / p.tvl_usd) - logMult(featOfProto(p));
      const f = familyOf(p.category);
      if (!resByFam.has(f)) resByFam.set(f, []);
      resByFam.get(f).push(r);
    }
    const fams = new Map();
    for (const [f, list] of resByFam) {
      const raw = list.length >= 3 ? median(list) : 0;
      fams.set(f, raw * (list.length / (list.length + 2)));
    }
    return (tvl, category, extra) => {
      if (!Number.isFinite(tvl) || tvl <= 0) return 1;
      const triple = featOf(tvl, extra?.ageDays ?? null, extra?.change7d ?? null);
      const base = Math.exp(logMult(triple));
      const adj = fams.get(familyOf(category)) ?? 0;
      return Math.min(2.0, Math.max(0.005, base * Math.exp(adj)));
    };
  };
}

// --- variant definition: fit(peers) -> { multiple(tvl, category) } ---
function fitOLS(train, opts) {
  const xs = train.map((p) => Math.log(p.tvl_usd));
  const ys = train.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}
function fitTheilSen(train) {
  const pts = train.map((p) => [Math.log(p.tvl_usd), Math.log(p.mcap_usd / p.tvl_usd)]);
  const slopes = [];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j][0] - pts[i][0];
      if (dx !== 0) slopes.push((pts[j][1] - pts[i][1]) / dx);
    }
  const slope = median(slopes);
  const intercept = median(pts.map(([x, y]) => y - slope * x));
  return { intercept, slope };
}
function fitTrimmed(train) {
  let keep = train;
  for (let round = 0; round < 2; round++) {
    const curve = fitOLS(keep);
    const res = keep.map((p) => Math.log(p.mcap_usd / p.tvl_usd) - (curve.intercept + curve.slope * Math.log(p.tvl_usd)));
    const med = median(res);
    const mad = median(res.map((r) => Math.abs(r - med))) || 1e-9;
    const next = keep.filter((_, i) => Math.abs(res[i] - med) <= 2.5 * 1.4826 * mad);
    if (next.length < 10 || next.length === keep.length) { keep = next.length >= 10 ? next : keep; break; }
    keep = next;
  }
  return fitOLS(keep);
}

function makeFitter(variant) {
  return (train) => {
    let curve;
    if (variant === 'V6') curve = fitTheilSen(train);
    else if (variant === 'V7') curve = fitTrimmed(train);
    else curve = fitOLS(train);
    // family adjustments
    const resByFam = new Map();
    for (const p of train) {
      const r = Math.log(p.mcap_usd / p.tvl_usd) - (curve.intercept + curve.slope * Math.log(p.tvl_usd));
      const f = familyOf(p.category);
      if (!resByFam.has(f)) resByFam.set(f, []);
      resByFam.get(f).push(r);
    }
    const fams = new Map();
    for (const [f, list] of resByFam) {
      let raw = 0;
      const minN = variant === 'V10' ? 2 : 3;
      if (variant === 'V5') raw = list.length >= minN ? mean(list) : 0;
      else raw = list.length >= minN ? median(list) : 0;
      let shrink = list.length / (list.length + 2);
      if (variant === 'V1') shrink = list.length / (list.length + 1);
      if (variant === 'V2') shrink = list.length / (list.length + 5);
      if (variant === 'V3') shrink = 1;
      if (variant === 'V4') shrink = 0;
      fams.set(f, raw * shrink);
    }
    const [lo, hi] = variant === 'V8' ? [0.01, 1.5] : variant === 'V9' ? [0.0001, 100] : [0.005, 2.0];
    return (tvl, category) => {
      if (!Number.isFinite(tvl) || tvl <= 0) return 1;
      const base = Math.exp(curve.intercept + curve.slope * Math.log(tvl));
      const adj = fams.get(familyOf(category)) ?? 0;
      return Math.min(hi, Math.max(lo, base * Math.exp(adj)));
    };
  };
}

// --- validators (identical metric + identical held-out splits as model.ts) ---
function summarize(errors) {
  const s = [...errors].sort((a, b) => a - b);
  if (s.length === 0) return { median: 1, p70: 1 };
  return { median: Math.exp(s[Math.floor(s.length / 2)]), p70: Math.exp(s[Math.floor(s.length * 0.7)]) };
}
function oos(fit) {
  const errors = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = peers.filter((p) => foldOf(p.slug) !== fold);
    const test = peers.filter((p) => foldOf(p.slug) === fold);
    if (!train.length || !test.length) continue;
    const f = fit(train);
    for (const p of test) errors.push(Math.abs(Math.log((p.tvl_usd * f(p.tvl_usd, p.category, extraOf(p))) / p.mcap_usd)));
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
    for (const p of test) errors.push(Math.abs(Math.log((p.tvl_usd * f(p.tvl_usd, p.category, extraOf(p))) / p.mcap_usd)));
    windows++;
  }
  return { ...summarize(errors), peers: dated.length, windows };
}
function loo(fit) {
  const errors = [];
  for (let i = 0; i < peers.length; i++) {
    const train = peers.filter((_, j) => j !== i);
    const f = fit(train);
    const p = peers[i];
    errors.push(Math.abs(Math.log((p.tvl_usd * f(p.tvl_usd, p.category, extraOf(p))) / p.mcap_usd)));
  }
  return summarize(errors);
}
function overlapTop10(fit) {
  const cands = snapshot.protocols.filter((p) => passesScreen(p) && Number.isFinite(p.tvl_usd) && p.tvl_usd > 0);
  const f = fit(peers); // fitted on the traded peers, exactly like the board fit
  const scored = cands.map((p) => ({ slug: p.slug, implied: Math.max(1, Math.round(p.tvl_usd * f(p.tvl_usd, p.category, extraOf(p)))), tvl: p.tvl_usd }));
  scored.sort((a, b) => b.implied - a.implied || b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1));
  const modelTop = new Set(scored.slice(0, 10).map((r) => r.slug));
  const tvlTop = new Set([...cands].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1)).slice(0, 10).map((p) => p.slug));
  let overlap = 0;
  for (const s of modelTop) if (tvlTop.has(s)) overlap++;
  return { overlap, modelTop: [...modelTop], tvlTop: [...tvlTop] };
}

const variants = ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6'];
const labels = {
  V0: 'baseline (frozen: OLS + median fam n/(n+2) + clamp [0.005,2])',
  V1: 'shrinkage n/(n+1)', V2: 'shrinkage n/(n+5)', V3: 'no shrinkage',
  V4: 'no family adjustment', V5: 'family MEAN residual (shrunk)',
  V6: 'Theil-Sen robust slope', V7: 'OLS + MAD-trim (2 rounds)',
  V8: 'clamp [0.01,1.50]', V9: 'no clamp', V10: 'family threshold n>=2',
  W1: 'NEW FEATURE quadratic size term (x-mx)^2',
  W2: 'NEW FEATURE age main effect log(age+30)',
  W3: 'NEW FEATURE age x size interaction',
  W4: 'NEW FEATURE 7d-change main effect',
  W5: 'NEW FEATURE change x size interaction',
  W6: 'NEW FEATURES quadratic + change x size',
};
console.log(`refit investigation: ${peers.length} traded peers, ${snapshot.protocols.length} protocols, as_of ${snapshot.as_of}`);
const table = [];
for (const v of variants) {
  const fit = v.startsWith('W') ? makeFitterW(v) : makeFitter(v);
  const o = oos(fit);
  const w = walkForward(fit);
  const l = loo(fit);
  const ov = overlapTop10(fit);
  table.push({ v, o, w, l, ov });
  console.log(
    `${v} ${labels[v]}\n` +
    `    OOS 5-fold  median x${o.median.toFixed(4)}  p70 x${o.p70.toFixed(4)}\n` +
    `    walk-fwd    median x${w.median.toFixed(4)}  p70 x${w.p70.toFixed(4)}  (${w.peers} peers, ${w.windows} windows)\n` +
    `    LOO         median x${l.median.toFixed(4)}  p70 x${l.p70.toFixed(4)}\n` +
    `    TVL top-10 overlap ${ov.overlap}/10`,
  );
}
const base = table[0];
// Adoption rule: beats frozen on ALL THREE held-out medians, OOS >= 2% better,
// AND overlap strictly lower.
console.log('\nAdoption rule: OOS median AND walk-forward median AND LOO median all lower than frozen, OOS >= 2% better, overlap < 9/10. (16 variants tried in total: 10 V + 6 W.)');
let adopted = null;
for (const t of table.slice(1)) {
  const oosBetter = t.o.median < base.o.median * 0.98;
  const allBetter = t.o.median < base.o.median && t.w.median < base.w.median && t.l.median < base.l.median;
  const overlapDown = t.ov.overlap < base.ov.overlap;
  const pass = oosBetter && allBetter && overlapDown;
  console.log(`${t.v}: OOS ${t.o.median < base.o.median ? 'better' : 'worse/equal'}, WF ${t.w.median < base.w.median ? 'better' : 'worse/equal'}, LOO ${t.l.median < base.l.median ? 'better' : 'worse/equal'}, overlap ${t.ov.overlap} vs ${base.ov.overlap} -> ${pass ? 'ADOPT' : 'reject'}`);
  if (pass && adopted === null) adopted = t.v;
}
console.log(adopted === null
  ? '\nVERDICT: no variant meets the adoption rule — model stays FROZEN (v4/v5 fit).'
  : `\nVERDICT: ${adopted} meets the rule — re-fit may be adopted (separate deliberate edit + full re-validation required).`);
