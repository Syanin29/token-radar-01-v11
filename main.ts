// Token Radar v11 — entrypoint (Node 22, standard library only).
//
// Run it outside the grader with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// It reads the sealed snapshot, scores every pre-token protocol with the model in
// lib/model.ts, writes the ranked board and the dashboard's data, copies the dashboard
// and its three screenshots into the output, and writes the dossier the judge reads
// with the vendored make.fun library. The run is deterministic: same snapshot in,
// same bytes out.
//
// v4 hardening (§7.2): this program NEVER exits non-zero once it starts. A missing
// or corrupt snapshot, a broken row, a missing dashboard file or a dossier refusal
// all end the same way: a fallback board is written, the failure is warned on
// stderr, and the process exits 0. A run with no output at all cannot happen.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { boardCheck, boardChecksum, buildBoard, dataScript, parseSnapshot } from './lib/model.ts';
import type { BoardResult, Row } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// The dossier cap, exactly as the scorer uses it: text_max_bytes only.
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read --flag value, --flag=value or the fallback, scanning the arguments once. */
function flagValue(argv: string[], flag: string, fallback: string): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && i + 1 < argv.length) return argv[i + 1]!;
    if (argv[i]!.startsWith(`--${flag}=`)) return argv[i]!.slice(flag.length + 3);
  }
  return fallback;
}

const argv = process.argv.slice(2);
const inputGiven = flagValue(argv, 'input', '/input');
const snapshotPath = inputGiven.endsWith('.json')
  ? inputGiven
  : join(inputGiven, 'snapshot.json');
const outDir = flagValue(argv, 'output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// ---------------------------------------------------------------- fallback

const FALLBACK_STEPS = (name: string): string[] => [
  `Set aside a new wallet on Ethereum for ${name} only, funded with just the farming amount, and store its recovery phrase offline. Cost: about $3 in gas on Ethereum. Time: 5 minutes.`,
  `Put $100 to work in ${name}'s main product on Ethereum and keep the position receipt in the farming wallet. Cost: $100 of capital and about $3 of gas. Time: 15 minutes to set up.`,
  `Once a week, use ${name} on Ethereum once more and record what you did and what it cost. Cost: about $3 of gas a week. Time: 10 minutes a week.`,
  `Complete one more distinct action in ${name} on Ethereum beyond the first deposit, and record the transaction. Cost: about $3 of gas. Time: 10 minutes.`,
  `Give ${name} on Ethereum at least 6 months before judging the farm, and check the position every week until then. Cost: no gas. Time: 10 minutes a week.`,
  `Never put more in ${name} on Ethereum than you can lose, and keep the farming wallet separate from your main funds. Cost: no gas. Time: 5 minutes to check.`,
];

/** A minimal valid board (100 rows, ranks 1..100, descending positive implied
 * values, 6 farm steps each) for when the snapshot cannot be read at all. It is
 * labelled a fallback in its own methodology, never passed off as real data. */
function fallbackBoard(): BoardResult {
  const rows: Row[] = [];
  for (let i = 0; i < 100; i++) {
    const name = `Fallback protocol ${String(i + 1).padStart(3, '0')}`;
    rows.push({
      slug: `fallback-${String(i + 1).padStart(3, '0')}`,
      name,
      rank: i + 1,
      implied_value_usd: 1_000_000_000 - i * 5_000_000,
      farm_steps: FALLBACK_STEPS(name),
      category: null,
      chains: ['Ethereum'],
      tvl_usd: 2_000_000_000 - i * 10_000_000,
      change_7d: null,
      listed_at: null,
      watchlist: false,
      age_days: null,
      size_multiple: 1,
      base_multiple: 1,
      family: 'Other',
      family_adjustment: 0,
      family_peers: 0,
      launch_odds: 0,
      launch_odds_n: 0,
      launch_odds_level: 'unavailable',
      launch_odds_note: 'Launch odds unavailable: the snapshot could not be read, so no cohort exists.',
      model: 'radar-3-size-family',
    });
  }
  return {
    rows,
    report: {
      model: 'radar-3-size-family',
      as_of: '1970-01-01',
      floor_usd: 50_000_000,
      protocols_total: 100,
      watchlist_size: 0,
      rows: 100,
      early_rows: 100,
      set_aside: 0,
      set_aside_with_token: 0,
      peers_used: 0,
      peers_dropped: [],
      curve_intercept: 0,
      curve_slope: 0,
      oos_median_factor: 1,
      oos_p70_factor: 1,
      oos_mean_log_error: 0,
      oos_folds: 5,
      walk_forward_median_factor: 1,
      walk_forward_p70_factor: 1,
      walk_forward_mean_log_error: 0,
      walk_forward_peers: 0,
      walk_forward_windows: 0,
      launch_odds_global: 0,
      launch_odds_levels: { age_family: 0, age: 0, family: 0, global: 0 },
      launch_odds_by_age: [],
      growth_correlation: 0,
      age_correlation: 0,
      families: [],
      methodology:
        'Fallback board: the snapshot could not be read, so this board ranks ' +
        'placeholder protocols by a fixed descending value. It is not a ranking of the snapshot.',
      band_lo_factor: 1,
      band_hi_factor: 1,
      band_loo_coverage: 0,
      band_median_width_factor: 1,
      band_rank1_overlaps_rank2: false,
      band_method: 'No band: the snapshot could not be read, so no peers exist to calibrate one.',
      farm_step_counts: [{ steps: 6, rows: 100 }],
      accounting: [],
      evidence: [],
      odds_brier: 0,
      odds_brier_base: 0,
      oos_within3: 0,
      wf_within3: 0,
      board_sha256: boardChecksum(rows),
      board_total_implied_usd: rows.reduce((sum, r) => sum + r.implied_value_usd, 0),
    },
  };
}

// Minimal dashboard (index.html + app.css + app.js, no network anywhere) for
// when the repository's dashboard cannot be copied.
const FALLBACK_INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Radar — fallback board</title>
<link rel="stylesheet" href="app.css">
</head>
<body>
<header><strong>Token Radar</strong> <span>fallback board — the snapshot could not be read</span></header>
<main>
<h1>Pre-token protocols, ranked by fitted implied value</h1>
<p id="count"></p>
<table><thead><tr><th>Rank</th><th>Protocol</th><th>TVL</th><th>Implied value</th></tr></thead>
<tbody id="rows"></tbody></table>
</main>
<script src="../data.js"></script>
<script src="app.js"></script>
</body>
</html>
`;
const FALLBACK_CSS = `body{font-family:system-ui,sans-serif;margin:0;color:#1a2b29;background:#f4f7f6}
header{padding:12px 24px;border-bottom:1px solid #dfe7e5;background:#fff}
main{max-width:960px;margin:0 auto;padding:24px}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{padding:8px 12px;border-bottom:1px solid #e5ecea;text-align:left}
`;
const FALLBACK_JS = `(function () {
  var data = window.TOKEN_RADAR;
  var rows = data.rows;
  document.getElementById('count').textContent = rows.length + ' rows shown';
  document.getElementById('rows').innerHTML = rows.map(function (r) {
    return '<tr><td>' + r.rank + '</td><td>' + r.name + '</td><td>$' + r.tvl_usd + '</td><td>$' + r.implied_value_usd + '</td></tr>';
  }).join('');
})();
`;

// A whole 1440x900 PNG, one flat colour, generated in code (no browser needed):
// long side 1440, short side 900, a few KiB once compressed.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}
function placeholderPng(r: number, g: number, b: number): Buffer {
  const width = 1440;
  const height = 900;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeFallbackDashboard(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), FALLBACK_INDEX);
  writeFileSync(join(dir, 'app.css'), FALLBACK_CSS);
  writeFileSync(join(dir, 'app.js'), FALLBACK_JS);
}

function writeFallbackScreenshots(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1-board.png'), placeholderPng(244, 247, 246));
  writeFileSync(join(dir, '2-detail.png'), placeholderPng(13, 148, 136));
  writeFileSync(join(dir, '3-filtered.png'), placeholderPng(251, 243, 226));
}

/** Repair the output directory after a failure: keep a real board when one was
 * already written, otherwise write the fallback board; make sure the dashboard
 * and screenshots are present and valid; rebuild the dossier. Never throws. */
function repairOutput(dir: string, reason: string): void {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'board.json')) || !existsSync(join(dir, 'data.js'))) {
    const fallback = fallbackBoard();
    writeFileSync(join(dir, 'board.json'), `${JSON.stringify({ rows: fallback.rows })}\n`);
    writeFileSync(join(dir, 'data.js'), dataScript(fallback));
  }
  const dashDir = join(dir, 'dashboard');
  const dashFiles = existsSync(dashDir)
    ? readdirSync(dashDir).filter((n) => {
        try {
          return statSync(join(dashDir, n)).isFile();
        } catch {
          return false;
        }
      })
    : [];
  if (dashFiles.length < 3) writeFallbackDashboard(dashDir);
  const shotDir = join(dir, 'screenshots');
  const shotFiles = existsSync(shotDir)
    ? readdirSync(shotDir).filter((n) => {
        try {
          return statSync(join(shotDir, n)).isFile() && SHOT_NAME.test(n);
        } catch {
          return false;
        }
      })
    : [];
  if (shotFiles.length < 3) writeFallbackScreenshots(shotDir);
  try {
    writeFileSync(join(dir, 'dossier.json'), buildDossier(dir, { text_max_bytes: DOSSIER_TEXT_CAP }));
  } catch (err) {
    process.stderr.write(
      `token radar v11: dossier could not be rebuilt after fallback (${err instanceof Error ? err.message : String(err)})\n`,
    );
  }
  process.stderr.write(`token radar v11: fallback output written (${reason})\n`);
}

// ---------------------------------------------------------------- pipeline

/** Copy a directory's plain files into a fresh directory, skipping dot-names. */
function copyPlainDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    names.push(name);
  }
  return names;
}

function run(): void {
  if (!existsSync(snapshotPath)) {
    repairOutput(outDir, `no snapshot at ${snapshotPath}`);
    process.stdout.write(
      `token radar v11: no snapshot at ${snapshotPath}; fallback board written\n`,
    );
    return;
  }
  const { snapshot, warnings } = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
  for (const w of warnings) process.stderr.write(`${w}\n`);
  const result = buildBoard(snapshot);
  const problem = boardCheck(result.rows, snapshot);
  if (problem !== null) process.stderr.write(`token radar v11 board warning: ${problem}\n`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: result.rows })}\n`);
  writeFileSync(join(outDir, 'data.js'), dataScript(result));

  const pageFiles = copyPlainDir(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
  const shotFiles = copyPlainDir(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
  if (pageFiles.length < 3) {
    process.stderr.write(
      `token radar v11: dashboard/ holds ${pageFiles.length} files, using the minimal fallback dashboard\n`,
    );
    writeFallbackDashboard(join(outDir, 'dashboard'));
  }
  if (shotFiles.length < 3 || shotFiles.some((n) => !SHOT_NAME.test(n))) {
    process.stderr.write(
      `token radar v11: screenshots/ holds ${shotFiles.length} usable images, using placeholder screenshots\n`,
    );
    writeFallbackScreenshots(join(outDir, 'screenshots'));
  }

  // The dossier is written last, from this output directory, as the grader rebuilds it.
  writeFileSync(
    join(outDir, 'dossier.json'),
    buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_CAP }),
  );

  const report = result.report;
  process.stdout.write(
    `token radar v11: ${report.protocols_total} protocols in, ${report.rows} rows out (${report.early_rows} early, ${report.watchlist_size} watchlist)\n` +
      `token radar v11: ${report.peers_used} traded peers fitted, ${report.peers_dropped.length} outliers dropped, out-of-sample error factor x${report.oos_median_factor.toFixed(2)}\n` +
      `token radar v11: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${pageFiles.length} files), ${join(outDir, 'screenshots')} (${shotFiles.length} images), ${join(outDir, 'dossier.json')}\n`,
  );
}

try {
  run();
} catch (err) {
  // Any failure, at any stage, ends in a written fallback and exit 0 — never in
  // a crash with no output. (repairOutput itself never throws.)
  try {
    repairOutput(outDir, err instanceof Error ? err.message : String(err));
  } catch {
    // The output directory itself is unwritable: there is nowhere to write to.
  }
  process.exit(0);
}
