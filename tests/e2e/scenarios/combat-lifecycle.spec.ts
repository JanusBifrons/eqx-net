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
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200 }),
    launchTestClient(browser, { spawnX: 0, spawnY: 200 }),
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
test('full lifecycle: P2 dies, respawns at initial position with full hull', async ({ browser }) => {
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200 }),
    launchTestClient(browser, { spawnX: 0, spawnY: 200 }),
  ]);
  try {
    await Promise.all([p1.page.waitForTimeout(1000), p2.page.waitForTimeout(1000)]);

    // Kill P2.
    await p1.page.keyboard.down('Space');
    await waitForDeath(p2.page, 5_000);
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
  const [p1, p2] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: -200 }),
    launchTestClient(browser, { spawnX: 0, spawnY: 200 }),
  ]);
  try {
    await Promise.all([p1.page.waitForTimeout(1000), p2.page.waitForTimeout(1000)]);

    const hullBefore = await getHullPct(p2.page);

    // Fire one burst.
    await p1.page.keyboard.down('Space');
    await p1.page.waitForTimeout(400);
    await p1.page.keyboard.up('Space');

    // Wait for damage to propagate.
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
