/**
 * Living World showcase — P0 + P1a (plan peppy-jumping-pinwheel). NOT a gate:
 * a scripted run of the real game that RECORDS a video of the new loop:
 *
 *   robots vs drones fight on sight (P0) → kills drop glowing loot pods (P1a-1)
 *   → the pilot opens them and takes all found (cargo chip fills) → flies
 *   home and parks still in their Capital's crane bay → the crane reaches,
 *   holds, banks ("Banked …") and retracts (structure-restyle 3f/3i).
 *
 * Run: pnpm exec playwright test --config playwright.showcase.config.ts
 * Output: diag/showcase/p1a/living-world-p1.webm (+ a few key-frame PNGs).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CAPITAL_BAY, DOCK_CRANE_REACH_TICKS, DOCK_SETTLE_TICKS, DOCK_UNLOAD_HOLD_LOAD_TICKS, DOCK_UNLOAD_HOLD_MIN_TICKS } from '../../src/core/articulation/rigCatalogue.js';
import { type ClientShape, flyTo, localPose, lootNearestPods, parkAt } from './helpers';

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:5173/';
const OUT_DIR = join('diag', 'showcase', 'p1a');
const CAPITAL = { x: 0, y: -420 }; // re-picked per run (see the placement loop)

test('Living World P1: robots vs drones → loot → carry home → bank', async ({ page }, testInfo) => {
  mkdirSync(OUT_DIR, { recursive: true });
  // A FRESH pilot per run: the shared e2e login would otherwise resume a hull
  // left lingering in this (persistent) sector by a previous recording.
  const pid = randomUUID();
  await page.addInitScript((id) => {
    try { localStorage.setItem('eqxPlayerId', id as string); } catch { /* ignore */ }
  }, pid);
  const params = new URLSearchParams({
    room: 'living-world-showcase', testId: randomUUID(), worker: '0', newShip: '1',
    spawnX: '0', spawnY: '-250', initialHull: '99999', zoom: '0.55',
  });
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('24678')) console.log('[page]', m.type(), t.slice(0, 200));
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0, undefined,
    { timeout: 120_000 },
  );
  // Let the warp-in curtain lift.
  await page.waitForTimeout(6_000);

  // Plant a Capital behind the pilot — home base for the deposit. The showcase
  // sector PERSISTS (earlier recordings' Capitals are restored), so pick a fresh
  // spot and confirm a structure actually appears there; retry elsewhere if the
  // placement was rejected for overlap.
  for (let attempt = 0; attempt < 6; attempt++) {
    CAPITAL.x = Math.round((Math.random() - 0.5) * 1400);
    CAPITAL.y = -420 - Math.round(Math.random() * 500);
    await page.evaluate((cap) => {
      const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
      c?.getRoom?.()?.send('place_structure', { type: 'place_structure', kind: 'capital', x: cap.x, y: cap.y });
    }, CAPITAL);
    const placed = await page.waitForFunction((cap) => {
      const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
      for (const e of c?.mirror?.swarm?.values() ?? []) {
        if (e.kind === 2 && Math.hypot(e.x - cap.x, e.y - cap.y) < 5) return true;
      }
      return false;
    }, CAPITAL, { timeout: 3_000 }).then(() => true, () => false);
    if (placed) break;
  }

  // 1) Robots and drones engage each other on sight; kills drop loot.
  await page.waitForFunction(() => {
    const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
    let n = 0;
    for (const e of c?.mirror?.swarm?.values() ?? []) if (e.kind === 3 && e.shipKind === 'cargo-pod') n++;
    return n >= 2;
  }, undefined, { timeout: 60_000 });
  await page.screenshot({ path: join(OUT_DIR, '1-fight-and-loot.png') });
  await page.waitForTimeout(4_000); // let the fight play out on camera

  // 2) Open the nearest pods and take all found — the cargo chip fills.
  expect(await lootNearestPods(page, 3, 12_000)).toBeGreaterThan(0);
  await expect(page.getByTestId('cargo-chip')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: join(OUT_DIR, '2-cargo-collected.png') });

  // 3) Fly home and park still in the Capital's crane bay (its only drop-off):
  //    round the hull to the open (+y) side, then onto the pad. The Capital is
  //    placed at rot 0, so the bay is its local-frame offset as is.
  const pad = { x: CAPITAL.x + CAPITAL_BAY.cx, y: CAPITAL.y + CAPITAL_BAY.cy };
  const here = await localPose(page);
  const side = here && here.x < CAPITAL.x ? -1 : 1;
  if (here && here.y < CAPITAL.y + CAPITAL_BAY.halfH) {
    await flyTo(page, CAPITAL.x + side * 650, here.y, 220, 15_000);
  }
  await flyTo(page, CAPITAL.x + side * 450, pad.y + 250, 200, 15_000);
  expect(await parkAt(page, pad.x, pad.y, 20_000), 'parked still on the bay').toBe(true);
  // The crane: settle, reach, hold (3..10 s with load), bank at hold end.
  const ticks = DOCK_SETTLE_TICKS + DOCK_CRANE_REACH_TICKS + DOCK_UNLOAD_HOLD_MIN_TICKS + DOCK_UNLOAD_HOLD_LOAD_TICKS;
  await expect(page.getByTestId('loot-feed-line').filter({ hasText: 'Banked' })).toBeVisible({ timeout: (ticks / 60) * 1000 + 5_000 });
  await page.screenshot({ path: join(OUT_DIR, '3-banked.png') });
  await page.waitForTimeout((DOCK_CRANE_REACH_TICKS / 60) * 1000 + 2_000); // the arm retracts

  // Copy the recording out once the page closes (Playwright finalises it then).
  const video = page.video();
  await page.close();
  if (video) {
    const src = await video.path();
    copyFileSync(src, join(OUT_DIR, 'living-world-p1.webm'));
    testInfo.attachments.push({ name: 'video', path: src, contentType: 'video/webm' });
  }
});
