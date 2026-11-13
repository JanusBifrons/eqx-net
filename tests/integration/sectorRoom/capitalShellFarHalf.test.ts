/**
 * Found 2026-11-13 while building wreck knock-back (PR #542): shells could
 * pass straight through the FAR half of a capital's hull.
 *
 * Reproduction: an NPC battleship at the origin (angle 0, keel along y). A
 * real naval shell (`naval_m`, 1,500 u/s, so 25 u a tick) is fired along the
 * hull's length from beside midships toward the stern, or obliquely so it
 * reaches the hull only after passing its closest approach to the centre.
 * Before the fix it flew through the battleship and hit nothing.
 *
 * Root cause: the capital hull refinement (`refineSweepHit`) only ran when the
 * step hit the bounding circle per `rayHitsSphere`, which returns null once the
 * step's origin is inside the circle and past its closest approach to the
 * centre. ProjectilePipeline sweeps one segment a tick, so every step past that
 * point skipped the polygon test. Fixed by gating on `segmentNearCircle`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

type Hit = { target: string; shooter: string };

/** Record every applyDamage on the server room (then apply it as normal). */
function recordHits(room: unknown): Hit[] {
  const hits: Hit[] = [];
  const r = room as { applyDamage: (t: string, s: string, ...rest: unknown[]) => void };
  const orig = r.applyDamage.bind(r);
  r.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
    hits.push({ target: t, shooter: s });
    orig(t, s, ...rest);
  };
  return hits;
}

const R = getShipKind('battleship').radius;
const SPEED = 1500;

const CASES: Array<{ name: string; x: number; y: number; dx: number; dy: number }> = [
  // Along the length: from beside midships (outside the ~0.12 R beam), angled
  // in so it meets the keel near the stern.
  { name: 'along its length, midships to stern', x: R * 0.2, y: 0, dx: -0.25, dy: -1 },
  // From outside the circle, crossing the keel at (0, -0.55 R); its closest
  // approach to the centre (0.275 R, -0.275 R) is beside the hull.
  { name: 'obliquely, reaching the hull past the centre', x: Math.SQRT1_2 * R * 1.6, y: -R * 0.55 + Math.SQRT1_2 * R * 1.6, dx: -1, dy: -1 },
];

describe('SectorRoom integration — a shell hits the far half of a capital hull', () => {
  let harness: SectorTestHarness | null = null;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  }, 10_000);

  for (const c of CASES) {
    it(`a naval shell fired ${c.name} hits the battleship`, { timeout: 30_000 }, async () => {
      harness = await bootSectorTestServer({ sectorKey: null, droneCount: 0, asteroidConfig: [], testMode: true });
      await harness.connectAs(randomUUID());
      const room = harness.getServerRoom()!;
      const internals = room._internals;
      expect(internals.spawnTestDrone('far-bb', 0, 0, 'battleship')).toBe(true);
      await harness.advance(100);
      const hits = recordHits(room);
      const n = Math.hypot(c.dx, c.dy);
      internals.spawnTestProjectile('far-shooter', c.x, c.y, (c.dx / n) * SPEED, (c.dy / n) * SPEED, 'naval_m', 50);
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !hits.some((h) => h.shooter === 'far-shooter')) await harness.advance(50);
      const mine = hits.filter((h) => h.shooter === 'far-shooter');
      expect(mine.map((h) => h.target), 'the shell flew through the battleship\'s far half').toContain('far-bb');
    });
  }
});
