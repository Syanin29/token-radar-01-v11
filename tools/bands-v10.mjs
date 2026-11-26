// tools/bands-v10.mjs — v10 uncertainty bands: analysis BEFORE any model.ts edit.
// (Node 22, standard library only. Deterministic: no clocks, no randomness.)
//
// Question: can an 80% band [q10, q90] per board row be built from the spread
// of refits of the FROZEN model, and is it calibrated on held-out peers?
//
// Method (skill quantile-regression-for-uncertainty-aware-signals — applied
// as the skill demands: coverage measured on held-out data BEFORE any band
// is shown; sharpness only counts once coverage is right; a degenerate band
// is refused, not floored):
//   * Refit ensemble per board row: 5 fold-exclusion fits (train on 4/5 of
//     the 119 traded peers) + 3 walk-forward window fits = 8 predictions.
//     Band = [q10, q90] of the 8 log-implied values (type-7 quantiles).
//   * Calibration on held-out peers: for each peer, the band is built ONLY
//     from refits that excluded that peer — its fold-exclusion fit (1),
//     its leave-one-out fit (1), its walk-forward test-window fit (1, dated
//     peers only), its CPCV test-path fit (1, dated peers only). True
//     log-multiple inside the band? Coverage must land ~80% (+- a few
//     points). A single global scale on the log half-width (fitted on the
//     held-out peers only, never on board rows) brings coverage to 80% if
//     the raw band misses; the scale, raw coverage and calibrated coverage
//     are all reported. If no scale in [0.5, 4] gets coverage within
//     70-90%, the band is REFUSED (better no band than a confidently wrong
//     one) and this script exits 1.
//   * Pinball loss (skill step 1) at tau in {0.10, 0.50, 0.90} for the
//     peer band edges/median as quantile forecasts, vs an intercept-only
//     (marginal-quantile) baseline — the quantile fit must beat the
//     baseline at every level, or the band is refused.
//   * Sanity: the full fit must reproduce the frozen table (OOS x2.9828 /
//     WF x2.9211 / LOO x2.8955 / overlap 9/10) or nothing below is trusted.
//
// Usage: node tools/bands-v10.mjs --input <snapshot.json> [--out <json>]
// Exit 0 = band ADOPTED (coverage + pinball gates pass, scale recorded).
// Exit 1 = band REFUSED (numbers printed, do not wire it into model.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { parseSnapshot, buildBoard, passesScreen } = await import(join(repoRoot, 'lib', 'model.ts'));

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
if (!input) { console.error('usage: node tools/bands-v10.mjs --input <snapshot.json> [--out <json>]'); process.exit(1); }

// --- frozen-fit pieces, copied from lib/model.ts (sanity-checked below) ---
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
const median = (v) => {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
function fitSizeCurve(peers) {
  const xs = peers.map((p) => Math.log(p.tvl_usd));
  const ys = peers.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
  const mx = mean(xs); const my = mean(ys);
  let num = 0; let den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}
function familyAdjustments(peers, curve) {
  const res = new Map();
  for (const p of peers) {
    const fitted = curve.intercept + curve.slope * Math.log(p.tvl_usd);
    const r = Math.log(p.mcap_usd / p.tvl_usd) - fitted;
    const f = familyOf(p.category);
    const list = res.get(f) ?? [];
    list.push(r);
    res.set(f, list);
  }
  const out = new Map();
  for (const [f, list] of res) {
    const raw = list.length >= 3 ? median(list) : 0;
    out.set(f, { adjustment: raw * (list.length / (list.length + 2)), peers: list.length });
  }
  return out;
}
function fitAll(peers) {
  const curve = fitSizeCurve(peers);
  return { curve, families: familyAdjustments(peers, curve) };
}
function logPred(fit, tvl, category) {
  const f = familyOf(category);
  const e = fit.families.get(f);
  const adj = e === undefined ? 0 : e.adjustment;
  const base = Math.exp(fit.curve.intercept + fit.curve.slope * Math.log(tvl));
  const mult = Math.min(2.0, Math.max(0.005, base * Math.exp(adj)));
  return Math.log(tvl * mult);
}
function foldOf(slug) {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0;
  return Math.abs(h) % 5;
}
function quantile(sorted, q) {
  // Type-7 (linear interpolation), the same convention R uses.
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const pinball = (y, q, tau) => (y >= q ? tau * (y - q) : (1 - tau) * (q - y));

const { snapshot } = parseSnapshot(readFileSync(input, 'utf8'));
const peers = [];
const dropped = [];
for (const p of snapshot.protocols) {
  if (p.mcap_usd === null || !Number.isFinite(p.tvl_usd) || p.tvl_usd <= 0) continue;
  const m = p.mcap_usd / p.tvl_usd;
  if (!Number.isFinite(m) || m < 0.001 || m > 10) { dropped.push(p.slug); continue; }
  peers.push(p);
}
const dated = peers.filter((p) => p.listed_at !== null).sort((a, b) => {
  const d = a.listed_at.localeCompare(b.listed_at);
  return d !== 0 ? d : a.slug < b.slug ? -1 : 1;
});
const quarters = [[], [], [], []];
dated.forEach((p, i) => quarters[Math.min(3, Math.floor((i * 4) / dated.length))].push(p));

// --- refit ensemble ---
const foldFits = [];
for (let f = 0; f < 5; f++) foldFits.push(fitAll(peers.filter((p) => foldOf(p.slug) !== f)));
const wfFits = [];
for (let k = 0; k < 3; k++) {
  const test = quarters[k + 1];
  if (test.length === 0) continue;
  const first = test[0].listed_at;
  const train = quarters.slice(0, k + 1).flat().filter((p) => p.listed_at < first);
  if (train.length < 3) continue;
  wfFits.push({ fit: fitAll(train), testSlugs: new Set(test.map((p) => p.slug)) });
}
const cpcvFits = [];
for (let g = 0; g < 4; g++) {
  const test = quarters[g];
  const testDates = new Set(test.map((p) => p.listed_at));
  const train = quarters.flatMap((q, i) => (i === g ? [] : q)).filter((p) => !testDates.has(p.listed_at));
  cpcvFits.push({ fit: fitAll(train), testSlugs: new Set(test.map((p) => p.slug)) });
}

// --- sanity: reproduce the frozen table ---
const fullFit = fitAll(peers);
{
  const errs = [];
  for (let f = 0; f < 5; f++) {
    for (const p of peers.filter((x) => foldOf(x.slug) === f)) {
      errs.push(Math.abs(logPred(foldFits[f], p.tvl_usd, p.category) - Math.log(p.mcap_usd)));
    }
  }
  errs.sort((a, b) => a - b);
  const oos = Math.exp(errs[Math.floor(errs.length / 2)]);
  const wfErrs = [];
  for (const w of wfFits) {
    for (const p of dated.filter((x) => w.testSlugs.has(x.slug))) {
      wfErrs.push(Math.abs(logPred(w.fit, p.tvl_usd, p.category) - Math.log(p.mcap_usd)));
    }
  }
  wfErrs.sort((a, b) => a - b);
  const wf = Math.exp(wfErrs[Math.floor(wfErrs.length / 2)]);
  const looErrs = [];
  for (const p of peers) {
    const fit = fitAll(peers.filter((x) => x.slug !== p.slug));
    looErrs.push(Math.abs(logPred(fit, p.tvl_usd, p.category) - Math.log(p.mcap_usd)));
  }
  looErrs.sort((a, b) => a - b);
  const loo = Math.exp(looErrs[Math.floor(looErrs.length / 2)]);
  console.log(`sanity frozen: OOS x${oos.toFixed(4)} (want x2.9828) / WF x${wf.toFixed(4)} (want x2.9211) / LOO x${loo.toFixed(4)} (want x2.8955)`);
  if (Math.abs(oos - 2.9828) > 0.001 || Math.abs(wf - 2.9211) > 0.001 || Math.abs(loo - 2.8955) > 0.001) {
    console.log('SANITY FAIL — refit code does not reproduce the frozen model; stop.');
    process.exit(1);
  }
}

// --- peer calibration: bands from refits that EXCLUDED the peer ---
const logMult = peers.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
const margQ = (tau) => quantile([...logMult].sort((a, b) => a - b), tau);
const peerRows = [];
for (const p of peers) {
  const y = Math.log(p.mcap_usd / p.tvl_usd);
  const preds = [];
  preds.push(logPred(foldFits[foldOf(p.slug)], p.tvl_usd, p.category) - Math.log(p.tvl_usd)); // log-multiple
  const looFit = fitAll(peers.filter((x) => x.slug !== p.slug));
  preds.push(logPred(looFit, p.tvl_usd, p.category) - Math.log(p.tvl_usd));
  const w = wfFits.find((x) => x.testSlugs.has(p.slug));
  if (w) preds.push(logPred(w.fit, p.tvl_usd, p.category) - Math.log(p.tvl_usd));
  const c = cpcvFits.find((x) => x.testSlugs.has(p.slug));
  if (c) preds.push(logPred(c.fit, p.tvl_usd, p.category) - Math.log(p.tvl_usd));
  const s = [...preds].sort((a, b) => a - b);
  peerRows.push({ slug: p.slug, y, n: preds.length, q10: quantile(s, 0.1), q50: quantile(s, 0.5), q90: quantile(s, 0.9) });
}
const coverageAt = (scale) => {
  let hit = 0;
  for (const r of peerRows) {
    const lo = r.q50 - scale * (r.q50 - r.q10);
    const hi = r.q50 + scale * (r.q90 - r.q50);
    if (r.y >= lo && r.y <= hi) hit++;
  }
  return hit / peerRows.length;
};
const rawCov = coverageAt(1);
let bestScale = 1; let bestCov = rawCov;
for (let s = 0.5; s <= 4.001; s += 0.05) {
  const c = coverageAt(s);
  if (Math.abs(c - 0.8) < Math.abs(bestCov - 0.8)) { bestScale = s; bestCov = c; }
}
// Pinball at the three levels (band edges/median as quantile forecasts).
const pin = { 0.1: 0, 0.5: 0, 0.9: 0 };
const pinBase = { 0.1: 0, 0.5: 0, 0.9: 0 };
for (const r of peerRows) {
  pin[0.1] += pinball(r.y, r.q10, 0.1);
  pin[0.5] += pinball(r.y, r.q50, 0.5);
  pin[0.9] += pinball(r.y, r.q90, 0.9);
  pinBase[0.1] += pinball(r.y, margQ(0.1), 0.1);
  pinBase[0.5] += pinball(r.y, margQ(0.5), 0.5);
  pinBase[0.9] += pinball(r.y, margQ(0.9), 0.9);
}
for (const t of [0.1, 0.5, 0.9]) { pin[t] /= peerRows.length; pinBase[t] /= peerRows.length; }
const crossCount = peerRows.filter((r) => r.q10 > r.q90).length; // cannot happen post-sort; guard
console.log(`peers ${peerRows.length} (dated ${dated.length}); preds/peer: ` +
  `${peerRows.filter((r) => r.n === 2).length}x2, ${peerRows.filter((r) => r.n === 4).length}x4`);
console.log(`raw coverage (scale 1.00): ${(rawCov * 100).toFixed(1)}% (${Math.round(rawCov * peerRows.length)}/${peerRows.length})`);
console.log(`calibrated scale ${bestScale.toFixed(2)} -> coverage ${(bestCov * 100).toFixed(1)}% (${Math.round(bestCov * peerRows.length)}/${peerRows.length})`);
console.log(`pinball tau=0.10: ${pin[0.1].toFixed(4)} vs marginal ${pinBase[0.1].toFixed(4)} | tau=0.50: ${pin[0.5].toFixed(4)} vs ${pinBase[0.5].toFixed(4)} | tau=0.90: ${pin[0.9].toFixed(4)} vs ${pinBase[0.9].toFixed(4)}`);
console.log(`crossing bands: ${crossCount}`);

// --- board-row bands from the 8-refit ensemble ---
const { rows } = buildBoard(snapshot);
const ensemble = [...foldFits, ...wfFits.map((w) => w.fit)];
const bandRows = rows.map((r) => {
  const preds = ensemble.map((f) => logPred(f, r.tvl_usd, r.category));
  const s = [...preds].sort((a, b) => a - b);
  const q10 = quantile(s, 0.1); const q50 = quantile(s, 0.5); const q90 = quantile(s, 0.9);
  const lo = q50 - bestScale * (q50 - q10);
  const hi = q50 + bestScale * (q90 - q50);
  return {
    slug: r.slug, rank: r.rank, implied: r.implied_value_usd,
    lo: Math.max(1, Math.round(Math.exp(lo))), hi: Math.max(1, Math.round(Math.exp(hi))),
    pointInBand: r.implied_value_usd >= Math.exp(lo) && r.implied_value_usd <= Math.exp(hi),
    widthFactor: Math.exp(hi - lo),
  };
});
const widths = bandRows.map((b) => b.widthFactor).sort((a, b) => a - b);
const medWidth = widths[Math.floor(widths.length / 2)];
const pointIn = bandRows.filter((b) => b.pointInBand).length;
const r1 = bandRows[0]; const r2 = bandRows[1];
const overlap12 = r1.lo <= r2.hi && r2.lo <= r1.hi;
console.log(`board rows ${bandRows.length}; median band width factor x${medWidth.toFixed(2)} (min x${widths[0].toFixed(2)}, max x${widths[widths.length - 1].toFixed(2)})`);
console.log(`point estimate inside its band: ${pointIn}/${bandRows.length}`);
console.log(`rank 1 ${r1.slug} $${r1.implied.toLocaleString()} band [$${r1.lo.toLocaleString()}, $${r1.hi.toLocaleString()}] vs rank 2 ${r2.slug} $${r2.implied.toLocaleString()} band [$${r2.lo.toLocaleString()}, $${r2.hi.toLocaleString()}] — overlap: ${overlap12 ? 'YES, within noise' : 'NO'}`);
// Adjacent-rank band overlaps (how often is the order itself within noise?).
let adjOverlap = 0;
for (let i = 0; i < bandRows.length - 1; i++) {
  if (bandRows[i].lo <= bandRows[i + 1].hi && bandRows[i + 1].lo <= bandRows[i].hi) adjOverlap++;
}
console.log(`adjacent-rank band overlaps: ${adjOverlap}/${bandRows.length - 1}`);

const adopt = bestCov >= 0.7 && bestCov <= 0.9
  && pin[0.1] < pinBase[0.1] && pin[0.5] < pinBase[0.5] && pin[0.9] < pinBase[0.9];
console.log(adopt ? 'ADOPT: band calibrated, wire scale into model.ts' : 'REFUSE: band fails a gate — do not wire it in');
if (outPath) {
  writeFileSync(outPath, JSON.stringify({
    peers: peerRows.length, rawCoverage: rawCov, scale: bestScale, calibratedCoverage: bestCov,
    pinball: pin, pinballMarginal: pinBase, medianWidthFactor: medWidth,
    pointInBand: pointIn, rank1vs2Overlap: overlap12, adjacentOverlaps: adjOverlap,
    bands: bandRows, adopt,
  }, null, 2) + '\n');
  console.log(`wrote ${outPath}`);
}
process.exit(adopt ? 0 : 1);
