// tools/build-features-v10.mjs — build PIT-truncated v10 features from the
// cached raw DefiLlama responses in tools/data/ (NO network; reproducible).
//   fees:  GET /summary/fees/{slug} -> totalDataChart [[unix, usd], ...] daily.
//          fees_T30d = sum over (as_of-30d, as_of]; fees_prior30d = sum over
//          (as_of-60d, as_of-30d]. A protocol is COVERED only if its summary
//          fetched HTTP 200 AND its chart has >= 1 point in the T30d window.
//          totalDataChart is gross FEES (no dailyRevenue field exists in the
//          per-protocol summary — verified on sentora/aave-v2/uniswap-v3:
//          methodology text describes a revenue split, but no numeric
//          daily revenue series is served). Feature = fees, caveat recorded.
//   tvl:   GET /protocol/{slug} -> tvl[] {date (unix), totalLiquidityUSD}.
//          mom30/mom90 = OLS slope of log(TVL) vs days over points in
//          [as_of-30d, as_of] / [as_of-90d, as_of]. Covered if >= 15 / >= 45
//          points and all TVL > 0 in-window.
//   github: field `github` in the fees summary (array of org URLs or null).
//          Coverage only — NO GitHub API calls here; G1's gate is coverage.
// PIT: every feature value uses ONLY series points with date <= as_of
// (2026-11-14T00:00:00Z). Points after as_of are ignored, never summed.
// KNOWN LIMIT (skill backtesting-alt-data...): DefiLlama restates history
// in place — today's download of pre-as_of values may differ from what was
// published on 2026-11-14, and daily fees are published with ~1d lag, so the
// last 1-2 days of the T30d window may not have been knowable on as_of.
// The PIT guarantee here is on EVENT dates, not on publication dates; the
// residual restatement/lag risk is disclosed, not hidden.
// Output: tools/data/features.json (+ coverage + correlation diagnostics).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(root, 'tools', 'data');
const AS_OF = '2026-11-14';
const AS_OF_TS = Date.parse(`${AS_OF}T00:00:00Z`) / 1000; // 1793040000
const DAY = 86400;

const snap = JSON.parse(readFileSync('/home/hatch/workspace/makefun/token-radar-01-kit/input/snapshot.json', 'utf8'));
const manifest = JSON.parse(readFileSync(join(dataDir, 'fetch-manifest.json'), 'utf8'));

const peers144 = snap.protocols.filter((p) => p.mcap_usd !== null);
const peers119 = peers144.filter((p) => {
  const m = p.mcap_usd / p.tvl_usd;
  return Number.isFinite(m) && m >= 0.001 && m <= 10;
});
const EXC = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXN = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VS = /\s[vV]\d+(\.\d+)?$|\s\d+\.\d+$/;
const WW = /\b(wrapped|staked|staking)\b/i;
const passesScreen = (p) => {
  if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXC.has(p.category)) return false;
  const n = p.name ?? '';
  if (VS.test(n) || WW.test(n)) return false;
  for (const e of EXN) if (n.startsWith(e)) return false;
  return true;
};
const board = snap.protocols.filter((p) => passesScreen(p) && Number.isFinite(p.tvl_usd) && p.tvl_usd > 0);
const slugs = [...new Set([...peers119.map((p) => p.slug), ...board.map((p) => p.slug)])];
// Extra fees-only slugs: the 11 peers dropped from the 119 by the multiple
// filter (144-119) that DO have a DefiLlama fees adapter. They are needed
// only to measure the F1/F2 coverage gate honestly over all 144 traded
// peers; they never enter any fit (the fit uses the same 119 as v9).
const EXTRA_FEES_SLUGS = ['aave-v2', 'autofinance', 'bitway-earn', 'blazestake', 'geth', 'obol', 'piku-finance', 'radpie', 'rain', 'sierra-protocol', 'yieldnest'];
const allSlugs = [...new Set([...slugs, ...EXTRA_FEES_SLUGS])];

const median = (vs) => {
  if (!vs.length) return null;
  const s = [...vs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (vs) => vs.reduce((a, b) => a + b, 0) / vs.length;
const corr = (xs, ys) => {
  if (xs.length < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
};
function slopeOLS(pts) { // pts: [[dayIndex, logValue], ...]
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? null : num / den;
}

const features = {};
let feesCovered144 = 0, feesCovered119 = 0, feesCoveredBoard = 0;
let tvlCovered119 = 0, tvlCoveredBoard = 0;
let githubBoard = 0, githubPeers = 0;
let revenueFieldSeen = 0; // any per-protocol summary carrying a numeric daily revenue series?
const maxDateSeen = { fees: 0, tvl: 0 };
const feesT30dAll = [];

for (const slug of allSlugs) {
  const f = {};
  // ---- fees ----
  const feesFile = join(dataDir, `fees-${slug}.json`);
  const feesCode = manifest[`fees:${slug}`]?.code;
  if (feesCode === 200 && existsSync(feesFile)) {
    const s = JSON.parse(readFileSync(feesFile, 'utf8'));
    if (Array.isArray(s.dailyRevenue) && s.dailyRevenue.length) revenueFieldSeen++;
    if (Array.isArray(s.totalDataChartBreakdown)) {
      for (const row of s.totalDataChartBreakdown) {
        if (row && typeof row === 'object' && ('dailyRevenue' in row || 'Revenue' in row)) revenueFieldSeen++;
      }
    }
    const chart = (s.totalDataChart || []).filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]));
    for (const [ts] of chart) if (ts > maxDateSeen.fees) maxDateSeen.fees = ts;
    const inT30 = chart.filter(([ts]) => ts > AS_OF_TS - 30 * DAY && ts <= AS_OF_TS);
    const inPrior = chart.filter(([ts]) => ts > AS_OF_TS - 60 * DAY && ts <= AS_OF_TS - 30 * DAY);
    const sum = (rows) => rows.reduce((a, [, v]) => a + v, 0);
    if (inT30.length >= 1) {
      f.fees_t30d_raw = sum(inT30);
      f.fees_prior30d_raw = sum(inPrior);
      f.fees_n30 = inT30.length;
      // DQ finding: DefiLlama daily fees can be NEGATIVE (hegic: 450/1494
      // daily points < 0; tulipa-capital: 1 negative day inside the T30d
      // window). A negative trailing-30d sum is not a usable "fees earned"
      // value — treat as NOT covered, not as zero, not as log(negative).
      // The raw (negative) sum is kept in fees_t30d_raw for audit; the
      // usable field fees_t30d is null so no downstream code can use it.
      if (f.fees_t30d_raw > 0) {
        f.fees_t30d = f.fees_t30d_raw;
        f.fees_prior30d = f.fees_prior30d_raw;
        f.fees_covered = true;
        f.log_fees_t30d = Math.log(f.fees_t30d);
        f.log_fees_growth = (f.fees_prior30d > 0) ? Math.log(f.fees_t30d / f.fees_prior30d) : null;
      } else {
        f.fees_t30d = null;
        f.fees_prior30d = null;
        f.fees_covered = false;
        f.fees_negative_t30d = true;
        f.log_fees_t30d = null;
        f.log_fees_growth = null;
      }
      feesT30dAll.push(f.fees_t30d_raw);
    } else {
      f.fees_covered = false;
    }
    // github coverage (field presence only)
    const gh = s.github;
    const hasGh = Array.isArray(gh) ? gh.length > 0 : (typeof gh === 'string' && gh.length > 0);
    f.github_present = hasGh;
    f.github_raw = gh ?? null;
  } else {
    f.fees_covered = false;
    f.github_present = false;
    f.github_raw = null;
  }
  // ---- tvl history ----
  const protoFile = join(dataDir, `protocol-${slug}.json`);
  const protoCode = manifest[`protocol:${slug}`]?.code;
  if (protoCode === 200 && existsSync(protoFile)) {
    const s = JSON.parse(readFileSync(protoFile, 'utf8'));
    const tvl = (s.tvl || []).filter((r) => r && Number.isFinite(r.date) && Number.isFinite(r.totalLiquidityUSD));
    for (const r of tvl) if (r.date > maxDateSeen.tvl) maxDateSeen.tvl = r.date;
    const atAsOf = tvl.filter((r) => r.date <= AS_OF_TS).sort((a, b) => a.date - b.date);
    const last = atAsOf[atAsOf.length - 1];
    f.tvl_at_asof = last ? last.totalLiquidityUSD : null;
    f.tvl_last_date = last ? new Date(last.date * 1000).toISOString().slice(0, 10) : null;
    const win = (days, minPts) => {
      const pts = atAsOf
        .filter((r) => r.date > AS_OF_TS - days * DAY && r.totalLiquidityUSD > 0)
        .map((r) => [(r.date - AS_OF_TS) / DAY, Math.log(r.totalLiquidityUSD)]);
      if (pts.length < minPts) return { slope: null, n: pts.length };
      return { slope: slopeOLS(pts), n: pts.length };
    };
    const w30 = win(30, 15), w90 = win(90, 45);
    f.mom30 = w30.slope; f.mom30_n = w30.n;
    f.mom90 = w90.slope; f.mom90_n = w90.n;
    f.tvl_covered = w30.slope !== null && w90.slope !== null;
  } else {
    f.tvl_covered = false;
    f.mom30 = null; f.mom90 = null; f.mom30_n = 0; f.mom90_n = 0;
  }
  features[slug] = f;
}

for (const p of peers144) if (features[p.slug]?.fees_covered) feesCovered144++;
for (const p of peers119) {
  if (features[p.slug]?.fees_covered) feesCovered119++;
  if (features[p.slug]?.tvl_covered) tvlCovered119++;
  if (features[p.slug]?.github_present) githubPeers++;
}
for (const p of board) {
  if (features[p.slug]?.fees_covered) feesCoveredBoard++;
  if (features[p.slug]?.tvl_covered) tvlCoveredBoard++;
  if (features[p.slug]?.github_present) githubBoard++;
}

// ---- correlation diagnostics (peers119, observed values only) ----
const ageDaysOf = (p) => {
  if (p.listed_at === null) return null;
  return Math.max(0, Math.round((Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${p.listed_at}T00:00:00Z`)) / 86_400_000));
};
const paired = (keyFn) => {
  const xs = [], ys = [];
  for (const p of peers119) {
    const v = keyFn(p);
    if (v !== null && Number.isFinite(v)) { xs.push(v); ys.push(p); }
  }
  return { xs, ys };
};
const changeOf = (p) => (p.change_7d === null ? 0 : Math.max(-50, Math.min(50, p.change_7d)) / 100);
const logTvlOf = (p) => Math.log(p.tvl_usd);
const corrs = {};
{
  const a = paired((p) => features[p.slug]?.log_fees_t30d ?? null);
  corrs.log_fees_vs_log_tvl = corr(a.xs, a.ys.map(logTvlOf));
  corrs.log_fees_vs_change7d = corr(a.xs, a.ys.map(changeOf));
  const b = paired((p) => features[p.slug]?.log_fees_growth ?? null);
  corrs.log_fees_growth_vs_change7d = corr(b.xs, b.ys.map(changeOf));
  corrs.log_fees_growth_vs_log_tvl = corr(b.xs, b.ys.map(logTvlOf));
  const c = paired((p) => features[p.slug]?.mom30 ?? null);
  corrs.mom30_vs_change7d = corr(c.xs, c.ys.map(changeOf));
  corrs.mom30_vs_log_tvl = corr(c.xs, c.ys.map(logTvlOf));
  const d = paired((p) => features[p.slug]?.mom90 ?? null);
  corrs.mom90_vs_change7d = corr(d.xs, d.ys.map(changeOf));
  corrs.mom90_vs_log_tvl = corr(d.xs, d.ys.map(logTvlOf));
  corrs.mom30_vs_mom90 = corr(c.xs.filter((_, i) => features[c.ys[i].slug]?.mom90 !== null),
    c.ys.filter((p) => features[p.slug]?.mom90 !== null).map((p) => features[p.slug].mom90));
}
// IC vs V0 residual: Pearson corr of each feature with log(multiple) residual
// after the frozen size curve (fit on all 119 peers).
function fitOLSAll() {
  const xs = peers119.map((p) => Math.log(p.tvl_usd));
  const ys = peers119.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}
const curve = fitOLSAll();
const resid = (p) => Math.log(p.mcap_usd / p.tvl_usd) - (curve.intercept + curve.slope * Math.log(p.tvl_usd));
const ics = {};
for (const [name, key] of [['log_fees_t30d', 'log_fees_t30d'], ['log_fees_growth', 'log_fees_growth'], ['mom30', 'mom30'], ['mom90', 'mom90']]) {
  const xs = [], rs = [];
  for (const p of peers119) {
    const v = features[p.slug]?.[key];
    if (v !== null && v !== undefined && Number.isFinite(v)) { xs.push(v); rs.push(resid(p)); }
  }
  ics[name] = { pearson_vs_v0_resid: corr(xs, rs), n: xs.length };
}

const out = {
  as_of: AS_OF,
  as_of_ts: AS_OF_TS,
  generated_at: new Date().toISOString(),
  source: 'DefiLlama api.llama.fi (cached raw in tools/data/, fetched 2026-11-26)',
  pit: 'all feature values use series points with date <= as_of only; see build script header for restatement/lag limits',
  revenue_note: 'NO numeric daily revenue series is served per-protocol (dailyRevenue field absent; totalDataChartBreakdown carries no revenue numbers). Features use GROSS FEES. fees != revenue: the share kept by the protocol vs LPs/suppliers is not separated.',
  revenue_field_seen: revenueFieldSeen,
  coverage: {
    fees_peers_144: feesCovered144, fees_peers_119: feesCovered119, fees_board: feesCoveredBoard,
    tvl_peers_119: tvlCovered119, tvl_board: tvlCoveredBoard,
    github_board: githubBoard, github_peers_119: githubPeers, board_n: board.length,
    fees_gate_80pct_of_144: 115, github_gate_50pct_of_board: Math.ceil(board.length * 0.5),
  },
  max_date_in_series: {
    fees: maxDateSeen.fees ? new Date(maxDateSeen.fees * 1000).toISOString().slice(0, 10) : null,
    tvl: maxDateSeen.tvl ? new Date(maxDateSeen.tvl * 1000).toISOString().slice(0, 10) : null,
  },
  correlations: corrs,
  ic_vs_v0_residual: ics,
  features,
};
writeFileSync(join(dataDir, 'features.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({
  fees_peers_144: `${feesCovered144}/144`, fees_peers_119: `${feesCovered119}/119`,
  fees_board: `${feesCoveredBoard}/${board.length}`,
  tvl_peers_119: `${tvlCovered119}/119`, tvl_board: `${tvlCoveredBoard}/${board.length}`,
  github_board: `${githubBoard}/${board.length}`, github_peers: `${githubPeers}/119`,
  revenue_field_seen: revenueFieldSeen,
  max_date_fees: out.max_date_in_series.fees, max_date_tvl: out.max_date_in_series.tvl,
}, null, 1));
console.log('correlations', JSON.stringify(corrs, null, 1));
console.log('IC vs V0 residual', JSON.stringify(ics, null, 1));
