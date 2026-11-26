// tools/refit-v9.mjs — v9 model investigation: can a NEW feature break the
// 9/10 top-10 overlap with a pure-TVL sort? (Node 22, standard library only.)
//
// Frozen model ("radar-3-size-family", v4/v5/v6/v7/v8): OLS log(multiple) on
// log(TVL) + family median residual shrunk n/(n+2), clamp [0.005, 2.0].
// Frozen numbers on the kit snapshot (119 traded peers): OOS 5-fold x2.9828,
// walk-forward x2.9211 (89 dated peers, 3 windows), LOO x2.8955, overlap 9/10.
// 16 variants already tried and ALL rejected (VALIDATION.md §9.4 V0–V10, §10.2
// W1–W6). This script tries the next hypotheses, ONE per invocation, and never
// changes the model — adoption is a separate, deliberate edit if the rule is met.
//
// ============================================================================
// PRE-REGISTRATION (written BEFORE any run — the adoption rules below are
// fixed now and MUST NOT be changed after seeing results; when in doubt,
// reject the variant).
// ----------------------------------------------------------------------------
// (a) R1 — W1 quadratic size term, RE-TEST + CPCV diagnostic.
//     W1 (log(mult) = a + b*x + c*(x-mx)^2) was the closest variant in v7:
//     OOS x2.9080 (-2.5%), WF x2.8025, LOO x2.9487, overlap 9/10.
//     HONEST NOTE, recorded here before the run: W1 ALREADY FAILED LOO in v7
//     (x2.9487 vs frozen x2.8955, +1.8% worse), so under the old rule it
//     CANNOT be adopted no matter what CPCV says. CPCV here is a DIAGNOSTIC
//     only: did W1's OOS/WF wins come from selection noise across 16 trials?
//     The full adoption rule for R1 is therefore the OLD rule (beats frozen
//     on ALL THREE held-out medians, OOS >= 2% better, overlap < 9/10) PLUS
//     a second gate: median CPCV error < frozen median CPCV error. Since the
//     old rule already fails on LOO, R1's expected verdict is REJECT — CPCV
//     only decides whether W1 dies with one confirmation (LOO) or two
//     (LOO + CPCV). If CPCV also loses, W1 is dead with two independent
//     confirmations and is never re-tried.
//     CPCV definition (fixed here, before the run): the 89 dated peers are
//     split into 4 chronological groups by listed_at (same quartering as the
//     walk-forward); 4 paths, each training on 3 groups and testing the
//     remaining group; same-day purge — any training peer whose listed_at
//     equals ANY listed_at present in the test group is dropped (the
//     boundary-day leak the walk-forward purge guards against, applied in
//     both directions, since CPCV trains on past AND future groups). Median
//     CPCV = median |log(pred/actual)| over ALL errors of the four paths,
//     exponentiated exactly like the other three metrics. Undated peers are
//     excluded from CPCV, exactly as in walk-forward.
// (b) N1–N5 — NEW features. Adoption rule = the OLD rule, unchanged: beats
//     frozen on ALL THREE held-out medians (OOS 5-fold + walk-forward +
//     LOO), OOS >= 2% better, AND overlap top-10 strictly < 9/10. Trial
//     count is disclosed, not hidden: 16 previous (10 V + 6 W) + the new
//     ones tried here (up to 5), so 21 in total if all five run. Picking the
//     best of 21 on the same held-out data is itself a selection effect,
//     which is why the bar stays "beats on all three + overlap", not
//     "beats on one". CPCV is computed and reported for N1–N5 as a
//     DIAGNOSTIC ONLY — it is NOT part of their adoption rule (the rule was
//     fixed before the run; adding a gate after seeing results would be
//     moving the goalposts either way).
// (c) If NOTHING passes its rule: the model STAYS FROZEN, v9 is NOT
//     submitted on model grounds, and the report records the full failure
//     table plus a draft §10.3 for VALIDATION.md.
// ============================================================================
//
// Hypotheses, one per run (invocation: node tools/refit-v9.mjs --variant <id>
// --input <snapshot.json>). Each run also re-fits V0 as a sanity check — the
// V0 numbers MUST reproduce the frozen table (OOS x2.9828 / WF x2.9211 /
// LOO x2.8955 / overlap 9/10) or the run is invalid and nothing is concluded.
//   R1  W1 quadratic size term, re-test + CPCV (reproduction of §10.2 first)
//   N1  chain-count main effect: + d*log1p(n_chains). Hypothesis: multichain
//       = wider distribution -> higher multiple. chains = Proto.chains.
//   N2  chain-count x size interaction: + d*(x-mx)*log1p(n_chains).
//   N3  category-level adjustment: median residual PER CATEGORY (not family),
//       shrunk n/(n+2), threshold n>=3, FALLBACK to the family adjustment
//       (frozen definition: family median residual shrunk n/(n+2), n>=3
//       else 0) when the category is thin or absent.
//   N4  family-specific size slope: OLS slope per family, shrunk to the
//       global slope with n/(n+5); intercept per family stays the median
//       residual (vs the family-slope curve) shrunk n/(n+2), threshold n>=3.
//   N5  |change_7d| main effect (volatility): + d*|clip(change_7d,-50,50)|/100.
//       Only if N1–N4 all fail.
// Shared with the W-variants: null age -> 365 days, null change -> 0, change
// clipped to +/-50%, centring from the TRAINING set only, family adjustment
// + clamp [0.005, 2.0] unchanged, overlap top-10 fitted on ALL peers exactly
// like the old overlapTop10.
//
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
const variant = flagValue(process.argv.slice(2), 'variant', '');
const VARIANTS = ['R1', 'N1', 'N2', 'N3', 'N4', 'N5'];
if (!input || !VARIANTS.includes(variant)) {
  console.error('usage: node tools/refit-v9.mjs --variant <R1|N1|N2|N3|N4|N5> --input <snapshot.json>');
  process.exit(1);
}

const { snapshot } = parseSnapshot(readFileSync(input, 'utf8'));

// --- shared helpers (same formulas as lib/model.ts / refit-investigation.mjs) ---
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

// Feature triple, extended with chain count (c) and |change| (v).
// Same fallbacks as lib/model.ts: null age -> 365 days, null change -> 0,
// change clipped to +/-50%. nChains is never null (parseSnapshot coerces to []).
const featOf = (tvl, ageDays, change7d, nChains) => {
  const g = change7d === null ? 0 : Math.max(-50, Math.min(50, change7d)) / 100;
  return {
    x: Math.log(tvl),
    a: Math.log((ageDays ?? 365) + 30),
    g,
    c: Math.log1p(nChains ?? 0),
    v: Math.abs(g),
  };
};
const featOfProto = (p) => featOf(p.tvl_usd, ageDaysOf(p), p.change_7d, (p.chains ?? []).length);
const extraOf = (p) => ({ ageDays: ageDaysOf(p), change7d: p.change_7d, nChains: (p.chains ?? []).length });

// Small dense OLS solver: normal equations + Gaussian elimination with partial
// pivoting. Returns null when (near-)singular; caller falls back to frozen fit.
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

function fitOLS(train) {
  const xs = train.map((p) => Math.log(p.tvl_usd));
  const ys = train.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

// Frozen family adjustment (median residual shrunk n/(n+2), threshold n>=3),
// shared by the V0 fitter and as the N3 fallback.
function familyAdjustments(train, curve) {
  const resByFam = new Map();
  for (const p of train) {
    const r = Math.log(p.mcap_usd / p.tvl_usd) - (curve.intercept + curve.slope * Math.log(p.tvl_usd));
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

// Design-matrix builders: R1 = W1 re-test; N1/N2/N5 = new design features.
// Centring stats (mx) come from the training set only.
const DESIGN_BUILDERS = {
  R1: (train) => {
    const mx = mean(train.map((p) => featOfProto(p).x));
    return (t) => [1, t.x, (t.x - mx) ** 2];
  },
  N1: () => (t) => [1, t.x, t.c],
  N2: (train) => {
    const mx = mean(train.map((p) => featOfProto(p).x));
    return (t) => [1, t.x, (t.x - mx) * t.c];
  },
  N5: () => (t) => [1, t.x, t.v],
};

function makeFitterDesign(variantId) {
  return (train) => {
    let logMult = fitDesignOLS(train, DESIGN_BUILDERS[variantId]);
    if (logMult === null) {
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
      const triple = featOf(tvl, extra?.ageDays ?? null, extra?.change7d ?? null, extra?.nChains ?? 0);
      const base = Math.exp(logMult(triple));
      const adj = fams.get(familyOf(category)) ?? 0;
      return Math.min(2.0, Math.max(0.005, base * Math.exp(adj)));
    };
  };
}

// N3: OLS size curve + CATEGORY median residual (shrunk n/(n+2), n>=3),
// falling back to the family adjustment when the category is thin/absent.
function makeFitterN3() {
  return (train) => {
    const curve = fitOLS(train);
    const fams = familyAdjustments(train, curve);
    const resByCat = new Map();
    for (const p of train) {
      const r = Math.log(p.mcap_usd / p.tvl_usd) - (curve.intercept + curve.slope * Math.log(p.tvl_usd));
      const cat = p.category ?? 'Other';
      if (!resByCat.has(cat)) resByCat.set(cat, []);
      resByCat.get(cat).push(r);
    }
    const cats = new Map();
    for (const [cat, list] of resByCat) {
      if (list.length >= 3) cats.set(cat, median(list) * (list.length / (list.length + 2)));
    }
    return (tvl, category) => {
      if (!Number.isFinite(tvl) || tvl <= 0) return 1;
      const base = Math.exp(curve.intercept + curve.slope * Math.log(tvl));
      const cat = category ?? 'Other';
      const adj = cats.has(cat) ? cats.get(cat) : (fams.get(familyOf(category)) ?? 0);
      return Math.min(2.0, Math.max(0.005, base * Math.exp(adj)));
    };
  };
}

// N4: family-specific size slope, shrunk to the global slope with n/(n+5);
// intercept per family = median residual vs the family-slope curve, shrunk
// n/(n+2), threshold n>=3 (same rule as the frozen family adjustment).
function makeFitterN4() {
  return (train) => {
    const curve = fitOLS(train);
    const byFam = new Map();
    for (const p of train) {
      const f = familyOf(p.category);
      if (!byFam.has(f)) byFam.set(f, []);
      byFam.get(f).push(p);
    }
    const slopes = new Map();
    for (const [f, list] of byFam) {
      let slopeF = curve.slope;
      if (list.length >= 2) {
        const xs = list.map((p) => Math.log(p.tvl_usd));
        const ys = list.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
        const mx = mean(xs), my = mean(ys);
        let num = 0, den = 0;
        for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
        if (den > 0) {
          const local = num / den;
          const w = list.length / (list.length + 5);
          slopeF = w * local + (1 - w) * curve.slope;
        }
      }
      slopes.set(f, slopeF);
    }
    const resByFam = new Map();
    for (const p of train) {
      const f = familyOf(p.category);
      const r = Math.log(p.mcap_usd / p.tvl_usd) - (curve.intercept + slopes.get(f) * Math.log(p.tvl_usd));
      if (!resByFam.has(f)) resByFam.set(f, []);
      resByFam.get(f).push(r);
    }
    const adjs = new Map();
    for (const [f, list] of resByFam) {
      const raw = list.length >= 3 ? median(list) : 0;
      adjs.set(f, raw * (list.length / (list.length + 2)));
    }
    return (tvl, category) => {
      if (!Number.isFinite(tvl) || tvl <= 0) return 1;
      const f = familyOf(category);
      const slope = slopes.get(f) ?? curve.slope;
      const base = Math.exp(curve.intercept + slope * Math.log(tvl));
      const adj = adjs.get(f) ?? 0;
      return Math.min(2.0, Math.max(0.005, base * Math.exp(adj)));
    };
  };
}

// V0 frozen fitter (sanity check — must reproduce the frozen table exactly).
function makeFitterV0() {
  return (train) => {
    const curve = fitOLS(train);
    const fams = familyAdjustments(train, curve);
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
  if (id === 'N3') return makeFitterN3();
  if (id === 'N4') return makeFitterN4();
  return makeFitterDesign(id);
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
// CPCV (pre-registered definition — see header (a)): 4 chronological groups,
// 4 paths (train 3, test 1), same-day purge (train peer dropped if its
// listed_at equals ANY listed_at in the test group). Median over ALL path
// errors, exponentiated like the other metrics.
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
    for (const p of test) errors.push(Math.abs(Math.log((p.tvl_usd * f(p.tvl_usd, p.category, extraOf(p))) / p.mcap_usd)));
    paths++;
  }
  return { ...summarize(errors), peers: dated.length, paths };
}
function overlapTop10(fit) {
  const cands = snapshot.protocols.filter((p) => passesScreen(p) && Number.isFinite(p.tvl_usd) && p.tvl_usd > 0);
  const f = fit(peers); // fitted on the traded peers, exactly like the board fit
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
  R1: 'W1 RE-TEST quadratic size term (x-mx)^2 + CPCV',
  N1: 'NEW chain-count main effect + d*log1p(n_chains)',
  N2: 'NEW chain-count x size interaction + d*(x-mx)*log1p(n_chains)',
  N3: 'NEW category-level adjustment (median resid per category, n>=3, family fallback)',
  N4: 'NEW family-specific size slope (shrunk n/(n+5) to global slope)',
  N5: 'NEW |change_7d| main effect + d*|clip(change,-50,50)|/100',
};

console.log(`refit-v9 run: variant ${variant}, ${peers.length} traded peers, ${snapshot.protocols.length} protocols, as_of ${snapshot.as_of}`);
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
// Sanity check: V0 must reproduce the frozen table (OOS 2.9828 / WF 2.9211 /
// LOO 2.8955 / overlap 9/10) or the run is invalid.
const sanity =
  Math.abs(base.o.median - 2.9828) < 0.0005 &&
  Math.abs(base.w.median - 2.9211) < 0.0005 &&
  Math.abs(base.l.median - 2.8955) < 0.0005 &&
  base.ov.overlap === 9;
console.log(`SANITY V0 reproduces frozen table: ${sanity ? 'PASS' : 'FAIL — RUN INVALID, conclude nothing'}`);
if (!sanity) process.exit(0);

const t = runOne(variant);
const oosBetter2 = t.o.median < base.o.median * 0.98;
const allBetter = t.o.median < base.o.median && t.w.median < base.w.median && t.l.median < base.l.median;
const overlapDown = t.ov.overlap < base.ov.overlap;
const cpcvBetter = t.c.median < base.c.median;
if (variant === 'R1') {
  // (a) Old rule PLUS second gate (CPCV < frozen CPCV). Recorded in the
  // header before the run: W1 already failed LOO in v7, so under the old
  // rule it cannot be adopted regardless of CPCV — CPCV is diagnostic.
  const oldRule = oosBetter2 && allBetter && overlapDown;
  console.log(
    `R1 verdict: old rule ${oldRule ? 'PASS' : 'FAIL'} (OOS>=2% ${oosBetter2 ? 'yes' : 'no'}, all-three ${allBetter ? 'yes' : 'no'}, overlap<9 ${overlapDown ? 'yes' : 'no'})` +
    `; CPCV gate ${cpcvBetter ? 'PASS' : 'FAIL'} (W1 x${t.c.median.toFixed(4)} vs frozen x${base.c.median.toFixed(4)})` +
    ` -> ${oldRule && cpcvBetter ? 'ADOPT' : 'REJECT'} (W1 already failed LOO in v7; CPCV is diagnostic only)`,
  );
} else {
  // (b) Old rule only; CPCV diagnostic, not part of the rule.
  const pass = oosBetter2 && allBetter && overlapDown;
  console.log(
    `${variant} verdict: old rule ${pass ? 'PASS' : 'FAIL'} (OOS>=2% ${oosBetter2 ? 'yes' : 'no'}, all-three ${allBetter ? 'yes' : 'no'}, overlap<9 ${overlapDown ? 'yes' : 'no'})` +
    `; CPCV diagnostic x${t.c.median.toFixed(4)} vs frozen x${base.c.median.toFixed(4)} (${cpcvBetter ? 'better' : 'worse/equal'}, NOT part of the rule)` +
    ` -> ${pass ? 'ADOPT' : 'REJECT'}`,
  );
}
console.log(`frozen top-10 (TVL): ${base.ov.tvlTop.join(', ')}`);
