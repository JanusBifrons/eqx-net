/**
 * Phase-4 C2 — structure placement must reject overlapping an ASTEROID, driven
 * through the REAL wire handler (Invariant #13: the bug lives where `getObstacles`
 * is populated from real swarm asteroids, not in the pure predicate).
 *
 * User report: "it places [a capital] on an asteroid". The server's placement
 * overlap check iterated PLACED STRUCTURES only — never asteroids — so a Capital
 * dropped on a rock landed. The room already wires
 * `getObstacles: () => gatherStructureObstacles()` (asteroid poses from the SAB)
 * for the auto-connect LOS check; the fix routes the placement check through the
 * SAME hook via the shared `placementRejection` predicate. This test drives a
 * `place_structure` message end-to-end and asserts:
 *
 *   1. a Capital centred ON a seeded asteroid is REJECTED (registry stays empty);
 *   2. a Capital placed CLEAR of the rock lands (registry grows to 1).
 *
 * Pre-fix assertion #1 FAILS — the capital lands on the rock (registry size 1).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

describe('SectorRoom integration — placement rejects asteroid overlap (C2)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('rejects a Capital dropped on an asteroid, accepts one placed clear of it', async () => {
    // Clean scene (no ambient rocks) + one KNOWN asteroid well away from origin so
    // the SAB pose is unambiguous (an unpopulated SAB reads 0,0 — placing the rock
    // off-origin makes the test honest about reading the real authoritative pose).
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      scenarioAsteroids: [{ x: 1200, y: 0, radius: 120 }],
    });
    // `connectAs` (not connectActive) — placement resolves `owner` from the
    // join-time session→player map (set in onJoin), so no active hull is needed;
    // this also dodges the host-load-sensitive isActive wait.
    const room = await harness.connectAs('player-1');
    // Let the worker process the asteroid spawn so its pose lands in the SAB
    // (gatherStructureObstacles reads SAB x/y).
    await harness.advance(300);

    const internals = harness.getServerRoom()!._internals;
    // Precondition: the asteroid is registered (kind 0) — the obstacle the
    // placement check must see.
    const asteroids = [...internals.swarmRegistry.all()].filter((r) => r.kind === 0);
    expect(asteroids.length).toBe(1);
    expect(internals.structureRegistry.size).toBe(0);

    // (1) Place a Capital CENTRED on the asteroid (radius 80 vs rock 120 at the
    // same point ⇒ deep overlap) → must be rejected, nothing recorded.
    room.send('place_structure', { type: 'place_structure', kind: 'capital', x: 1200, y: 0 });
    await harness.advance(200);
    expect(internals.structureRegistry.size, 'capital on the asteroid must be rejected').toBe(0);

    // (2) Place a Capital WELL CLEAR of the rock (distance 1800 ≫ 80+120) → lands.
    room.send('place_structure', { type: 'place_structure', kind: 'capital', x: 3000, y: 0 });
    await harness.advance(200);
    expect(internals.structureRegistry.size, 'capital clear of the asteroid must land').toBe(1);
    const placed = [...internals.structureRegistry.all()][0]!;
    expect(placed.kind).toBe('capital');
    expect(placed.x).toBe(3000);
  }, 25_000);
});
