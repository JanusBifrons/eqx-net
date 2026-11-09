/**
 * Deterministic combat lifecycle scenarios — Phase 4.
 *
 * Uses the `test-sector` room (no asteroids, controlled spawn positions) so
 * every scenario resolves in seconds rather than relying on random placement.
 *
 * Coordinate system: forward direction = (-sin(angle), cos(angle)).
 * At default spawn angle=0 a ship fires NORTH (+Y).
 * Layout used here:
 *   P1 at (0, -200) — fires north along the Y axis
 *   P2 at (0, +200) — sits 400 units north of P1 (within HITSCAN_RANGE=500)
 *
 * Run headed for visual verification:
 *   pnpm e2e:headed tests/e2e/scenarios/combat-lifecycle.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  launchTestClient,
  getHullPct,
  getSectorAlert,
  getShipX,
  getShipY,
  getObstaclePositions,
  getBeamActive,
  waitForDeath,
  waitForInPlay,
} from '../helpers/gameScenario.js';

// ---------------------------------------------------------------------------
// A. No asteroids in test-sector
// ---------------------------------------------------------------------------
test('test-sector has no asteroids', async ({ browser }) => {
  const { ctx, page } = await launchTestClient(browser, { spawnX: 0, spawnY: -200 });
  try {
    await page.waitForTimeout(500);
    const obs = await getObstaclePositions(page);
    expect(Object.keys(obs)).toHaveLength(0);
    console.log('\ntest-sector: obstacle count = 0 ✓\n');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// B. Deterministic spawn position
// ---------------------------------------------------------------------------
test('ship spawns at the position specified in URL params', async ({ browser }) => {
  const { ctx, page } = await launchTestClient(browser, { spawnX: 0, spawnY: -200 });
  try {
    // Poll until client prediction converges on the authoritative spawn pose.
    // predWorld initialises at (0,0) and reconciles to the server spawn on the
    // first snapshot; reading a fixed 500 ms in catches it mid-lerp. State-wait
    // on the value being asserted, not a fixed sleep.
    await expect.poll(() => getShipX(page), { timeout: 6_000 }).toBeCloseTo(0, 0);   // within ±0.5
    await expect.poll(() => getShipY(page), { timeout: 6_000 }).toBeCloseTo(-200, 0);
    const x = await getShipX(page);
    const y = await getShipY(page);
    console.log(`\nDeterministic spawn: x=${x.toFixed(2)}, y=${y.toFixed(2)} ✓\n`);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// C. P1 kills P2 — deterministic, < 5 s
// ---------------------------------------------------------------------------
test('P1 destroys P2: hull reaches 0, SHIP DESTROYED alert fires', async ({ browser }) => {
  test.setTimeout(60_000); // two loading curtains (infrastructural)
  // P1 at south, fires north — P2 at north, directly in P1's sights.
  // Shared testId so both clients land in the SAME isolated room
  // (Colyseus filterBy routes by testId).
  const testId = randomUUID();
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200, testId }),
    // A near-dead, unshielded target: the kill is a few hits, not a fighter's
    // full ~750 hull + shield (the old "100 HP, ~0.8 s" comment predates the
    // slow-down retune; it only passed while the 5 s wait below had no deadline).
    launchTestClient(browser, { spawnX: 0, spawnY: 200, testId, initialHull: 10, initialShield: 0 }),
  ]);
  try {
    // Both ships must be active (curtain lifted) before anyone fires.
    await Promise.all([waitForInPlay(p1.page), waitForInPlay(p2.page)]);

    const initialHull = await getHullPct(p2.page);
    expect(initialHull).toBeGreaterThan(0);

    // P1 fires until P2 is dead. Hitscan DPS = 120 HP/sec (catalogue-driven —
    // post-smooth-beam retune 4 HP × 33 ms = same DPS as the prior 20 HP × 167 ms,
    // see `src/core/combat/WeaponCatalogue.ts` HITSCAN_DEF). 100 HP ship → kill
    // in ~0.8 s + RTT; comfortable within the 5 s budget below.
    await p1.page.keyboard.down('Space');
    // 15 s: before the 2026-11-06 waitForFunction fix this deadline never
    // applied (it ran to the 30 s test timeout); two clients on a CI runner
    // need more than 5 s even for a few hits.
    await waitForDeath(p2.page, 15_000);
    await p1.page.keyboard.up('Space');

    expect(await getHullPct(p2.page)).toBe(0);

    await p2.page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-sector-alert') === 'SHIP DESTROYED', undefined,
      { timeout: 1_000 },
    );
    expect(await getSectorAlert(p2.page)).toBe('SHIP DESTROYED');

    // Dead ship cannot fire.
    await p2.page.keyboard.down('Space');
    await p2.page.waitForTimeout(150);
    expect(await getBeamActive(p2.page)).toBe(false);
    await p2.page.keyboard.up('Space');

    console.log('\nP1 kills P2: hull=0 ✓, SHIP DESTROYED alert ✓, beam blocked ✓\n');
  } finally {
    await Promise.all([p1.ctx.close(), p2.ctx.close()]);
  }
});

// ---------------------------------------------------------------------------
// D. A real server kill drops the victim into spectator, with no death modal
// ---------------------------------------------------------------------------
// Replaces the old test.fixme 'P2 dies, respawns at initial position': there is
// no Respawn button any more. Since Equinox WS-A1 a dead pilot goes straight to
// spectator mode (free camera; re-entry via the galaxy map or the Pilot
// action). spectator-mode.spec.ts fakes the death client-side
// (__eqxKillLocalShip); this drives the real path: a server kill → the
// destroy message → spectator, on the victim's own client.
test('full lifecycle: P2 is killed by P1 and drops into spectator, no death modal', async ({ browser }) => {
  test.setTimeout(60_000); // two cold browser joins (infrastructure); the kill itself is one tick
  // initialHull 10 (not 1): data-hull-pct is a percent of maxHealth, so 1 HP
  // reads 0 % at spawn and waitForDeath would return before P1 fires.
  const testId = randomUUID();
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200, testId }),
    launchTestClient(browser, { spawnX: 0, spawnY: 200, initialHull: 10, initialShield: 0, testId }),
  ]);
  try {
    // A ship is targetable only once its loading curtain lifts.
    await Promise.all([waitForInPlay(p1.page), waitForInPlay(p2.page)]);
    expect(await p2.page.locator('[data-testid="game-surface"]').getAttribute('data-pilot-mode')).toBe('pilot');
    await p1.page.keyboard.down('Space');
    await waitForDeath(p2.page, 10_000);
    await p1.page.keyboard.up('Space');
    expect(await getHullPct(p2.page)).toBe(0);

    await p2.page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator', undefined,
      { timeout: 5_000 },
    );
    // No blocking modal: the old DeathOverlay and its Respawn button are gone.
    await expect(p2.page.getByRole('button', { name: /respawn/i })).toHaveCount(0);
    // The shooter keeps flying.
    expect(await p1.page.locator('[data-testid="game-surface"]').getAttribute('data-pilot-mode')).toBe('pilot');
  } finally {
    await Promise.all([p1.ctx.close(), p2.ctx.close()]);
  }
});

// ---------------------------------------------------------------------------
// E. Snapshot shows P2's hull reduced on P1's view (server broadcasts damage)
// ---------------------------------------------------------------------------
test('shooter sees target hull decrease in shared ship positions', async ({ browser }) => {
  // P2 spawns with 0 shield so the first beam hit goes straight to hull
  // (the slow-down-gameplay shield buffer would otherwise absorb every
  // burst, leaving hull at 100 — the test would pass trivially at
  // hull<100 only via a multi-second drain). We keep default hull so the
  // damage-magnitude check (< 100) is meaningful.
  // Two browser contexts cold-boot + each joins Colyseus — that's
  // infrastructural latency (not game-time), and on a loaded box the pair
  // can crowd the 30 s default. Budget for the infra per the harness rules
  // (the game-time portion below stays tight).
  test.setTimeout(60_000);
  const testId = randomUUID();
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200, testId }),
    launchTestClient(browser, { spawnX: 0, spawnY: 200, initialShield: 0, testId }),
  ]);
  try {
    await Promise.all([p1.page.waitForTimeout(1000), p2.page.waitForTimeout(1000)]);

    const hullBefore = await getHullPct(p2.page);

    // Fire P1's loadout at P2 via the framework trigger (deterministic — no
    // keyboard focus / per-RAF dispatch flakiness). Re-fire past the spawn /
    // cooldown window — the fired weapon resolves from P1's mirror kind, which
    // the first snapshot sets shortly after join — until P2's hull drops.
    let hullAfter = hullBefore;
    for (let i = 0; i < 40 && hullAfter >= hullBefore; i++) {
      await p1.page.evaluate(
        () =>
          (
            window as unknown as { __eqxClient?: { triggerFireForTest(id: string): boolean } }
          ).__eqxClient?.triggerFireForTest('hitscan'),
      );
      await p1.page.waitForTimeout(100);
      hullAfter = await getHullPct(p2.page);
    }
    expect(hullAfter).toBeLessThan(hullBefore);
    console.log(`\nDamage propagated: hull ${hullBefore} → ${hullAfter} ✓\n`);
  } finally {
    await Promise.all([p1.ctx.close(), p2.ctx.close()]);
  }
});
