/**
 * Living World showcase — P1b robots (plan peppy-jumping-pinwheel). NOT a gate:
 * a scripted run of the real game that RECORDS the three-way fight:
 *
 *   a mixed-tier robot squad (hexagon / circles / cubes) and a drone pack
 *   engage each other on sight, and the robots go for the pilot too (who
 *   returns fire on auto) → wrecks drop tiered loot → the pilot scoops it.
 *
 * Run (headed — headless software WebGL can't render the game):
 *   pnpm exec playwright test --config playwright.showcase.config.ts robots-p1b --headed
 * Output: diag/showcase/p1b/robots-p1b.webm (+ key-frame PNGs).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { countCombatants, flyTo, localPose, podPositions } from './helpers';

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:5173/';
const OUT_DIR = join('diag', 'showcase', 'p1b');

test('Living World P1b: robots vs drones vs pilot → tiered loot', async ({ page }, testInfo) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const pid = randomUUID();
  await page.addInitScript((id) => {
    try { localStorage.setItem('eqxPlayerId', id as string); } catch { /* ignore */ }
  }, pid);
  const params = new URLSearchParams({
    room: 'robots-showcase', testId: randomUUID(), worker: '0', newShip: '1',
    spawnX: '0', spawnY: '120', initialHull: '99999', zoom: '0.5',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(5_000); // warp-in curtain lifts; the sides close in

  // 1) All three tiers on the field, fighting.
  expect(await countCombatants(page, 'robot-')).toBeGreaterThan(0);
  await page.screenshot({ path: join(OUT_DIR, '1-three-way-fight.png') });

  // 2) Let the fight play out until wrecks have dropped loot.
  await page.waitForFunction(() => {
    const c = (window as unknown as { __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient;
    let n = 0;
    for (const e of c?.mirror?.swarm?.values() ?? []) if (e.kind === 3 && e.shipKind === 'cargo-pod') n++;
    // Nearby drops MERGE into one pod (60 u) and crossfire can destroy pods, so
    // a dozen kills settle into a handful of pods — 2 is a reliable "loot is down".
    return n >= 2;
  }, undefined, { timeout: 90_000 });
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: join(OUT_DIR, '2-wrecks-and-loot.png') });

  // 3) Scoop the loot (nearest first).
  for (let i = 0; i < 6; i++) {
    const pods = await podPositions(page);
    const me = await localPose(page);
    if (pods.length === 0 || me === null) break;
    pods.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    await flyTo(page, pods[0]!.x, pods[0]!.y, 50, 10_000);
    await page.waitForTimeout(300);
  }
  await expect(page.getByTestId('cargo-chip')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: join(OUT_DIR, '3-loot-collected.png') });
  await page.waitForTimeout(2_000);

  const video = page.video();
  await page.close();
  if (video) {
    const src = await video.path();
    copyFileSync(src, join(OUT_DIR, 'robots-p1b.webm'));
    testInfo.attachments.push({ name: 'video', path: src, contentType: 'video/webm' });
  }
});
