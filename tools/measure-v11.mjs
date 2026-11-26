// tools/measure-v11.mjs — layout measurements for the v11 presentation fixes.
// (Node 22, stdlib + playwright-core from the workspace, like tools/shots.mjs.)
// Usage: node tools/measure-v11.mjs <out-dir>
// Reports, at 1440x900:
//   * topbar height (for the drawer offset fix)
//   * shot 1: table top y + fully visible board rows (v10: 6 rows;
//     v11 target 7 — the hero was tightened and the protocol sub went
//     single-line so the new accounting/evidence/integrity strips above the
//     table do not eat the row budget)
//   * shot 2 (dark detail): is any topbar text hidden behind the drawer?
//     Plus the v11 drawer checks: Δ column fully left of the 400px drawer,
//     launch odds + farm verdict + farm plan heading + ≥3 plan steps all
//     inside the drawer body after the scroll.
//   * shot 3: scatter-label bounding boxes — pairwise overlaps (want 0),
//     labels overflowing the SVG (want 0), label-vs-dot overlaps (want 0:
//     v11 labels live in reserved bands outside the plot, so any dot under
//     a label is a layout bug, not crowding).
// Exit 0 when all of the above hold; exit 1 otherwise.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = process.argv[2];
if (!outDir) { console.error('usage: node tools/measure-v11.mjs <out-dir>'); process.exit(1); }

let firefox;
try {
  ({ firefox } = await import('playwright-core'));
} catch {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [join(here, '..', '..', 'shot-tools'), join(here, '..', '..'), join(here, '..')];
  let resolved = null;
  for (const dir of candidates) {
    try { resolved = require.resolve('playwright-core', { paths: [dir] }); break; } catch { /* next */ }
  }
  if (resolved === null) { console.error('playwright-core not found'); process.exit(1); }
  ({ firefox } = require(resolved));
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = join(outDir, path === '' ? 'index.html' : path);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text().slice(0, 200)); });

let failed = false;
// Shot 1: hero + table.
await page.goto(`http://127.0.0.1:${port}/dashboard/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('#rows tr').length > 0, null, { timeout: 30000 });
const s1 = await page.evaluate(() => {
  const topbar = document.querySelector('.topbar').getBoundingClientRect();
  const thead = document.querySelector('#board thead').getBoundingClientRect();
  const rows = [...document.querySelectorAll('#rows tr')].map((tr) => tr.getBoundingClientRect());
  const full = rows.filter((r) => r.bottom <= 900 && r.top >= 0).length;
  const partial = rows.filter((r) => r.top < 900 && r.bottom > 900).length;
  const bandCells = [...document.querySelectorAll('#rows tr td.band')].length;
  const bandSample = document.querySelector('#rows tr td.band')?.textContent ?? '';
  const evidenceRows = document.querySelectorAll('.evidence-table tbody tr').length;
  const evidenceNote = document.querySelector('.evidence .chart-note')?.textContent ?? '';
  return {
    topbarHeight: Math.round(topbar.height),
    tableTop: Math.round(thead.top),
    fullRows: full, partialRows: partial,
    bandCells, bandSample,
    evidenceRows, evidenceHasBrier: /Brier/.test(evidenceNote),
  };
});
console.log(`shot 1: topbar ${s1.topbarHeight}px, table top y=${s1.tableTop}, fully visible rows=${s1.fullRows} (+${s1.partialRows} partial), band cells=${s1.bandCells} (sample "${s1.bandSample}"), evidence rows=${s1.evidenceRows}, evidence Brier line=${s1.evidenceHasBrier}`);
if (s1.fullRows < 7) { console.log('  FAIL: fewer than 7 fully visible rows'); failed = true; }
if (s1.evidenceRows !== 3 || !s1.evidenceHasBrier) { console.log('  FAIL: evidence table missing or incomplete above the board'); failed = true; }

// Shot 2: dark detail — is topbar text covered by the drawer?
await page.goto(`http://127.0.0.1:${port}/dashboard/index.html#detail=sentora-curator&theme=dark`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.getElementById('drawer').hidden, null, { timeout: 30000 });
// (f) v11 — same scroll as shots.mjs: drawer to the Launch odds section.
await page.evaluate(() => {
  const h = [...document.querySelectorAll('.drawer-body h3')].find((el) => el.textContent === 'Launch odds');
  h?.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(300);
const s2 = await page.evaluate(() => {
  const drawer = document.getElementById('drawer').getBoundingClientRect();
  const topbar = document.querySelector('.topbar').getBoundingClientRect();
  // Every topbar child: is its box overlapped by the drawer box?
  const covered = [];
  document.querySelectorAll('.topbar *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const overlapX = Math.max(0, Math.min(r.right, drawer.right) - Math.max(r.left, drawer.left));
    const overlapY = Math.max(0, Math.min(r.bottom, drawer.bottom) - Math.max(r.top, drawer.top));
    if (overlapX > 2 && overlapY > 2) covered.push(`${el.tagName}.${el.className || el.id} (${Math.round(overlapX)}x${Math.round(overlapY)}px)`);
  });
  const head = document.querySelector('.drawer-head').getBoundingClientRect();
  const rank = document.getElementById('drawer-rank').textContent;
  const bandRow = [...document.querySelectorAll('.drawer-body .kv dt')].some((dt) => dt.textContent === '80% band');
  const note = document.querySelector('.drawer-body')?.textContent.includes('within noise') ?? false;
  // v11 drawer checks: Δ column fully left of the drawer; launch odds +
  // verdict + farm plan + ≥3 steps visible inside the drawer body.
  const body = document.querySelector('.drawer-body');
  const bodyBox = body.getBoundingClientRect();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= bodyBox.top - 2 && r.bottom <= bodyBox.bottom + 2 && r.height > 0;
  };
  const h3s = [...document.querySelectorAll('.drawer-body h3')].map((el) => el.textContent);
  const farmPlanH = [...document.querySelectorAll('.drawer-body h3')].find((el) => el.textContent === 'Farm plan');
  const stepsVisible = [...document.querySelectorAll('.drawer-body ol.plan li')].filter(visible).length;
  const launchOddsVisible = [...document.querySelectorAll('.drawer-body p.note')].some((p) => /base rate/.test(p.textContent) && visible(p));
  const verdictSection = h3s.some((t) => t.startsWith('Farm verdict'));
  const expectedValueRow = [...document.querySelectorAll('.drawer-body .kv dt')].some((dt) => dt.textContent === 'Expected value');
  const deltaTh = [...document.querySelectorAll('#board thead th')].find((th) => /Δ/.test(th.textContent));
  const deltaCell = document.querySelector('#rows tr td.delta');
  const leftOfDrawer = (el) => Boolean(el) && el.getBoundingClientRect().right <= drawer.left + 1;
  return {
    drawerTop: Math.round(drawer.top), drawerLeft: Math.round(drawer.left), topbarBottom: Math.round(topbar.bottom),
    covered, rank, bandRow, note,
    drawerWidth: Math.round(drawer.width),
    deltaHeaderVisible: leftOfDrawer(deltaTh), deltaCellVisible: leftOfDrawer(deltaCell),
    farmPlanVisible: visible(farmPlanH), stepsVisible, launchOddsVisible, verdictSection, expectedValueRow,
  };
});
console.log(`shot 2: drawer top=${s2.drawerTop} (topbar bottom=${s2.topbarBottom}), width=${s2.drawerWidth}px, topbar elements covered by drawer: ${s2.covered.length ? s2.covered.join(' | ') : 'none'}, drawer rank="${s2.rank}", band row=${s2.bandRow}, noise note=${s2.note}`);
console.log(`  drawer v11: Δ header visible=${s2.deltaHeaderVisible}, Δ cell visible=${s2.deltaCellVisible}, farm plan heading visible=${s2.farmPlanVisible}, plan steps visible=${s2.stepsVisible}, launch odds visible=${s2.launchOddsVisible}, verdict section=${s2.verdictSection}, expected-value row=${s2.expectedValueRow}`);
if (s2.covered.length > 0) { console.log('  FAIL: drawer still covers topbar text'); failed = true; }
if (!s2.deltaHeaderVisible || !s2.deltaCellVisible) { console.log('  FAIL: drawer still covers the Δ column'); failed = true; }
if (!s2.farmPlanVisible || s2.stepsVisible < 3 || !s2.launchOddsVisible || !s2.verdictSection || !s2.expectedValueRow) { console.log('  FAIL: drawer content not fully visible after scroll'); failed = true; }

// Shot 3: biggest-calls labels.
await page.goto(`http://127.0.0.1:${port}/dashboard/index.html#big=1&theme=light`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('#rows tr').length > 0, null, { timeout: 30000 });
await page.evaluate(() => document.querySelector('#biggest')?.scrollIntoView());
await page.waitForTimeout(400);
const s3 = await page.evaluate(() => {
  const svg = document.querySelector('#biggest-scatter svg');
  const svgBox = svg.getBoundingClientRect();
  const labels = [...document.querySelectorAll('#biggest-scatter .scatter-label')].map((t) => {
    const r = t.getBoundingClientRect();
    return { name: t.dataset.name, x: r.left - svgBox.left, y: r.top - svgBox.top, w: r.width, h: r.height, right: r.right - svgBox.left, bottom: r.bottom - svgBox.top };
  });
  const overlaps = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]; const b = labels[j];
      if (a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom) overlaps.push(`${a.name} x ${b.name}`);
    }
  }
  const overflow = labels.filter((l) => l.x < 0 || l.right > svgBox.width || l.y < 0 || l.bottom > svgBox.height).map((l) => l.name);
  // Label rect vs dot centres (dots r=3.5): count dots whose centre falls
  // inside a label's box — informational, dots are dense at the top.
  const dots = [...document.querySelectorAll('#biggest-scatter svg circle')].map((c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2 - svgBox.left, y: r.top + r.height / 2 - svgBox.top };
  });
  let dotHits = 0;
  for (const d of dots) {
    if (labels.some((l) => d.x >= l.x - 2 && d.x <= l.right + 2 && d.y >= l.y - 2 && d.y <= l.bottom + 2)) dotHits++;
  }
  return { labels: labels.map((l) => `${l.name} (${Math.round(l.x)},${Math.round(l.y)} ${Math.round(l.w)}x${Math.round(l.h)})`), overlaps, overflow, dotHits, dots: dots.length };
});
console.log(`shot 3: ${s3.labels.length} labels: ${s3.labels.join(' | ')}`);
console.log(`  label overlaps: ${s3.overlaps.length ? s3.overlaps.join(', ') : '0'}; overflowing labels: ${s3.overflow.length ? s3.overflow.join(', ') : '0'}; dots under labels: ${s3.dotHits}/${s3.dots}`);
if (s3.overlaps.length > 0 || s3.overflow.length > 0 || s3.dotHits > 0) { console.log('  FAIL: label collision, overflow, or a dot under a label (v11 bands must keep labels off the plot)'); failed = true; }

console.log(`JS errors: ${jsErrors.length}${jsErrors.length ? ' — ' + jsErrors.slice(0, 5).join(' | ') : ''}`);
if (jsErrors.length > 0) failed = true;
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
