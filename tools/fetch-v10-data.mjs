// tools/fetch-v10-data.mjs — fetch raw DefiLlama data for v10 candidates.
// Fetches, for every snapshot slug needed (119 fitted peers + 198 board
// candidates = 317 slugs):
//   GET https://api.llama.fi/summary/fees/{slug}  -> tools/data/fees-{slug}.json
//   GET https://api.llama.fi/protocol/{slug}      -> tools/data/protocol-{slug}.json
// Via the egress proxy with the hatch CA bundle (curl). HTTP 400/404 on fees
// means "no fees adapter" — recorded in the manifest, NOT retried as an error.
// /protocol 400/404 means no TVL series — recorded the same way.
// Raw responses are cached verbatim so every later step is reproducible
// offline from tools/data/. Re-runs skip slugs already cached with HTTP 200
// (or a recorded 400/404 in the manifest).
// Usage: node tools/fetch-v10-data.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(root, 'tools', 'data');
mkdirSync(dataDir, { recursive: true });
const snap = JSON.parse(readFileSync('/home/hatch/workspace/makefun/token-radar-01-kit/input/snapshot.json', 'utf8'));

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
const peers = snap.protocols.filter((p) => {
  if (p.mcap_usd === null || !Number.isFinite(p.tvl_usd) || p.tvl_usd <= 0) return false;
  const m = p.mcap_usd / p.tvl_usd;
  return Number.isFinite(m) && m >= 0.001 && m <= 10;
});
const board = snap.protocols.filter((p) => passesScreen(p) && Number.isFinite(p.tvl_usd) && p.tvl_usd > 0);
const slugs = [...new Set([...peers.map((p) => p.slug), ...board.map((p) => p.slug)])];
console.log(`slugs to fetch: ${slugs.length} (${peers.length} peers + ${board.length} board)`);

const manifestPath = join(dataDir, 'fetch-manifest.json');
let manifest = {};
if (existsSync(manifestPath)) { try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = {}; } }
const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');

function curl(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-s', '--cacert', '/run/hatch/egress-tls/ca-bundle.pem', '--max-time', '60',
      '-w', '\n%{http_code}', url],
      { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, https_proxy: 'http://hatch-egress-proxy:3128', http_proxy: 'http://hatch-egress-proxy:3128' } },
      (err, stdout) => {
        if (err && !stdout) return resolve({ code: 0, body: '' });
        const idx = stdout.lastIndexOf('\n');
        resolve({ code: parseInt(stdout.slice(idx + 1).trim(), 10) || 0, body: stdout.slice(0, idx) });
      });
  });
}

async function fetchOne(kind, slug) {
  const key = `${kind}:${slug}`;
  const file = join(dataDir, `${kind}-${slug}.json`);
  const prev = manifest[key];
  if (prev && (prev.code === 200 || prev.code === 400 || prev.code === 404) && (prev.code !== 200 || existsSync(file))) {
    return { key, code: prev.code, cached: true };
  }
  const url = kind === 'fees'
    ? `https://api.llama.fi/summary/fees/${encodeURIComponent(slug)}`
    : `https://api.llama.fi/protocol/${encodeURIComponent(slug)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { code, body } = await curl(url);
    if (code === 200) {
      try { JSON.parse(body); } catch { continue; }
      writeFileSync(file, body);
      manifest[key] = { code, fetched_at: new Date().toISOString(), bytes: body.length };
      saveManifest();
      return { key, code, cached: false };
    }
    if (code === 400 || code === 404) {
      manifest[key] = { code, fetched_at: new Date().toISOString(), body: body.slice(0, 200) };
      saveManifest();
      return { key, code, cached: false };
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  manifest[key] = { code: 0, fetched_at: new Date().toISOString(), error: 'failed after 3 attempts' };
  saveManifest();
  return { key, code: 0, cached: false };
}

const jobs = [];
for (const slug of slugs) { jobs.push(['fees', slug]); jobs.push(['protocol', slug]); }
const CONC = 5;
let done = 0;
const counts = {};
async function worker() {
  while (jobs.length) {
    const [kind, slug] = jobs.shift();
    const r = await fetchOne(kind, slug);
    counts[`${kind}:${r.code}`] = (counts[`${kind}:${r.code}`] || 0) + 1;
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${jobs.length + done} ... ${JSON.stringify(counts)}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log('DONE', JSON.stringify(counts));
console.log(`peers=${peers.length} board=${board.length} slugs=${slugs.length}`);
