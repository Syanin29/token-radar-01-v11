// tools/bands-qr-v10.mjs — v10 uncertainty bands, plan B: QUANTILE REGRESSION.
// (Node 22, standard library only. Deterministic: fixed seed, fixed epochs.)
//
// Why a second script: tools/bands-v10.mjs REFUSED the fold-spread band —
// the 8-refit spread covers only 9.2% of held-out peers (parameter spread
// is tiny next to the residual dispersion; even a x4 widening reaches only
// 37.8% and pinball at tau=0.10/0.90 loses to a marginal baseline). A
// parameter-spread band is a confidently wrong band, so it stays out.
//
// This script tests the skill's own method instead
// (quantile-regression-for-uncertainty-aware-signals): fit tau in
// {0.10, 0.50, 0.90} of log(multiple) on [standardised log(TVL) + family
// dummies] by pinball-loss subgradient descent (Robbins-Monro schedule,
// Polyak-Ruppert averaging, intercept warm-started at the marginal
// quantile, crossing repair by sorting). The band then measures the
// CONDITIONAL dispersion of the target — residuals included — not the
// wobble of the fit.
//
// PRE-REGISTERED ADOPTION GATES (fixed here, before any run):
//   1. Self-tests pass (skill Verification: intercept-only quantiles on
//      0..100 recover ~10/50/90; location-shift y=5+x+N(0,1) width ~2.56).
//   2. 5-fold CV on the 119 peers: joint [q10,q90] coverage in [72%, 88%]
//      (80% +- ~2 standard errors); per-tau coverage within +-0.12 of tau.
//   3. Pinball loss beats the intercept-only (marginal-quantile) baseline
//      at ALL THREE tau.
//   4. The frozen point estimate lies inside its band for >= 90% of board
//      rows (a band that routinely excludes the point it annotates is
//      incoherent — refuse it).
// If any gate fails: REFUSE (exit 1), no band is wired in; the honest
// fallback is the already-reported OOS error factor plus the rank-1-vs-2
// arithmetic (see VALIDATION §13).
//
// Usage: node tools/bands-qr-v10.mjs --input <snapshot.json> [--out <json>]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { parseSnapshot, buildBoard } = await import(join(repoRoot, 'lib', 'model.ts'));

function flagValue(argv, flag, fallback) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(`--${flag}=`)) return argv[i].slice(flag.length + 3);
  }
  return fallback;
}
const argv = process.argv.slice(2);
const input = flagValue(argv, 'input', '');
const outPath = flagValue(argv, 'out', '');
const epochsFlag = Number(flagValue(argv, 'epochs', '2500')) || 2500;
const eta0Flag = Number(flagValue(argv, 'eta0', '1.0')) || 1.0;
if (!input) { console.error('usage: node tools/bands-qr-v10.mjs --input <snapshot.json> [--out <json>]'); process.exit(1); }

// --- deterministic PRNG (mulberry32) ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const quantile = (sorted, q) => {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const sortedCopy = (v) => [...v].sort((a, b) => a - b);
const pinball = (y, q, tau) => (y >= q ? tau * (y - q) : (1 - tau) * (q - y));

// --- features: [z(log TVL), family dummies (drop 'Other' as baseline)] ---
const FAMILY_OF = {
  'Risk Curators': 'Yield & management', 'Onchain Capital Allocator': 'Yield & management',
  Yield: 'Yield & management', 'Yield Aggregator': 'Yield & management', 'Basis Trading': 'Yield & management',
  Dexs: 'Trading', Derivatives: 'Trading', Options: 'Trading',
  Lending: 'Lending', CDP: 'Lending', 'Leveraged Farming': 'Lending',
  'Liquid Staking': 'Staking', 'Liquid Restaking': 'Staking', Restaking: 'Staking', 'Staking Pool': 'Staking',
  Bridge: 'Bridging', 'Canonical Bridge': 'Bridging', 'Cross Chain Bridge': 'Bridging',
  CEX: 'Exchanges', RWA: 'Real-world assets',
};
const familyOf = (c) => (c === null ? 'Other' : FAMILY_OF[c] ?? 'Other');
const FAMILIES = ['Yield & management', 'Trading', 'Lending', 'Staking', 'Bridging', 'Exchanges', 'Real-world assets']; // 'Other' = baseline
function design(peers, stats) {
  // stats: {meanLogTvl, sdLogTvl} from TRAINING peers only.
  return peers.map((p) => {
    const z = (Math.log(p.tvl_usd) - stats.meanLogTvl) / stats.sdLogTvl;
    const f = familyOf(p.category);
    return [z, ...FAMILIES.map((fam) => (f === fam ? 1 : 0))];
  });
}
function trainStats(peers) {
  const xs = peers.map((p) => Math.log(p.tvl_usd));
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / xs.length) || 1;
  return { meanLogTvl: m, sdLogTvl: sd };
}

// Quantile fit by subgradient descent (skill workflow steps 2-3).
// eta_t = eta0 * sigma_y / (1+t)^p, p=0.6; Polyak-Ruppert average of the
// second half of iterates; intercept warm-started at marginal quantile.
function fitQuantile(X, y, tau, { epochs = 2500, eta0 = 1.0, p = 0.6, seed = 42 } = {}) {
  const n = y.length;
  const d = X[0].length;
  const ys = sortedCopy(y);
  const sigmaY = (quantile(ys, 0.75) - quantile(ys, 0.25)) || 1;
  let w = new Array(d).fill(0);
  let b = quantile(ys, tau);
  let wAvg = [...w]; let bAvg = b; let avgCount = 0;
  const rng = mulberry32(seed);
  let t = 0;
  const half = Math.floor((epochs * n) / 2);
  for (let ep = 0; ep < epochs; ep++) {
    // Deterministic reshuffle each epoch.
    const order = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const i of order) {
      t++;
      const xi = X[i];
      let pred = b;
      for (let k = 0; k < d; k++) pred += w[k] * xi[k];
      const resid = y[i] - pred;
      // Subgradient of pinball loss wrt pred: -tau if resid>=0 else (1-tau).
      const g = resid >= 0 ? -tau : 1 - tau;
      const eta = (eta0 * sigmaY) / Math.pow(1 + t, p);
      // Gradient step on (w, b): w -= eta * g * x ; b -= eta * g.
      for (let k = 0; k < d; k++) w[k] -= eta * g * xi[k];
      b -= eta * g;
      if (t >= half) {
        avgCount++;
        for (let k = 0; k < d; k++) wAvg[k] += (w[k] - wAvg[k]) / avgCount;
        bAvg += (b - bAvg) / avgCount;
      }
    }
  }
  return { w: wAvg, b: bAvg };
}
function predictQuantile(fit, x) {
  let s = fit.b;
  for (let k = 0; k < fit.w.length; k++) s += fit.w[k] * x[k];
  return s;
}
function foldOf(slug) {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0;
  return Math.abs(h) % 5;
}

// --- Gate 1: self-tests (skill Verification) ---
let selfOk = true;
{
  // Intercept-only (num_features=0) on 0..100: q10/q50/q90 ~= 10/50/90.
  const y = Array.from({ length: 101 }, (_, i) => i);
  const X = y.map(() => []);
  const stats = { meanLogTvl: 0, sdLogTvl: 1 };
  void stats;
  const q = {};
  for (const tau of [0.1, 0.5, 0.9]) {
    const f = fitQuantile(X, y, tau, { epochs: 800, seed: 7 });
    q[tau] = f.b;
  }
  console.log(`self-test intercept-only 0..100: q10=${q[0.1].toFixed(1)} (want ~10) q50=${q[0.5].toFixed(1)} (~50) q90=${q[0.9].toFixed(1)} (~90)`);
  if (Math.abs(q[0.1] - 10) > 3 || Math.abs(q[0.5] - 50) > 3 || Math.abs(q[0.9] - 90) > 3) selfOk = false;
  // Location-shift: y = 5 + x + N(0,1); width q90-q10 ~= 2.5631 at every x.
  const rng = mulberry32(1234);
  const gauss = () => {
    let u = 0; let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const xs = []; const ys = [];
  for (let i = 0; i < 400; i++) { const x = rng() * 4; xs.push([x]); ys.push(5 + x + gauss()); }
  const fits = {};
  for (const tau of [0.1, 0.5, 0.9]) fits[tau] = fitQuantile(xs, ys, tau, { epochs: 600, seed: 11 });
  const width = predictQuantile(fits[0.9], [2]) - predictQuantile(fits[0.1], [2]);
  const mid = predictQuantile(fits[0.5], [2]);
  console.log(`self-test location-shift at x=2: width=${width.toFixed(2)} (want ~2.56) median=${mid.toFixed(2)} (want ~7.0)`);
  if (Math.abs(width - 2.5631) > 0.6 || Math.abs(mid - 7) > 0.6) selfOk = false;
}
console.log(`self-tests: ${selfOk ? 'PASS' : 'FAIL'}`);
if (!selfOk) { console.log('REFUSE: quantile engine fails its own verification'); process.exit(1); }

// --- data ---
const { snapshot } = parseSnapshot(readFileSync(input, 'utf8'));
const peers = [];
for (const p of snapshot.protocols) {
  if (p.mcap_usd === null || !Number.isFinite(p.tvl_usd) || p.tvl_usd <= 0) continue;
  const m = p.mcap_usd / p.tvl_usd;
  if (!Number.isFinite(m) || m < 0.001 || m > 10) continue;
  peers.push(p);
}
const yOf = (p) => Math.log(p.mcap_usd / p.tvl_usd);

// --- Gate 2+3: 5-fold CV calibration + pinball ---
const cv = []; // {slug, y, q10, q50, q90, crossed}
let crossed = 0;
for (let f = 0; f < 5; f++) {
  const train = peers.filter((p) => foldOf(p.slug) !== f);
  const test = peers.filter((p) => foldOf(p.slug) === f);
  const stats = trainStats(train);
  const Xtr = design(train, stats);
  const ytr = train.map(yOf);
  const fits = {};
  for (const tau of [0.1, 0.5, 0.9]) fits[tau] = fitQuantile(Xtr, ytr, tau, { epochs: epochsFlag, eta0: eta0Flag, seed: 42 });
  const Xte = design(test, stats);
  test.forEach((p, i) => {
    const raw = [predictQuantile(fits[0.1], Xte[i]), predictQuantile(fits[0.5], Xte[i]), predictQuantile(fits[0.9], Xte[i])];
    if (!(raw[0] <= raw[1] && raw[1] <= raw[2])) crossed++;
    const s = [...raw].sort((a, b) => a - b); // crossing repair (Chernozhukov rearrangement)
    cv.push({ slug: p.slug, y: yOf(p), q10: s[0], q50: s[1], q90: s[2] });
  });
}
const jointCov = cv.filter((r) => r.y >= r.q10 && r.y <= r.q90).length / cv.length;
const tauCov = {};
for (const tau of [0.1, 0.5, 0.9]) {
  const q = tau === 0.1 ? 'q10' : tau === 0.5 ? 'q50' : 'q90';
  tauCov[tau] = cv.filter((r) => r.y <= r[q]).length / cv.length;
}
const pin = { 0.1: 0, 0.5: 0, 0.9: 0 };
const pinBase = { 0.1: 0, 0.5: 0, 0.9: 0 };
{
  const marg = {};
  for (const tau of [0.1, 0.5, 0.9]) marg[tau] = quantile(sortedCopy(peers.map(yOf)), tau);
  for (const r of cv) {
    pin[0.1] += pinball(r.y, r.q10, 0.1); pin[0.5] += pinball(r.y, r.q50, 0.5); pin[0.9] += pinball(r.y, r.q90, 0.9);
    pinBase[0.1] += pinball(r.y, marg[0.1], 0.1); pinBase[0.5] += pinball(r.y, marg[0.5], 0.5); pinBase[0.9] += pinball(r.y, marg[0.9], 0.9);
  }
  for (const t of [0.1, 0.5, 0.9]) { pin[t] /= cv.length; pinBase[t] /= cv.length; }
}
console.log(`CV joint coverage [q10,q90]: ${(jointCov * 100).toFixed(1)}% (${Math.round(jointCov * cv.length)}/${cv.length}) — gate [72%, 88%]`);
console.log(`per-tau coverage: tau=0.10 ${(tauCov[0.1] * 100).toFixed(1)}% | tau=0.50 ${(tauCov[0.5] * 100).toFixed(1)}% | tau=0.90 ${(tauCov[0.9] * 100).toFixed(1)}% — gate +-0.12`);
console.log(`pinball tau=0.10: ${pin[0.1].toFixed(4)} vs marginal ${pinBase[0.1].toFixed(4)} | tau=0.50: ${pin[0.5].toFixed(4)} vs ${pinBase[0.5].toFixed(4)} | tau=0.90: ${pin[0.9].toFixed(4)} vs ${pinBase[0.9].toFixed(4)}`);
console.log(`crossings pre-repair: ${crossed}/${cv.length}`);

// --- full fit -> board-row bands ---
const statsAll = trainStats(peers);
const Xall = design(peers, statsAll);
const yall = peers.map(yOf);
const fullFits = {};
for (const tau of [0.1, 0.5, 0.9]) fullFits[tau] = fitQuantile(Xall, yall, tau, { epochs: epochsFlag, eta0: eta0Flag, seed: 42 });
const { rows } = buildBoard(snapshot);
const bandRows = rows.map((r) => {
  const x = design([{ tvl_usd: r.tvl_usd, category: r.category }], statsAll)[0];
  const raw = [predictQuantile(fullFits[0.1], x), predictQuantile(fullFits[0.5], x), predictQuantile(fullFits[0.9], x)];
  const s = [...raw].sort((a, b) => a - b);
  const lo = Math.max(1, Math.round(r.tvl_usd * Math.exp(s[0])));
  const hi = Math.max(1, Math.round(r.tvl_usd * Math.exp(s[2])));
  return {
    slug: r.slug, rank: r.rank, implied: r.implied_value_usd, lo, hi,
    pointInBand: r.implied_value_usd >= lo && r.implied_value_usd <= hi,
    widthFactor: hi / lo,
  };
});
const widths = bandRows.map((b) => b.widthFactor).sort((a, b) => a - b);
const medWidth = widths[Math.floor(widths.length / 2)];
const pointIn = bandRows.filter((b) => b.pointInBand).length;
const r1 = bandRows[0]; const r2 = bandRows[1];
const overlap12 = r1.lo <= r2.hi && r2.lo <= r1.hi;
let adjOverlap = 0;
for (let i = 0; i < bandRows.length - 1; i++) {
  if (bandRows[i].lo <= bandRows[i + 1].hi && bandRows[i + 1].lo <= bandRows[i].hi) adjOverlap++;
}
console.log(`board rows ${bandRows.length}; median band width factor x${medWidth.toFixed(2)} (min x${widths[0].toFixed(2)}, max x${widths[widths.length - 1].toFixed(2)})`);
console.log(`point estimate inside its band: ${pointIn}/${bandRows.length} — gate >= 90%`);
console.log(`rank 1 ${r1.slug} $${r1.implied.toLocaleString()} band [$${r1.lo.toLocaleString()}, $${r1.hi.toLocaleString()}] vs rank 2 ${r2.slug} $${r2.implied.toLocaleString()} band [$${r2.lo.toLocaleString()}, $${r2.hi.toLocaleString()}] — overlap: ${overlap12 ? 'YES, within noise' : 'NO'}`);
console.log(`adjacent-rank band overlaps: ${adjOverlap}/${bandRows.length - 1}`);

const adopt = jointCov >= 0.72 && jointCov <= 0.88
  && Math.abs(tauCov[0.1] - 0.1) <= 0.12 && Math.abs(tauCov[0.5] - 0.5) <= 0.12 && Math.abs(tauCov[0.9] - 0.9) <= 0.12
  && pin[0.1] < pinBase[0.1] && pin[0.5] < pinBase[0.5] && pin[0.9] < pinBase[0.9]
  && pointIn / bandRows.length >= 0.9;
console.log(adopt ? 'ADOPT: quantile band calibrated, wire into model.ts' : 'REFUSE: quantile band fails a gate — do not wire it in');
if (outPath) {
  writeFileSync(outPath, JSON.stringify({
    jointCoverage: jointCov, tauCoverage: tauCov, pinball: pin, pinballMarginal: pinBase,
    crossingsPreRepair: crossed, medianWidthFactor: medWidth, pointInBand: pointIn,
    rank1vs2Overlap: overlap12, adjacentOverlaps: adjOverlap, bands: bandRows, adopt,
  }, null, 2) + '\n');
  console.log(`wrote ${outPath}`);
}
process.exit(adopt ? 0 : 1);
