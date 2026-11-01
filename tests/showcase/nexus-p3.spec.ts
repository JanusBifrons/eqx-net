/**
 * Living World showcase — P3a robot nexus + territory (plan peppy-jumping-pinwheel).
 * NOT a gate: records
 *
 *   1. the robot NEXUS up close — a huge violet octagon firing slow pulse orbs,
 *      guarded by robot cubes, as a drone pack drifts into range;
 *   2. the LIVE galaxy map: the nexus's sector turns robot-violet once the
 *      robots claim it ("Robot Dominion").
 *
 * Run (headed): pnpm exec playwright test --config playwright.showcase.config.ts nexus-p3 --headed
 * Output: diag/showcase/p3/nexus-p3.webm (+ key-frame PNGs).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:5173/';
const OUT_DIR = join('diag', 'showcase', 'p3');

test('Living World P3a: the robot nexus and robot territory', async ({ page }, testInfo) => {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.addInitScript((id) => {
    try { localStorage.setItem('eqxPlayerId', id as string); } catch { /* ignore */ }
  }, randomUUID());

  // 1) The nexus up close.
  const params = new URLSearchParams({
    room: 'nexus-showcase', testId: randomUUID(), worker: '0', newShip: '1', shipKind: 'heavy',
    // Spawn just south of the robot guard so nexus + guard + drones are in frame.
    spawnX: '0', spawnY: '320', initialHull: '99999', zoom: '0.45',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
    { timeout: 120_000 },
  );
  await page.waitForTimeout(6_000); // curtain lifts; orbs start flying
  await page.screenshot({ path: join(OUT_DIR, '1-nexus.png') });
  await page.waitForTimeout(10_000); // the fight plays out on camera
  await page.screenshot({ path: join(OUT_DIR, '2-nexus-fight.png') });

  // 2) The live galaxy: wait until the robots hold a sector (the nexus claim
  // takes ~40 s of control pressure from boot), then show the map.
  const held = await expect.poll(async () => {
    const res = await page.request.get(`${BASE_URL}galaxy/snapshot`);
    const body = (await res.json()) as { sectors?: Array<{ key: string; owner: { factionId: string } | null }> } | Array<{ key: string; owner: { factionId: string } | null }>;
    const list = Array.isArray(body) ? body : body.sectors ?? [];
    return list.filter((s) => s.owner?.factionId === 'robots').length;
  }, { timeout: 150_000, intervals: [3_000] }).toBeGreaterThan(0).then(() => true, () => false);
  testInfo.annotations.push({ type: 'robot-held', description: String(held) });

  await page.goto(`${BASE_URL}`);
  await page.waitForTimeout(8_000); // landing map + badges reveal
  await page.screenshot({ path: join(OUT_DIR, '3-galaxy-territory.png') });
  await page.waitForTimeout(3_000);

  const video = page.video();
  await page.close();
  if (video) {
    const src = await video.path();
    copyFileSync(src, join(OUT_DIR, 'nexus-p3.webm'));
    testInfo.attachments.push({ name: 'video', path: src, contentType: 'video/webm' });
  }
});
