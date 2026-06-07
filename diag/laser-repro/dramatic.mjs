// Dramatic before/after of the laser-detach bug: build a LARGE frozen gap with
// sustained gentle thrust (kept under the 4 u/frame BEAM_EPSILON so the dirty
// gate never trips), then a HARD thrust that exceeds the threshold to show the
// beam SNAP back to the nose ("catches up when I fly"). Matches the user's words.

import { chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const OUT = 'diag/laser-repro/shots';
mkdirSync(OUT, { recursive: true });

const testId = randomUUID();
const url =
  `${BASE}?room=test-sector&shipKind=interceptor&worker=0` +
  `&spawnX=0&spawnY=0&initialAngle=0&testId=${testId}`;

const readState = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    if (!el) return null;
    const localId = el.getAttribute('data-local-player-id') || '';
    let me = null;
    try { me = JSON.parse(el.getAttribute('data-ship-positions') || '{}')[localId] || null; } catch {}
    return { x: me?.x ?? null, y: me?.y ?? null, beam: el.getAttribute('data-beam-active') };
  });

const browser = await (async () => {
  try { const b = await chromium.launch({ headless: false }); console.log('HEADED'); return b; }
  catch { const b = await chromium.launch({ headless: true }); console.log('HEADLESS'); return b; }
})();
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(url);
await page.waitForFunction(
  () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
  { timeout: 20000 },
);
await page.waitForTimeout(1000);

await page.keyboard.down('Space');
await page.waitForFunction(
  () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
  { timeout: 5000 },
).catch(() => {});
const base = await readState(page);
console.log('D00 baseline (attached)', JSON.stringify(base));
await page.screenshot({ path: `${OUT}/D00-attached.png` });

// Build a big frozen gap: short gentle taps spaced out keep speed well under
// 240 u/s (4 u/frame) while distance accumulates.
for (let k = 0; k < 10; k++) {
  await page.keyboard.down('w');
  await page.waitForTimeout(60);
  await page.keyboard.up('w');
  await page.waitForTimeout(220);
  const s = await readState(page);
  const gap = (s?.y != null && base?.y != null) ? Math.hypot(s.x - base.x, s.y - base.y).toFixed(1) : '?';
  console.log(`  build k=${k} gap=${gap}u`, JSON.stringify({ x: s?.x, y: s?.y, beam: s?.beam }));
}
const frozen = await readState(page);
const frozenGap = Math.hypot(frozen.x - base.x, frozen.y - base.y).toFixed(1);
console.log(`D01 FROZEN gap=${frozenGap}u`, JSON.stringify(frozen));
await page.screenshot({ path: `${OUT}/D01-frozen-gap.png` });

// HARD thrust: exceed 4 u/frame in single frames -> dirty trips -> beam snaps
// back to the nose ("catches up when I fly").
await page.keyboard.down('w');
await page.waitForTimeout(700);
await page.keyboard.up('w');
await page.waitForTimeout(120);
const snapped = await readState(page);
console.log('D02 after HARD thrust (expect snap-to-nose)', JSON.stringify(snapped));
await page.screenshot({ path: `${OUT}/D02-after-hard-thrust.png` });

await page.keyboard.up('Space');
await browser.close();
console.log('DONE');
