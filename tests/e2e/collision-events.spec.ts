/**
 * Stage 2 closure spec for the network-feel roadmap. End-to-end verification
 * that the `collision_resolved` event is wired through worker → main →
 * client and is applied to predWorld during real gameplay.
 *
 * The user's 2026-05-08 collision-cluster diagnostic (`docs/LESSONS.md`
 * Pattern A) showed cascading drift corrections after a swarm collision —
 * because the client learned the post-collision velocity one snapshot at a
 * time. With Stage 2 wired, the worker drains Rapier's contact events the
 * moment they resolve, the server broadcasts vPost, and the client patches
 * predWorld immediately (`collisionEventsApplied` counter ticks).
 *
 * DETERMINISTIC (2026-06-17, E2E-hardening B1): the old version joined the
 * LIVE `?room=sector` (30 random drones) and "drove into the ring for ~6 s
 * hoping to hit one" with fixed `waitForTimeout` windows — a spray-and-pray
 * spec whose pass depended on the spawn heading vs the random ring (the exact
 * non-determinism the test-coverage audit targets). This version rams a known
 * target: `auto-fire-test` parks a PEACEFUL, hull-exposed fighter 150 u ahead
 * of spawn (collider active). Thrust forward → guaranteed contact → a
 * `collision_resolved` is applied. The wait is a STATE PREDICATE on the
 * counter with the budget as a deadline, not a blind window.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test.setTimeout(45_000);

function collisionCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const raw = document
      .querySelector('[data-testid="game-surface"]')
      ?.getAttribute('data-pred-stats');
    const s = JSON.parse(raw ?? '{}') as { collisionEventsApplied?: number };
    return s.collisionEventsApplied ?? 0;
  });
}

test('Stage 2: collision_resolved is applied when the local ship rams a drone', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Peaceful hull-exposed drone parked 150 u ahead of spawn (collider live).
  await page.goto(`${BASE_URL}?room=auto-fire-test`);

  // Local ship spawned + rendered.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );

  // Thrust forward into the parked drone and POLL until a collision event is
  // applied — the time budget is a DEADLINE, not a sample-once window. Holding
  // W keeps the closing speed above the impulse floor through the join →
  // client_ready activation race, so a genuine "never wired" regression still
  // fails at the deadline while a slow runner just takes longer.
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(
      () => {
        const raw = document
          .querySelector('[data-testid="game-surface"]')
          ?.getAttribute('data-pred-stats');
        const s = JSON.parse(raw ?? '{}') as { collisionEventsApplied?: number };
        return (s.collisionEventsApplied ?? 0) > 0;
      },
      { timeout: 20_000 },
    );
  } finally {
    await page.keyboard.up('w');
  }

  expect(await collisionCount(page)).toBeGreaterThan(0);

  await ctx.close();
});
