/**
 * Phase-4 C2 — structure placement must reject overlapping an ASTEROID, driven
 * through the REAL wire handler (Invariant #13: the bug lives where `getObstacles`
 * is populated from real swarm asteroids, not in the pure predicate).
 *
 * User report: "it places [a capital] on an asteroid". The server's placement
 * overlap check iterated PLACED STRUCTURES only — never asteroids — so a Capital
 * dropped on a rock landed. The room already wires
 * `getObstacles: () => SectorObstacles.rocks()` (asteroid poses from the SAB)
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
import { placementRejection } from '../../../src/core/structures/placementRules.js';
import { isConnectionLineBlocked, type GridNode, type GridObstacle } from '../../../src/core/structures/Grid.js';
import { CONNECTION_MAX_RANGE } from '../../../src/core/structures/structureGridConstants.js';
import { rayHitsConvexPolygon } from '../../../src/core/combat/Weapons.js';
import { structureHalfExtents } from '../../../src/shared-types/structureKinds.js';

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
    // (SectorObstacles.rocks reads SAB x/y).
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

  it('tests a live rock by its outline at its pose: inside the circle but off the outline lands (C5b)', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      scenarioAsteroids: [{ x: -3000, y: 0, radius: 600 }],
    });
    const room = await harness.connectAs('player-1');
    await harness.advance(300);
    const internals = harness.getServerRoom()!._internals;
    const rec = [...internals.swarmRegistry.all()].find((r) => r.kind === 0)!;
    expect(rec.vertices, 'an ordinary asteroid carries its outline').toBeDefined();
    // Static rock: its spawn pose is its live pose.
    const pose = rec.lastBroadcast, { hw, hh } = structureHalfExtents('connector', 0);
    const rock: GridObstacle = { x: pose.x, y: pose.y, radius: rec.radius, angle: pose.angle, parts: [rec.vertices!] };
    let spot: { x: number; y: number } | null = null;
    for (let k = 0; k < 64 && spot === null; k++) {
      const a = (k / 64) * Math.PI * 2, x = pose.x + Math.cos(a) * (rec.radius + Math.min(hw, hh) * 0.5), y = pose.y + Math.sin(a) * (rec.radius + Math.min(hw, hh) * 0.5);
      if (placementRejection('connector', x, y, [], [rock]) === null) spot = { x, y };
    }
    expect(spot, 'a spot inside the circle but off the outline').not.toBeNull();
    expect(placementRejection('connector', spot!.x, spot!.y, [], [{ x: pose.x, y: pose.y, radius: rec.radius }]), 'the circle alone refuses it').toBe('overlap-obstacle');
    room.send('place_structure', { type: 'place_structure', kind: 'connector', x: spot!.x, y: spot!.y });
    await harness.advance(200);
    expect(internals.structureRegistry.size, 'connector off the outline lands').toBe(1);
  }, 25_000);

  it('auto-connects two connectors whose line passes inside a live rock’s circle but clear of its outline (C5c)', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      scenarioAsteroids: [{ x: -3000, y: 0, radius: 600 }],
    });
    const room = await harness.connectAs('player-1');
    await harness.advance(300);
    const internals = harness.getServerRoom()!._internals;
    const rec = [...internals.swarmRegistry.all()].find((r) => r.kind === 0)!;
    const pose = rec.lastBroadcast, { hw, hh } = structureHalfExtents('connector', 0);
    const rock: GridObstacle = { x: pose.x, y: pose.y, radius: rec.radius, angle: pose.angle, parts: [rec.vertices!] };
    const circleOnly: GridObstacle = { x: pose.x, y: pose.y, radius: rec.radius };
    const at = (id: string, x: number, y: number): GridNode => ({ id, x, y, radius: Math.max(hw, hh), halfW: hw, halfH: hh, isHub: true, isCapital: false, isConnector: true, maxConnections: 6, powerOutput: 0, powerConsumption: 0, isConstructed: false });
    // Candidate spots around the rock that placement (outline narrow phase) accepts.
    const spots: { x: number; y: number }[] = [];
    for (let k = 0; k < 72; k++) {
      for (let j = 0; j < 6; j++) {
        const a = (k / 72) * Math.PI * 2, d = rec.radius * (0.85 + 0.08 * j);
        const x = pose.x + Math.cos(a) * d, y = pose.y + Math.sin(a) * d;
        if (placementRejection('connector', x, y, [], [rock]) === null) spots.push({ x, y });
      }
    }
    // A pair in range, footprints apart, whose line runs INSIDE the circle but
    // misses the outline: the circle's box alone would refuse the link.
    let pair: [{ x: number; y: number }, { x: number; y: number }] | null = null;
    for (let i = 0; i < spots.length && pair === null; i++) {
      for (let j = i + 1; j < spots.length && pair === null; j++) {
        const p = spots[i]!, q = spots[j]!;
        const ex = Math.max(0, Math.abs(p.x - q.x) - 2 * hw), ey = Math.max(0, Math.abs(p.y - q.y) - 2 * hh);
        if (ex === 0 && ey === 0) continue; // footprints overlap
        if (Math.hypot(ex, ey) > CONNECTION_MAX_RANGE * 0.9) continue;
        const dx = q.x - p.x, dy = q.y - p.y, t = Math.max(0, Math.min(1, ((pose.x - p.x) * dx + (pose.y - p.y) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(p.x + dx * t - pose.x, p.y + dy * t - pose.y) > rec.radius * 0.97) continue; // must pass inside the circle
        const A = at('A', p.x, p.y), B = at('B', q.x, q.y), nodes = new Map([['A', A], ['B', B]]);
        // Clear of the outline, tested on its own (not through the code under test).
        const len = Math.hypot(dx, dy), offOutline = rayHitsConvexPolygon(p.x, p.y, dx / len, dy / len, len, pose.x, pose.y, pose.angle, rec.vertices!) === null;
        if (offOutline && isConnectionLineBlocked(A, B, nodes, [circleOnly])) pair = [p, q];
      }
    }
    expect(pair, 'two spots whose line crosses the circle but not the outline').not.toBeNull();
    room.send('place_structure', { type: 'place_structure', kind: 'connector', x: pair![0].x, y: pair![0].y });
    await harness.advance(200);
    room.send('place_structure', { type: 'place_structure', kind: 'connector', x: pair![1].x, y: pair![1].y });
    await harness.advance(200);
    const placed = [...internals.structureRegistry.all()];
    expect(placed.length, 'both connectors land').toBe(2);
    const [s0, s1] = placed;
    expect(internals.structureRegistry.connectionsOf(s1!.id).some((c) => c.getOtherNode(s1!.id) === s0!.id), 'the link clears the rock’s real outline').toBe(true);
  }, 25_000);
});
