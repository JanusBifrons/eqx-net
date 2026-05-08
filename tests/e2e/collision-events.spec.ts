/**
 * Stage 2 closure spec for the network-feel roadmap. End-to-end verification
 * that the `collision_resolved` event is wired through worker → main →
 * client and is actually fired during real gameplay.
 *
 * The user's 2026-05-08 collision-cluster diagnostic
 * (`docs/LESSONS.md` Pattern A scenario) showed 8 cascading drift
 * corrections over 410 ms after a single swarm-drone collision —
 * because the client only learned about the post-collision velocity
 * one snapshot at a time. With Stage 2 wired, the worker drains
 * Rapier's contact-force events the moment they resolve and the server
 * broadcasts vPost to clients, who patch predWorld immediately and
 * skip the cascade.
 *
 * This spec drives the local ship into the legacy `sector` room's
 * 30-drone hostile ring for 5 s and asserts the
 * `predStats.collisionEventsApplied` counter > 0 — proving the path
 * fires under real gameplay. The spring-cascade reduction is
 * statistical and best observed in user-test diagnostics rather than
 * a hard E2E assertion.
 *
 * Uses `?room=...` autoJoin to bypass the GalaxyMapScreen splash.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test.setTimeout(60_000);

test('Stage 2: collision_resolved events are applied during real gameplay', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${BASE_URL}?room=sector`);

  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );

  await page.waitForTimeout(1500);

  // Drive into the drone ring. 30 drones at ~350 u radius. Hold W with a
  // slight intermittent turn to sweep the arc and avoid the rare run where
  // the ship's spawn heading aimed at a momentary gap; 8 s is plenty for
  // the ship to traverse the ring at typical 100–200 u/s terminal speed.
  await page.keyboard.down('w');
  await page.waitForTimeout(2000);
  await page.keyboard.down('d');
  await page.waitForTimeout(500);
  await page.keyboard.up('d');
  await page.waitForTimeout(2500);
  await page.keyboard.down('a');
  await page.waitForTimeout(500);
  await page.keyboard.up('a');
  await page.waitForTimeout(3000);
  await page.keyboard.up('w');
  await page.waitForTimeout(500);

  const stats = await page.evaluate(() => {
    const raw = document
      .querySelector('[data-testid="game-surface"]')
      ?.getAttribute('data-pred-stats');
    return JSON.parse(raw ?? '{}') as { collisionEventsApplied?: number; snapshotCount?: number };
  });

  console.log('\n=== Stage 2: collision_resolved counter ===');
  console.log(`Snapshots received: ${stats.snapshotCount}`);
  console.log(`Collision events applied: ${stats.collisionEventsApplied}`);
  console.log('===========================================\n');

  expect(stats.collisionEventsApplied ?? 0).toBeGreaterThan(0);

  await ctx.close();
});
