// Loopback control: a PC headless Chromium client (NO Wi-Fi — localhost
// loopback) against the SAME server the phone uses. Same mixed-activity
// schedule. If this client does NOT show the ~550ms snapshot stalls while
// the phone (over Wi-Fi) does, the stall is the Wi-Fi link, not the
// server/proxy. Autocapture streams a capture we then analyze.
import { chromium } from 'playwright';
import { readdirSync, statSync } from 'node:fs';

const CAPROOT = 'C:/Users/alecv/Desktop/eqx-net/eqx-net/diag/captures';
const URL = 'http://localhost:5173/?room=galaxy-sol-prime&worker=0&autocapture=1&diag=0&shipKind=interceptor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const before = new Set(readdirSync(CAPROOT));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: 'tests/e2e/.auth/storage-state.json' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pc] pageerror', e.message.slice(0, 120)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });

// wait until snapshots are flowing (ship-count testid > 0, the laser-smoothness pattern)
let joined = false;
try {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ship-count"]');
    return el && parseInt((el.textContent || '0').replace(/\D/g, ''), 10) > 0;
  }, { timeout: 20000 });
  joined = true;
} catch { /* fall through; still drive + capture */ }
console.log('[pc] joined=', joined);
await sleep(1500);

const STEPS = [
  ['fly+turn', 8000, ['KeyW', 'KeyD']],
  ['idle',     7000, []],
  ['fly+fire', 8000, ['KeyW', 'Space']],
  ['idle',     7000, []],
  ['turn+fire',8000, ['KeyA', 'Space']],
  ['idle',    10000, []],
  ['fly',      6000, ['KeyW']],
  ['idle',     8000, []],
  ['fire',     5000, ['Space']],
  ['idle',     8000, []],
];
const held = new Set();
const t0 = Date.now();
for (const [name, dur, keys] of STEPS) {
  const want = new Set(keys);
  for (const k of held) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
  for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  console.log(`[pc] +${((Date.now() - t0) / 1000).toFixed(0)}s ${name}`);
  await sleep(dur);
}
for (const k of held) await page.keyboard.up(k);
await sleep(1500);
await browser.close();

await sleep(500);
const after = readdirSync(CAPROOT).filter((d) => !before.has(d));
const newest = after.map((d) => ({ d, m: statSync(`${CAPROOT}/${d}`).mtimeMs })).sort((a, b) => b.m - a.m)[0];
console.log(`[pc] NEW_CAPTURE=${newest ? newest.d : '(none)'}`);
console.log('done');
