// tools/verify.mjs — headless playtest for Token Radar v11 (Node 22, stdlib only).
//
// Usage:
//   node tools/verify.mjs --input <snapshot.json> [--work <tmp-dir>]
//
// What it checks, in order:
//   1. Determinism — main.ts runs twice to two fresh dirs; both exit 0 with
//      empty stderr on a clean snapshot, and board.json + data.js are
//      byte-identical between the runs.
//   2. Model frozen — the out-of-sample median factor is still x2.98 (the v4
//      value). v6 changes farm-plan words and the dashboard only; the ranking
//      and the fit must not move. Any other value fails the run.
//   2b. Walk-forward + launch odds by age (v5, kept).
//   2c. Delta vs TVL (v6, display-only, computed client-side in app.js):
//      the header, the sort option and the computation exist, and the
//      implied TVL ranks form a permutation (deltas sum to 0).
//   2d. Dark mode (v6): the dark token block, the toggle and the pre-paint
//      boot script exist; the default theme is light (no data-theme="dark"
//      in the static HTML).
//   2e. Biggest calls (v7): the section, the |Δ| >= 50 filter, the scatter
//      and the top-10 tables exist; the board's own extremes are goonfi +95
//      and reti-pooling -81, and 43 rows move >= 50 places.
//   2f. Headline numbers (v7): the README opens with the numbered headline.
//   2g. Uncertainty band (v10): every row carries an 80% conformal band
//      with lo < implied < hi, one width for all rows, LOO coverage in
//      [70%, 90%], and rank 1's band overlaps rank 2's.
//   2h. Farm-plan depth (v10): step counts vary by row complexity — at
//      least 3 distinct depths present, none outside 3-12 steps.
//   2i. Farm verdict (v11): every row's verdict fields recompute from the
//      row's own numbers — deposit = clamp(0.02% TVL, $100–$25,000),
//      expected drop = farmer share x 7% x implied x odds, gas = chain gas
//      x 6, net = expected - gas, per-hour = net / hours, label FARM >=
//      $25/h, MARGINAL net > 0, else SKIP. Hours recompute from the plan
//      steps' "Time: N minutes" (counted once per step).
//   2j. Evidence table (v11): exactly 3 cumulative rows in order, all
//      LOO/WF finite, the full design beats the flat baseline on BOTH
//      medians, the odds Brier beats the one-global-rate base, and the
//      within-x3 shares are sane (40–60% — the measured values are ~51%).
//   2k. Accounting + checksum (v11): the accounting groups sum to
//      protocols_total (758), board_total_implied_usd equals the sum of the
//      rows' implied values, and board_sha256 equals the sha256 of
//      {"rows": [...]} + "\n" as main.ts computes it.
//   3. The scorer's 7 gate rows, re-implemented here against the first run:
//      dashboard_files, board_file, sorted_by_value, coverage, farm_steps,
//      screenshots, dossier_matches.
// Exit 0 when everything passes, 1 otherwise. Prints one line per check.
//
// This is a dev tool: it exits non-zero on failure. (The entry program
// main.ts itself never exits non-zero — that rule is for the entry, not for
// the harness that tests it.)
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { buildDossier } = await import(join(repoRoot, 'vendor', 'makefun-board.ts'));

const FROZEN_OOS = 2.98;

function flagValue(argv, flag, fallback) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(`--${flag}=`)) return argv[i].slice(flag.length + 3);
  }
  return fallback;
}

const argv = process.argv.slice(2);
const input = flagValue(argv, 'input', '');
const work = flagValue(argv, 'work', mkdtempSync(join(tmpdir(), 'tr-verify-')));
if (!input || !existsSync(input)) {
  console.error('usage: node tools/verify.mjs --input <snapshot.json> [--work <tmp-dir>]');
  process.exit(1);
}

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// 1. Determinism: two runs, byte-identical outputs.
const outA = join(work, 'run-a');
const outB = join(work, 'run-b');
const run = (out) =>
  spawnSync(process.execPath, [join(repoRoot, 'main.ts'), '--input', input], {
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: out },
    encoding: 'utf8',
  });
const ra = run(outA);
const rb = run(outB);
check(
  'exit-0-clean-stderr',
  ra.status === 0 && rb.status === 0 && ra.stderr === '' && rb.stderr === '',
  `run A status=${ra.status} stderr=${ra.stderr.length}B, run B status=${rb.status} stderr=${rb.stderr.length}B`,
);
const boardA = readFileSync(join(outA, 'board.json'));
const boardB = readFileSync(join(outB, 'board.json'));
const dataA = readFileSync(join(outA, 'data.js'));
const dataB = readFileSync(join(outB, 'data.js'));
check(
  'determinism-byte-identical',
  sha(boardA) === sha(boardB) && sha(dataA) === sha(dataB),
  `board ${sha(boardA).slice(0, 12)}… vs ${sha(boardB).slice(0, 12)}…, data ${sha(dataA).slice(0, 12)}… vs ${sha(dataB).slice(0, 12)}…`,
);

// 2. Model frozen: OOS median factor from the built data.js.
const payload = JSON.parse(dataA.toString().replace(/^window\.TOKEN_RADAR = /, '').replace(/;\s*$/, ''));
const oos = payload.meta.oos_median_factor;
check(
  'model-frozen-oos',
  Math.abs(oos - FROZEN_OOS) < 0.005,
  `OOS median factor x${oos.toFixed(2)} (frozen v4 value x${FROZEN_OOS.toFixed(2)})`,
);

// 2b. Walk-forward (v5): a real second held-out test — finite factor, at least
// 10 dated peers, at least 1 window. The neutral fallback (x1.00, 0 peers) would
// fail this on a real snapshot, which is the point.
const wf = payload.meta.walk_forward_median_factor;
const wfOk =
  Number.isFinite(wf) &&
  wf >= 1 &&
  payload.meta.walk_forward_peers >= 10 &&
  payload.meta.walk_forward_windows >= 1;
check(
  'walk_forward',
  wfOk,
  `x${Number(wf).toFixed(2)} median on ${payload.meta.walk_forward_peers} dated peers, ${payload.meta.walk_forward_windows} windows`,
);
const byAge = payload.meta.launch_odds_by_age ?? [];
const byAgeOk =
  byAge.length === 8 &&
  byAge.every((b) => Number.isInteger(b.n) && b.n > 0 && b.rate >= 0 && b.rate <= 1);
check(
  'launch_odds_by_age',
  byAgeOk,
  byAgeOk ? `${byAge.length} bands, all n>0, rates 0-100%` : `by_age malformed (${byAge.length} bands)`,
);

// 2c. Delta vs TVL (v6): the column is display-only — the board carries no
// delta field (the model output stays byte-identical to v5 apart from farm
// text), app.js computes TVL rank from the rows themselves. Check the
// pieces exist and the implied deltas are a permutation (sum 0).
(() => {
  const html = readFileSync(join(repoRoot, 'dashboard', 'index.html'), 'utf8');
  const js = readFileSync(join(repoRoot, 'dashboard', 'app.js'), 'utf8');
  const problems = [];
  if (!/Δ vs TVL/.test(html)) problems.push('no Δ vs TVL header');
  if (!/value="tvl_delta"/.test(html)) problems.push('no tvl_delta sort option');
  if (!/tvl_rank/.test(js) || !/tvl_delta/.test(js)) problems.push('app.js computes no tvl_rank/tvl_delta');
  if (!/TVL rank/.test(js)) problems.push('no TVL-rank explanation in app.js');
  const boardRows = JSON.parse(boardA.toString()).rows;
  const byTvl = [...boardRows].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const deltas = byTvl.map((r, i) => (i + 1) - r.rank);
  const sum = deltas.reduce((a, b) => a + b, 0);
  const lifted = deltas.filter((d) => d > 0).length;
  const dropped = deltas.filter((d) => d < 0).length;
  if (sum !== 0) problems.push(`deltas sum to ${sum}, want 0`);
  check(
    'delta_vs_tvl',
    problems.length === 0,
    problems.length ? problems[0] : `header + sort + computation present; ${lifted} rows lifted, ${dropped} dropped, ${deltas.length - lifted - dropped} agree with TVL sort, deltas sum 0`,
  );
})();

// 2d. Dark mode (v6): full token block, toggle button, pre-paint boot script,
// default light (the static HTML carries no data-theme="dark").
(() => {
  const css = readFileSync(join(repoRoot, 'dashboard', 'app.css'), 'utf8');
  const html = readFileSync(join(repoRoot, 'dashboard', 'index.html'), 'utf8');
  const js = readFileSync(join(repoRoot, 'dashboard', 'app.js'), 'utf8');
  const problems = [];
  const darkBlock = css.match(/html\[data-theme="dark"\]\s*\{([^}]*)\}/s);
  if (!darkBlock) problems.push('no dark token block in app.css');
  else {
    for (const token of ['--paper:', '--card:', '--text:', '--soft:', '--teal:', '--line:']) {
      if (!darkBlock[1].includes(token)) problems.push(`dark block misses ${token}`);
    }
  }
  if (!/id="theme-toggle"/.test(html)) problems.push('no theme toggle button');
  if (!/localStorage\.getItem\('token-radar-theme'\)/.test(html)) problems.push('no pre-paint boot script');
  if (/data-theme="dark"/.test(html)) problems.push('static HTML defaults to dark');
  if (!/setTheme/.test(js) || !/localStorage\.setItem\('token-radar-theme'/.test(js)) problems.push('app.js has no setTheme/persist');
  check(
    'dark_mode',
    problems.length === 0,
    problems.length ? problems[0] : 'dark tokens + toggle + boot script present, default light',
  );
})();

// 2e. Biggest calls (v7): the section + filter + scatter + tables exist in
// the page, and the board's own extremes match the numbers the section will
// show (goonfi +95, reti-pooling -81, 43 rows at |Δ| >= 50).
(() => {
  const html = readFileSync(join(repoRoot, 'dashboard', 'index.html'), 'utf8');
  const js = readFileSync(join(repoRoot, 'dashboard', 'app.js'), 'utf8');
  const css = readFileSync(join(repoRoot, 'dashboard', 'app.css'), 'utf8');
  const problems = [];
  if (!/id="biggest"/.test(html)) problems.push('no #biggest section');
  if (!/id="big"/.test(html)) problems.push('no #big filter checkbox');
  if (!/\|Δ\| ≥ 50/.test(html)) problems.push('filter threshold is not |Δ| ≥ 50');
  if (!/renderBiggest/.test(js)) problems.push('app.js has no renderBiggest');
  if (!/bigOnly/.test(js) || !/Math\.abs\(r\.tvl_delta\) < 50/.test(js)) problems.push('no |Δ| >= 50 filter in visibleRows');
  if (!/biggest-scatter/.test(js) || !/biggest-tables/.test(js)) problems.push('no scatter/tables render targets');
  if (!/slice\(0, 10\)/.test(js)) problems.push('no top-10 slices');
  if (!/\.biggest/.test(css) || !/\.calls-grid/.test(css)) problems.push('no biggest-calls styles');
  const boardRows = JSON.parse(boardA.toString()).rows;
  const byTvl = [...boardRows].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const deltaOf = new Map(byTvl.map((r, i) => [r.slug, (i + 1) - r.rank]));
  const big = [...deltaOf.values()].filter((d) => Math.abs(d) >= 50).length;
  if (deltaOf.get('goonfi') !== 95) problems.push(`goonfi Δ is ${deltaOf.get('goonfi')}, want +95`);
  if (deltaOf.get('reti-pooling') !== -81) problems.push(`reti-pooling Δ is ${deltaOf.get('reti-pooling')}, want -81`);
  if (big !== 43) problems.push(`${big} rows at |Δ| >= 50, want 43`);
  check(
    'biggest_calls',
    problems.length === 0,
    problems.length ? problems[0] : 'section + filter + scatter + top-10 tables present; extremes goonfi +95 / reti-pooling -81; 43 rows at |Δ| >= 50',
  );
})();

// 2f. Headline numbers (v7): the README opens with the numbered headline,
// so its first non-empty line must carry all four figures.
(() => {
  const opening = readFileSync(join(repoRoot, 'README.md'), 'utf8').split('\n').find((l) => l.trim().length > 0) ?? '';
  const headlineNums = ['198', '40', '119', 'x2.98'].filter((n) => opening.includes(n)).length;
  check(
    'readme_headline_numbers',
    headlineNums === 4,
    headlineNums === 4 ? `first non-empty README line carries 198 / 40 / 119 / x2.98` : `first non-empty README line carries ${headlineNums}/4 headline numbers`,
  );
})();

// 2g. Uncertainty band (v10): every row carries an 80% conformal band with
// lo < implied < hi (integers, lo >= 1); one width for all rows (the lo and
// hi ratios are constant up to rounding); LOO coverage in [70%, 90%]; and
// rank 1's band overlaps rank 2's (the "within noise" claim, checked on the
// built board, not on prose).
(() => {
  const problems = [];
  const loRatios = new Set();
  const hiRatios = new Set();
  const boardRows = JSON.parse(boardA.toString()).rows;
  for (const r of boardRows) {
    if (!Number.isInteger(r.implied_lo_usd) || !Number.isInteger(r.implied_hi_usd)) { problems.push(`${r.slug}: band missing`); break; }
    if (!(r.implied_lo_usd >= 1 && r.implied_lo_usd < r.implied_value_usd && r.implied_value_usd < r.implied_hi_usd)) { problems.push(`${r.slug}: band does not bracket the point`); break; }
    loRatios.add((r.implied_lo_usd / r.implied_value_usd).toFixed(4));
    hiRatios.add((r.implied_hi_usd / r.implied_value_usd).toFixed(4));
  }
  const cov = payload.meta.band_loo_coverage;
  if (problems.length === 0 && (typeof cov !== 'number' || cov < 0.7 || cov > 0.9)) problems.push(`LOO coverage ${(cov * 100).toFixed(1)}% outside [70%, 90%]`);
  if (problems.length === 0 && loRatios.size > 2) problems.push(`${loRatios.size} distinct lo ratios, want one width`);
  if (problems.length === 0 && hiRatios.size > 2) problems.push(`${hiRatios.size} distinct hi ratios, want one width`);
  if (problems.length === 0 && payload.meta.band_rank1_overlaps_rank2 !== true) problems.push('rank 1 band does not overlap rank 2');
  const loSeen = [...loRatios][0];
  const hiSeen = [...hiRatios][0];
  if (problems.length === 0 && (Math.abs(Number(loSeen) - payload.meta.band_lo_factor) > 0.002 || Math.abs(Number(hiSeen) - payload.meta.band_hi_factor) > 0.002)) problems.push(`row band ratios lo x${loSeen} / hi x${hiSeen} disagree with meta lo x${payload.meta.band_lo_factor.toFixed(3)} / hi x${payload.meta.band_hi_factor.toFixed(3)}`);
  check(
    'uncertainty_band',
    problems.length === 0,
    problems.length ? problems[0] : `all ${boardRows.length} rows lo < implied < hi, one width (lo x${payload.meta.band_lo_factor.toFixed(3)}, hi x${payload.meta.band_hi_factor.toFixed(3)}), LOO coverage ${(cov * 100).toFixed(1)}%, rank 1 overlaps rank 2`,
  );
})();

// 2h. Farm-plan depth (v10): step counts vary by row complexity — at least
// 3 distinct depths across the board, every row within the gate's 3-12.
(() => {
  const counts = new Map();
  const boardRows = JSON.parse(boardA.toString()).rows;
  for (const r of boardRows) counts.set(r.farm_steps.length, (counts.get(r.farm_steps.length) ?? 0) + 1);
  const desc = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${n}x${s}`).join(', ');
  check(
    'farm_plan_depth',
    counts.size >= 3,
    counts.size >= 3 ? `step depths vary: ${desc}` : `only ${counts.size} distinct step depth(s): ${desc}`,
  );
})();

// 2i. Farm verdict (v11): every row's verdict fields recompute from the
// row's own numbers.
(() => {
  // Same per-transaction gas figures as lib/model.ts CHAIN_GAS_USD.
  const GAS = { Ethereum: 3.0, Base: 0.5, Arbitrum: 0.5, Optimism: 0.5, Solana: 0.02, Binance: 0.2, Tron: 1.0, Polygon: 0.1, Avalanche: 0.3, Sui: 0.05, Aptos: 0.05 };
  const boardRows = JSON.parse(boardA.toString()).rows;
  const counts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  const round2 = (n) => Math.round(n * 100) / 100;
  let bad = null;
  for (const r of boardRows) {
    const deposit = Math.round(Math.min(25000, Math.max(100, 0.0002 * r.tvl_usd)) * 100) / 100;
    const share = (deposit * 180) / (r.tvl_usd * 365);
    const expectedRaw = share * 0.07 * r.implied_value_usd * (r.launch_odds ?? 0);
    const gasRaw = (GAS[r.chains[0]] ?? 1.0) * 6;
    const minutes = r.farm_steps.reduce((s, step) => {
      const m = /Time: (\d+) minutes/.exec(step);
      return s + (m ? parseInt(m[1], 10) : 0);
    }, 0);
    // The model rounds each stored field, but per-hour is the UNROUNDED
    // net over the UNROUNDED hours, rounded last — match that order.
    const expected = round2(expectedRaw);
    const gas = round2(gasRaw);
    const hours = round2(minutes / 60);
    const net = round2(expectedRaw - gasRaw);
    const perHour = round2((expectedRaw - gasRaw) / (minutes / 60));
    const label = perHour >= 25 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
    counts[label] = (counts[label] ?? 0) + 1;
    const close = (a, b) => Math.abs(a - b) <= 0.011;
    if (r.farm_deposit_usd !== deposit || !close(r.farm_expected_drop_usd, expected) || !close(r.farm_gas_usd, gas)
      || !close(r.farm_hours, hours) || !close(r.farm_net_usd, net) || !close(r.farm_net_per_hour_usd, perHour) || r.verdict !== label) {
      bad = `${r.slug}: verdict fields do not recompute (want ${label} deposit $${deposit} expected $${expected} gas $${gas} ${hours}h net $${net} $${perHour}/h, got ${r.verdict} deposit $${r.farm_deposit_usd} expected $${r.farm_expected_drop_usd} gas $${r.farm_gas_usd} ${r.farm_hours}h net $${r.farm_net_usd} $${r.farm_net_per_hour_usd}/h)`;
      break;
    }
  }
  check(
    'farm_verdict',
    bad === null,
    bad ?? `all ${boardRows.length} rows recompute: FARM ${counts.FARM}, MARGINAL ${counts.MARGINAL}, SKIP ${counts.SKIP}`,
  );
})();

// 2j. Evidence table (v11): 3 cumulative rows, full beats flat on both
// medians, Brier beats the base rate, within-x3 shares sane.
(() => {
  const meta = payload.meta;
  const ev = meta.evidence;
  const problems = [];
  if (!Array.isArray(ev) || ev.length !== 3) problems.push(`evidence has ${Array.isArray(ev) ? ev.length : 'no'} rows, want 3`);
  else {
    const terms = ['flat median multiple', '+ size curve, in TVL', '+ family effect'];
    ev.forEach((e, i) => {
      if (e.term !== terms[i]) problems.push(`row ${i} term "${e.term}" != "${terms[i]}"`);
      if (!Number.isFinite(e.loo) || !Number.isFinite(e.wf) || e.loo <= 0 || e.wf <= 0) problems.push(`row ${i} has a non-finite or non-positive factor`);
    });
    if (problems.length === 0) {
      if (!(ev[2].loo < ev[0].loo && ev[2].wf < ev[0].wf)) problems.push(`full (LOO x${ev[2].loo.toFixed(2)} / WF x${ev[2].wf.toFixed(2)}) does not beat flat (x${ev[0].loo.toFixed(2)} / x${ev[0].wf.toFixed(2)}) on both medians`);
      if (!(meta.odds_brier < meta.odds_brier_base)) problems.push(`odds Brier ${meta.odds_brier} does not beat base ${meta.odds_brier_base}`);
      if (!(meta.oos_within3 >= 0.4 && meta.oos_within3 <= 0.6 && meta.wf_within3 >= 0.4 && meta.wf_within3 <= 0.6)) problems.push(`within-x3 shares out of range: OOS ${meta.oos_within3}, WF ${meta.wf_within3}`);
    }
  }
  check(
    'evidence_table',
    problems.length === 0,
    problems.length ? problems[0] : `flat x${ev[0].loo.toFixed(2)}/x${ev[0].wf.toFixed(2)} → size x${ev[1].loo.toFixed(2)}/x${ev[1].wf.toFixed(2)} → full x${ev[2].loo.toFixed(2)}/x${ev[2].wf.toFixed(2)}, Brier ${meta.odds_brier.toFixed(3)} < base ${meta.odds_brier_base.toFixed(3)}, within-x3 ${Math.round(meta.oos_within3 * 100)}%/${Math.round(meta.wf_within3 * 100)}%`,
  );
})();

// 2k. Accounting + checksum (v11): groups sum to the snapshot total, the
// board total equals the sum of the rows, the checksum recomputes.
(() => {
  const meta = payload.meta;
  const boardRows = JSON.parse(boardA.toString()).rows;
  const problems = [];
  const acctTotal = Array.isArray(meta.accounting) ? meta.accounting.reduce((s, a) => s + a.count, 0) : -1;
  if (acctTotal !== meta.protocols_total) problems.push(`accounting sums to ${acctTotal}, not ${meta.protocols_total}`);
  const total = boardRows.reduce((s, r) => s + r.implied_value_usd, 0);
  if (Math.abs(total - meta.board_total_implied_usd) > 1) problems.push(`board total ${meta.board_total_implied_usd} != sum of rows ${total}`);
  const recomputed = createHash('sha256').update(JSON.stringify({ rows: boardRows }) + '\n').digest('hex');
  if (recomputed !== meta.board_sha256) problems.push(`board checksum ${recomputed.slice(0, 8)} != meta ${String(meta.board_sha256).slice(0, 8)}`);
  check(
    'accounting_checksum',
    problems.length === 0,
    problems.length ? problems[0] : `accounting ${acctTotal}/${meta.protocols_total}, board total $${total.toLocaleString('en-US')}, checksum ${recomputed.slice(0, 8)} matches`,
  );
})();

// 3. The 7 gate rows against run A.
const snap = JSON.parse(readFileSync(input, 'utf8'));
const snapSlugs = new Set(snap.protocols.map((p) => p.slug));
const rows = JSON.parse(boardA.toString()).rows;
const outDir = outA;

(() => {
  const dashDir = join(outDir, 'dashboard');
  const files = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(dashDir, '');
  const totalBytes = files.reduce((n, f) => n + statSync(join(dashDir, f)).size, 0);
  const nameOk = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
  const badName = files.find((f) => !nameOk.test(f.split('/').pop()));
  let netRef = null;
  for (const f of files) {
    const text = readFileSync(join(dashDir, f), 'utf8');
    if (f.endsWith('.html') && /(href|src|action)\s*=\s*["']https?:\/\//i.test(text)) { netRef = `${f}: network ref`; break; }
    if (f.endsWith('.css') && /https?:\/\//.test(text)) { netRef = `${f}: network address in CSS`; break; }
    if (f.endsWith('.js') && /(import\s+[^'"]*from\s*|require\s*\(\s*|import\s*\()\s*["']https?:\/\//.test(text)) { netRef = `${f}: network address in JS import`; break; }
  }
  check(
    'dashboard_files',
    !badName && files.includes('index.html') && files.some((f) => f.endsWith('.css')) &&
      files.some((f) => f.endsWith('.js')) && files.length <= 400 && totalBytes <= 4 * 1024 * 1024 && netRef === null,
    badName ?? netRef ?? `${files.length} files, ${totalBytes} bytes, index + .css + .js, no network refs`,
  );
})();

(() => {
  const size = statSync(join(outDir, 'board.json')).size;
  const bad = [];
  if (!Array.isArray(rows) || rows.length < 100 || rows.length > 4000) bad.push(`rows=${rows.length}`);
  if (size > 8 * 1024 * 1024) bad.push(`size=${size}`);
  const seen = new Set();
  for (const r of rows) {
    if (!snapSlugs.has(r.slug)) { bad.push(`invented slug ${r.slug}`); break; }
    if (typeof r.name !== 'string' || r.name.trim() === '') { bad.push(`${r.slug}: empty name`); break; }
    if (!Number.isInteger(r.rank) || r.rank <= 0) { bad.push(`${r.slug}: bad rank`); break; }
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) { bad.push(`${r.slug}: bad implied`); break; }
    if (!Array.isArray(r.farm_steps)) { bad.push(`${r.slug}: farm_steps not array`); break; }
    if (seen.has(r.slug)) { bad.push(`duplicate slug ${r.slug}`); break; }
    seen.add(r.slug);
  }
  if (rows.length > 1 && rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd)) bad.push('all implied equal');
  check('board_file', bad.length === 0, bad.length ? bad[0] : `${rows.length} rows, ${size} bytes, all slugs in snapshot`);
})();

// 3b. Launch odds (v5): every row carries a cohort rate in [0, 1] with a
// non-empty cohort, a real level, and a note a reader can check.
(() => {
  const LEVELS = new Set(['age+family', 'age', 'family', 'global']);
  let bad = null;
  for (const r of rows) {
    if (typeof r.launch_odds !== 'number' || r.launch_odds < 0 || r.launch_odds > 1) { bad = `${r.slug}: launch_odds ${r.launch_odds}`; break; }
    if (!Number.isInteger(r.launch_odds_n) || r.launch_odds_n < 1) { bad = `${r.slug}: launch_odds_n ${r.launch_odds_n}`; break; }
    if (!LEVELS.has(r.launch_odds_level)) { bad = `${r.slug}: level ${r.launch_odds_level}`; break; }
    if (typeof r.launch_odds_note !== 'string' || r.launch_odds_note.length < 20) { bad = `${r.slug}: note too short`; break; }
  }
  check('launch_odds', bad === null, bad ?? `all ${rows.length} rows 0-100% with n>=1, level age+family/age/family/global, note present`);
})();

(() => {
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  const ranksOk = ranks.every((r, i) => r === i + 1);
  let sorted = true;
  let prev = Infinity;
  for (const r of [...rows].sort((a, b) => a.rank - b.rank)) {
    if (r.implied_value_usd > prev) { sorted = false; break; }
    prev = r.implied_value_usd;
  }
  check('sorted_by_value', ranksOk && sorted, ranksOk && sorted ? `ranks 1..${rows.length}, implied non-increasing` : `ranksOk=${ranksOk} sorted=${sorted}`);
})();

(() => {
  const have = new Set(rows.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !have.has(s));
  check('coverage', missing.length === 0, missing.length === 0 ? `watchlist ${snap.watchlist.length}/${snap.watchlist.length}` : `missing: ${missing.slice(0, 5).join(', ')}`);
})();

(() => {
  let bad = null;
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) { bad = `${r.slug}: ${r.farm_steps.length} steps`; break; }
    for (const s of r.farm_steps) {
      const t = String(s).trim();
      if (t.length < 20 || t.length > 600) { bad = `${r.slug}: step ${t.length} chars`; break; }
    }
    if (bad) break;
  }
  check('farm_steps', bad === null, bad ?? `all ${rows.length} rows 3-12 steps, each 20-600 chars`);
})();

(() => {
  const shotDir = join(outDir, 'screenshots');
  const names = existsSync(shotDir)
    ? readdirSync(shotDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name)
    : [];
  const nameOk = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
  const bad = [];
  if (names.length < 3 || names.length > 4) bad.push(`${names.length} images (want 3-4)`);
  for (const n of names) {
    const buf = readFileSync(join(shotDir, n));
    const size = statSync(join(shotDir, n)).size;
    if (!nameOk.test(n)) { bad.push(`${n}: bad name`); continue; }
    if (size > 524288) { bad.push(`${n}: ${size} bytes > 512 KiB`); continue; }
    const png = buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (!png && !jpg) { bad.push(`${n}: not whole PNG/JPEG`); continue; }
    if (png && !buf.subarray(buf.length - 12).includes(Buffer.from('IEND'))) { bad.push(`${n}: PNG without IEND`); continue; }
    const dims = png ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null;
    if (png && dims) {
      const [w, h] = dims;
      if (Math.max(w, h) > 1440 || Math.min(w, h) < 800) { bad.push(`${n}: ${w}x${h}`); continue; }
    }
  }
  check('screenshots', bad.length === 0, bad.length ? bad[0] : `${names.length} images, whole, <=512 KiB, long<=1440 short>=800`);
})();

(() => {
  const dossier = readFileSync(join(outDir, 'dossier.json'));
  const rebuilt = buildDossier(outDir, { text_max_bytes: 65536 });
  const same = Buffer.from(rebuilt).equals(dossier);
  check('dossier_matches', same && dossier.length <= 1.5 * 1024 * 1024,
    same ? `byte-identical to buildDossier({text_max_bytes: 65536}), ${dossier.length} bytes` : 'dossier differs from rebuild');
})();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
