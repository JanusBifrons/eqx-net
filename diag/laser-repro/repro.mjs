// Visual reproduction of the "laser beam detach" bug (Step 1 of the plan).
// Drives the REAL game in a browser (worker=0 main-thread PixiRenderer, which
// renders to the DOM canvas and is screenshot-able), holds fire, and applies
// GENTLE motion (sub-4 u/frame) so the dirty-cache gate in PixiRenderer never
// trips -> the drawn beam should freeze in world space while the ship flies on.
//
// We screenshot a burst and log the local ship position each frame so the gap
// can be quantified alongside the visual evidence.
//
// Usage:  node diag/laser-repro/repro.mjs            (headed first; falls back to headless)
//         HEADLESS=1 node diag/laser-repro/repro.mjs (force headless)

import { chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const OUT = 'diag/laser-repro/shots';
mkdirSync(OUT, { recursive: true });

const testId = randomUUID();
// angle 0 => fires toward +y; thrust is along the same facing, so the ship flies
// along its own beam direction (the user's "fly forward and hold fire" repro).
const url =
  `${BASE}?room=test-sector&shipKind=interceptor&worker=0` +
  `&spawnX=0&spawnY=0&initialAngle=0&testId=${testId}`;

async function launch() {
  const forceHeadless = process.env.HEADLESS === '1';
  if (!forceHeadless) {
    try {
      const b = await chromium.launch({ headless: false });
      console.log('launched HEADED');
      return b;
    } catch (e) {
      console.log('headed launch failed, falling back to headless:', e.message);
    }
  }
  const b = await chromium.launch({ headless: true });
  console.log('launched HEADLESS');
  return b;
}

const readState = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    if (!el) return null;
    const localId = el.getAttribute('data-local-player-id') || '';
    let me = null;
    try {
      const positions = JSON.parse(el.getAttribute('data-ship-positions') || '{}');
      me = positions[localId] || null;
    } catch { /* ignore */ }
    return {
      x: me?.x ?? null,
      y: me?.y ?? null,
      beamActive: el.getAttribute('data-beam-active'),
      beamCount: el.getAttribute('data-beam-count'),
      // NOTE: beamFromX/Y is the RECOMPUTE (tautology) — it tracks the ship and
      // will NOT reveal the frozen sprite. Logged only to show it stays glued.
      beamFromX: el.getAttribute('data-beam-from-x'),
      beamFromY: el.getAttribute('data-beam-from-y'),
    };
  });

async function captureArm(page, label, drive) {
  console.log(`\n=== ARM ${label} ===`);
  await page.keyboard.down('Space');
  // Wait for the beam to actually turn on.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
    { timeout: 5000 },
  ).catch(() => console.log('  (beam never went active — check fire path)'));
  const base = await readState(page);
  console.log(`  ${label}00 baseline`, JSON.stringify(base));
  await page.screenshot({ path: `${OUT}/${label}00-baseline.png` });

  await drive(page);

  let prev = base;
  for (let i = 1; i <= 14; i++) {
    await page.waitForTimeout(150);
    const s = await readState(page);
    const dx = (s?.x != null && prev?.x != null) ? (s.x - prev.x).toFixed(2) : '?';
    const dy = (s?.y != null && prev?.y != null) ? (s.y - prev.y).toFixed(2) : '?';
    const dist =
      (s?.x != null && base?.x != null)
        ? Math.hypot(s.x - base.x, s.y - base.y).toFixed(2)
        : '?';
    console.log(`  ${label}${String(i).padStart(2, '0')} Δ150ms=(${dx},${dy}) gapFromStart=${dist}u  beam=${s?.beamActive}`, JSON.stringify({ x: s?.x, y: s?.y }));
    await page.screenshot({ path: `${OUT}/${label}${String(i).padStart(2, '0')}.png` });
    prev = s;
  }
  await page.keyboard.up('Space');
  await page.waitForTimeout(300);
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.ERR', m.text()); });

console.log('goto', url);
await page.goto(url);
await page.waitForFunction(
  () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
  { timeout: 20000 },
);
console.log('ship spawned; settling…');
await page.waitForTimeout(1000);

// ARM A — coast forward: one GENTLE thrust tap then release, hold fire.
// Expect: drawn beam freezes at start, ship drifts away => growing gap.
await captureArm(page, 'A', async (p) => {
  await p.keyboard.down('w');
  await p.waitForTimeout(45);
  await p.keyboard.up('w');
});

// reset position drift by settling
await page.waitForTimeout(800);

// ARM B — gentle in-place circle: hold fire, alternate slow turn taps, no thrust.
await captureArm(page, 'B', async (p) => {
  // kick off a slow alternating pivot during the capture loop is hard to
  // interleave; instead pre-load a gentle continuous-ish turn with short taps.
  for (let k = 0; k < 3; k++) {
    await p.keyboard.down('d');
    await p.waitForTimeout(120);
    await p.keyboard.up('d');
    await p.waitForTimeout(80);
  }
});

await browser.close();
console.log('\nDONE — screenshots in', OUT);
