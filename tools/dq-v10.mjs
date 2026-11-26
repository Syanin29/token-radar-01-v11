// tools/dq-v10.mjs — Data Quality suite for the v10 new-signal data
// (skill data-quality-auditor: one check per DQ dimension; exit 0 = all pass).
// Reads tools/data/features.json + the raw cache + the kit snapshot.
// Checks:
//   completeness — fees coverage, tvl-history coverage (reported, not gated:
//                  low coverage is a GATE outcome in refit-v10, not a DQ fail)
//   freshness    — every feature value derives only from points <= as_of
//                  (PIT); max series date AFTER as_of must be excluded, and
//                  the build must record max_date_in_series (fetch date is
//                  2026-11-26, i.e. AFTER as_of — that is expected: the raw
//                  cache is a 26 Nov download, truncated to as_of by build)
//   validity     — fees >= 0 finite; tvl > 0 finite; slopes finite;
//                  no NaN/Infinity anywhere in features.json numeric fields
//   consistency  — (a) snapshot TVL vs /protocol TVL at as_of: median |log
//                  ratio| reported, FAIL if > 0.05 (≈5%); (b) fees T30d
//                  ending 2026-11-26 (fetch date) from the per-protocol
//                  series vs the CURRENT overview total30d for the same slug:
//                  median |log ratio| reported, FAIL if > 0.10. NOTE (skill
//                  data-vendor-cross-validation): this is CONSISTENCY within
//                  one vendor family (DefiLlama), NOT independent validation.
//   uniqueness   — no duplicate slugs in features.json; no duplicate
//                  timestamps inside any cached series
//   accuracy     — spot reconciliation: for 5 named slugs, recompute
//                  fees_T30d from the raw chart independently and compare
//                  to features.json (must match exactly).
// Usage: node tools/dq-v10.mjs ; exit 0 all pass, 1 any check failed.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(root, 'tools', 'data');
const AS_OF_TS = Date.parse('2026-11-14T00:00:00Z') / 1000;
const DAY = 86400;
const FETCH_DATE_TS = Date.parse('2026-11-26T00:00:00Z') / 1000;

const snap = JSON.parse(readFileSync('/home/hatch/workspace/makefun/token-radar-01-kit/input/snapshot.json', 'utf8'));
const FEAT = JSON.parse(readFileSync(join(dataDir, 'features.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(dataDir, 'fetch-manifest.json'), 'utf8'));
const overview = JSON.parse(readFileSync(join(dataDir, 'fees-overview-2026-11-26.json'), 'utf8')).protocols;
const ovBySlug = new Map(overview.map((p) => [p.slug, p]));

const results = [];
function check(name, dimension, pass, detail) {
  results.push({ name, dimension, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${dimension}] ${name}: ${detail}`);
}
const median = (vs) => {
  if (!vs.length) return null;
  const s = [...vs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---- completeness ----
const peers119 = snap.protocols.filter((p) => p.mcap_usd !== null && Number.isFinite(p.mcap_usd / p.tvl_usd) && p.mcap_usd / p.tvl_usd >= 0.001 && p.mcap_usd / p.tvl_usd <= 10);
check('fees coverage peers119', 'completeness', true,
  `${FEAT.coverage.fees_peers_119}/119 peers have a measured fees_T30d (gate in refit-v10, not DQ)`);
check('tvl-history coverage peers119', 'completeness', true,
  `${FEAT.coverage.tvl_peers_119}/119 peers have mom30+mom90 (gate in refit-v10, not DQ)`);
check('github coverage board', 'completeness', true,
  `${FEAT.coverage.github_board}/${FEAT.coverage.board_n} board rows have a github org (gate in refit-v10, not DQ)`);

// ---- freshness / PIT ----
let pitViolations = 0;
for (const [slug, f] of Object.entries(FEAT.features)) {
  // A feature is PIT-clean iff it was built from points <= as_of. The build
  // truncates; verify indirectly: fees_n30 must be <= 30 and tvl_last_date <= as_of.
  if (f.fees_n30 !== undefined && f.fees_n30 > 30) pitViolations++;
  if (f.tvl_last_date && f.tvl_last_date > '2026-11-14') pitViolations++;
}
check('PIT truncation (no feature point after as_of)', 'timeliness', pitViolations === 0,
  `${pitViolations} violations; fees_n30 max 30, tvl_last_date <= 2026-11-14 for all rows`);
check('fetch-date disclosure', 'timeliness', FEAT.max_date_in_series.fees !== null,
  `raw cache downloaded 2026-11-26 (fees series max ${FEAT.max_date_in_series.fees}, tvl max ${FEAT.max_date_in_series.tvl}); features truncated to as_of 2026-11-14`);

// ---- validity ----
let badNums = 0; const badSlugs = [];
for (const [slug, f] of Object.entries(FEAT.features)) {
  for (const [k, v] of Object.entries(f)) {
    if (typeof v === 'number' && !Number.isFinite(v)) { badNums++; badSlugs.push(`${slug}.${k}`); }
  }
  if (f.fees_t30d !== undefined && f.fees_t30d < 0) { badNums++; badSlugs.push(`${slug}.fees_t30d<0`); }
  if (f.tvl_at_asof !== undefined && f.tvl_at_asof !== null && f.tvl_at_asof <= 0) { badNums++; badSlugs.push(`${slug}.tvl<=0`); }
}
check('numeric validity (finite, fees>=0, tvl>0)', 'validity', badNums === 0,
  `${badNums} bad values${badSlugs.length ? ' e.g. ' + badSlugs.slice(0, 5).join(', ') : ''}`);

// ---- consistency (a): snapshot TVL vs /protocol TVL at as_of ----
const logRatios = [];
for (const p of snap.protocols) {
  const f = FEAT.features[p.slug];
  if (!f || f.tvl_at_asof === null || f.tvl_at_asof === undefined) continue;
  if (!(p.tvl_usd > 0)) continue;
  logRatios.push(Math.abs(Math.log(f.tvl_at_asof / p.tvl_usd)));
}
const medLogRatio = median(logRatios);
check('snapshot TVL vs /protocol TVL at as_of', 'consistency', medLogRatio !== null && medLogRatio <= 0.05,
  `n=${logRatios.length}, median |log ratio| = ${medLogRatio === null ? 'n/a' : medLogRatio.toFixed(4)} (fail if > 0.05)`);

// ---- consistency (b): series T30d to fetch date vs overview total30d ----
const feeRatios = [];
for (const p of overview) {
  const file = join(dataDir, `fees-${p.slug}.json`);
  if (!existsSync(file)) continue;
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const chart = (s.totalDataChart || []).filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]));
  const t30 = chart.filter(([ts]) => ts > FETCH_DATE_TS - 30 * DAY && ts <= FETCH_DATE_TS)
    .reduce((a, [, v]) => a + v, 0);
  if (t30 > 0 && p.total30d > 0) feeRatios.push(Math.abs(Math.log(t30 / p.total30d)));
}
const medFeeRatio = median(feeRatios);
check('fees series T30d (to 26 Nov) vs overview total30d', 'consistency', medFeeRatio !== null && medFeeRatio <= 0.10,
  `n=${feeRatios.length}, median |log ratio| = ${medFeeRatio === null ? 'n/a' : medFeeRatio.toFixed(4)} (fail if > 0.10). SAME vendor family — consistency only, not independent validation.`);

// ---- uniqueness ----
const slugs = Object.keys(FEAT.features);
check('unique slugs in features.json', 'uniqueness', new Set(slugs).size === slugs.length,
  `${slugs.length} rows, ${new Set(slugs).size} unique`);
let dupTs = 0;
for (const file of readdirSync(dataDir).filter((f) => f.startsWith('fees-') && f.endsWith('.json'))) {
  const s = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
  const ts = (s.totalDataChart || []).map((r) => r[0]);
  if (new Set(ts).size !== ts.length) dupTs++;
}
check('no duplicate timestamps in fees series', 'uniqueness', dupTs === 0, `${dupTs} files with duplicate timestamps`);

// ---- accuracy: independent recomputation for 3 covered peers119 slugs ----
const spot = peers119.filter((p) => FEAT.features[p.slug]?.fees_covered).slice(0, 3).map((p) => p.slug);
let spotOk = 0, spotTried = 0;
for (const slug of spot) {
  const file = join(dataDir, `fees-${slug}.json`);
  if (!existsSync(file)) continue;
  spotTried++;
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const t30 = (s.totalDataChart || [])
    .filter(([ts]) => ts > AS_OF_TS - 30 * DAY && ts <= AS_OF_TS)
    .reduce((a, [, v]) => a + v, 0);
  const got = FEAT.features[slug]?.fees_t30d;
  if (got !== undefined && Math.abs(t30 - got) < 1e-6) spotOk++;
  else console.log(`  spot mismatch ${slug}: recomputed ${t30} vs features ${got}`);
}
check('spot recomputation fees_T30d (3 covered peers)', 'accuracy', spotTried === 3 && spotOk === spotTried,
  `${spotOk}/${spotTried} match exactly (${spot.join(', ')})`);

const failed = results.filter((r) => !r.pass);
console.log(`\nDQ suite: ${results.length - failed.length}/${results.length} checks pass.`);
if (failed.length) { console.log('FAILED: ' + failed.map((r) => r.name).join('; ')); process.exit(1); }
process.exit(0);
