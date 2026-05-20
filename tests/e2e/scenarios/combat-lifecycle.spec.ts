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
  waitForRespawn,
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
    // Allow one physics update cycle to populate data attributes.
    await page.waitForTimeout(500);
    const x = await getShipX(page);
    const y = await getShipY(page);
    expect(x).toBeCloseTo(0, 0);   // within ±0.5
    expect(y).toBeCloseTo(-200, 0);
    console.log(`\nDeterministic spawn: x=${x.toFixed(2)}, y=${y.toFixed(2)} ✓\n`);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// C. P1 kills P2 — deterministic, < 5 s
// ---------------------------------------------------------------------------
test('P1 destroys P2: hull reaches 0, SHIP DESTROYED alert fires', async ({ browser }) => {
  // P1 at south, fires north — P2 at north, directly in P1's sights.
  // Shared testId so both clients land in the SAME isolated room
  // (Colyseus filterBy routes by testId).
  const testId = randomUUID();
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200, testId }),
    launchTestClient(browser, { spawnX: 0, spawnY: 200, testId }),
  ]);
  try {
    // Let both clients sync with the server before firing.
    await Promise.all([p1.page.waitForTimeout(1000), p2.page.waitForTimeout(1000)]);

    const initialHull = await getHullPct(p2.page);
    expect(initialHull).toBe(100);

    // P1 fires until P2 is dead.
    // HITSCAN_DAMAGE=20, 5 hits = kill. WEAPON_COOLDOWN_TICKS=10 @ 60 Hz ≈ 167 ms/shot.
    // 5 shots + RTT budget → should complete in < 5 s.
    await p1.page.keyboard.down('Space');
    await waitForDeath(p2.page, 5_000);
    await p1.page.keyboard.up('Space');

    expect(await getHullPct(p2.page)).toBe(0);

    await p2.page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-sector-alert') === 'SHIP DESTROYED',
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
// D. Full lifecycle: death → respawn → hull restored → back at initial position
// ---------------------------------------------------------------------------
// fixme: respawn flow refactored. The DeathOverlay Respawn button now
// calls `setPhase('galaxy-map')` (App.tsx:167) — the player has to pick
// a new sector + ship from the post-death galaxy-map screen rather than
// respawning in-place. The "respawn at initial position" assertion this
// test was built for is no longer a meaningful contract: a new spawn
// after death is a fresh sector pick + URL re-entry, not a return to
// the prior spawnX/spawnY. The death-side coverage (hull -> 0, SHIP
// DESTROYED alert, dead ship cannot fire) is locked by :65 just above;
// the new respawn-via-galaxy-map flow needs its own spec when the
// repair queue gets to it.
// (e2e-rebuild Phase 5 repair queue, 2026-05-20.)
test.fixme('full lifecycle: P2 dies, respawns at initial position with full hull', async ({ browser }) => {
  // P2 spawns with 10 HP + 0 shield (testMode-only override) so one beam
  // tick kills — we're testing the death -> respawn lifecycle, not the
  // time-to-kill mechanics. P1 spawns at full HP so it survives.
  //
  // initialHull = 10 (not 1) because `data-hull-pct` is a percent against
  // the kind's maxHealth (750 post-slow-down) — hull=1 rounds to 0 % at
  // spawn, which would make waitForDeath return immediately before P1
  // even fires. hull=10 reports ~1 % which is non-zero, and one 20-dmg
  // hitscan tick still drops it to 0.
  const testId = randomUUID();
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200, testId }),
    launchTestClient(browser, { spawnX: 0, spawnY: 200, initialHull: 10, initialShield: 0, testId }),
  ]);
  try {
    await Promise.all([p1.page.waitForTimeout(1000), p2.page.waitForTimeout(1000)]);

    // Kill P2. waitForDeath default 10 s budget is fine for a 1 HP target.
    await p1.page.keyboard.down('Space');
    await waitForDeath(p2.page, 10_000);
    await p1.page.keyboard.up('Space');

    expect(await getHullPct(p2.page)).toBe(0);

    // P2 clicks Respawn.
    await p2.page.getByRole('button', { name: /respawn/i }).click();
    await waitForRespawn(p2.page, 10_000);

    // Hull is restored.
    expect(await getHullPct(p2.page)).toBe(100);

    // Alert clears after respawn.
    await p2.page.waitForFunction(
      () => {
        const alert = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-sector-alert') ?? '';
        return alert === '' || alert === 'null';
      },
      { timeout: 2_000 },
    );

    // Respawn position is deterministic (within ±10 units of initial spawn).
    await p2.page.waitForTimeout(300);
    const rx = await getShipX(p2.page);
    const ry = await getShipY(p2.page);
    expect(Math.abs(rx - 0)).toBeLessThan(10);
    expect(Math.abs(ry - 200)).toBeLessThan(10);

    console.log(`\nFull lifecycle: respawn at x=${rx.toFixed(1)}, y=${ry.toFixed(1)}, hull=100 ✓\n`);
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
  const testId = randomUUID();
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200, testId }),
    launchTestClient(browser, { spawnX: 0, spawnY: 200, initialShield: 0, testId }),
  ]);
  try {
    await Promise.all([p1.page.waitForTimeout(1000), p2.page.waitForTimeout(1000)]);

    const hullBefore = await getHullPct(p2.page);

    // One burst (400 ms) is enough now that shield = 0 — the first beam
    // tick lands hull damage.
    await p1.page.keyboard.down('Space');
    await p1.page.waitForTimeout(400);
    await p1.page.keyboard.up('Space');

    // Wait for damage to propagate (default 3 s budget).
    await p2.page.waitForFunction(
      () => parseInt(
        document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-hull-pct') ?? '100',
        10,
      ) < 100,
      { timeout: 3_000 },
    );

    const hullAfter = await getHullPct(p2.page);
    expect(hullAfter).toBeLessThan(hullBefore);
    console.log(`\nDamage propagated: hull ${hullBefore} → ${hullAfter} ✓\n`);
  } finally {
    await Promise.all([p1.ctx.close(), p2.ctx.close()]);
  }
});
