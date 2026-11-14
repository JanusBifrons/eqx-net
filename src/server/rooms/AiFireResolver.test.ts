import { describe, it, expect } from 'vitest';
import { AiFireResolver, type AiFireResolverDeps } from './AiFireResolver.js';
import type { WeaponFireContext } from '../../core/combat/weapons/Weapon.js';
import type { ShipState } from './schema/SectorState.js';
import type { LaserFiredEvent } from '../../shared-types/messages.js';
import { mountWorldOrigin } from './mountGeometry.js';
import { rayHitsSphere } from '../../core/combat/Weapons.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

/**
 * Locks the NPC beam's target selection in `AiFireResolver.hitscan`: the
 * closest of (players, every other thing in the path). Since friendly fire
 * (owner decision 2026-11-10) the non-player pass is the room's
 * `nonPlayerRayHit` (every swarm entity of ANY side + lingering hulls, minus
 * the shooter), replacing the old hostile-structure + other-allegiance passes.
 * We call `hitscan(ctx, range, damage)` directly with a hand-built ray.
 */

interface Recorded {
  damage: Array<{ targetId: string; shooterId: string; damage: number }>;
  beams: Array<{ hit: boolean; targetId?: string }>;
  skips: string[];
}

function makeResolver(opts: {
  /** playerId → straight-line hit distance the stubbed `playerHitscanDist`
   *  returns (null ⇒ miss). */
  playerHits?: Map<string, number | null>;
  /** Non-player things along the +x ray: id + distance. */
  others?: Array<{ id: string; dist: number }>;
}): { resolver: AiFireResolver; rec: Recorded } {
  const rec: Recorded = { damage: [], beams: [], skips: [] };
  const playerHits = opts.playerHits ?? new Map<string, number | null>();
  const ships = new Map<string, ShipState>();
  const poses = new Map<string, { x: number; y: number; angle: number }>();
  for (const pid of playerHits.keys()) {
    ships.set(pid, { alive: true } as unknown as ShipState);
    poses.set(pid, { x: 0, y: 0, angle: 0 });
  }
  let probedId = '';
  const deps: AiFireResolverDeps = {
    lastFireClientTick: new Map(),
    swarmEntitySnapshot: () => null,
    swarmRegistry: { get: () => null },
    resolveSlotMounts: () => [],
    mountWorldOrigin: (x, y) => ({ x, y }),
    droneMountAngles: new Map(),
    playerToSlot: new Map([...playerHits.keys()].map((pid) => [pid, 0])),
    getActiveShip: (pid) => {
      probedId = pid;
      return ships.get(pid);
    },
    shipPoseCache: poses,
    playerHitscanDist: () => playerHits.get(probedId) ?? null,
    applyDamage: (targetId, shooterId, damage) => rec.damage.push({ targetId, shooterId, damage }),
    nonPlayerRayHit: opts.others
      ? (_fx, _fy, _dx, _dy, maxDist, skipId) => {
        rec.skips.push(skipId);
        let best: { id: string; wireId: string; dist: number } | null = null;
        for (const o of opts.others!) {
          if (o.id === skipId || o.dist > maxDist) continue;
          if (best === null || o.dist < best.dist) best = { id: o.id, wireId: `swarm-${o.id}`, dist: o.dist };
        }
        return best;
      }
      : undefined,
    broadcast: (_type, msg) => rec.beams.push({ hit: msg.hit, targetId: msg.targetId }),
    spawnServerProjectile: () => {},
    spawnServerMissile: () => null,
  };
  return { resolver: new AiFireResolver(deps), rec };
}

/** A forward ray from the origin pointing +x. */
function ray(): WeaponFireContext {
  return { fromX: 0, fromY: 0, dirX: 1, dirY: 0, shooterVx: 0, shooterVy: 0, mountId: 'm0' };
}

describe('AiFireResolver.hitscan — first thing in the path', () => {
  it('hits a non-player thing (any side) when no players are present; wire id is the swarm key', () => {
    const { resolver, rec } = makeResolver({ others: [{ id: '7', dist: 80 }] });
    resolver.hitscan(ray(), 500, 9);
    expect(rec.damage).toEqual([{ targetId: '7', shooterId: '', damage: 9 }]);
    expect(rec.beams[0]).toEqual({ hit: true, targetId: 'swarm-7' });
  });

  it('picks the CLOSER of a player vs another thing (thing nearer → thing)', () => {
    const { resolver, rec } = makeResolver({
      playerHits: new Map([['p1', 300]]),
      others: [{ id: '7', dist: 80 }],
    });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.damage).toEqual([{ targetId: '7', shooterId: '', damage: 5 }]);
  });

  it('picks the CLOSER of a player vs another thing (player nearer → player)', () => {
    const { resolver, rec } = makeResolver({
      playerHits: new Map([['p1', 40]]),
      others: [{ id: '7', dist: 80 }],
    });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.damage).toEqual([{ targetId: 'p1', shooterId: '', damage: 5 }]);
  });

  it('nothing in the path ⇒ a miss', () => {
    const { resolver, rec } = makeResolver({ others: [] });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.damage).toEqual([]);
    expect(rec.beams[0]).toEqual({ hit: false, targetId: undefined });
  });

  it('asks the room to skip only the shooter itself', () => {
    const { resolver, rec } = makeResolver({ others: [{ id: '7', dist: 80 }] });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.skips).toEqual(['']); // the shooter id resolve() sets (unset here)
  });

  it('no nonPlayerRayHit dep ⇒ players only', () => {
    const { resolver, rec } = makeResolver({ playerHits: new Map([['p1', 40]]) });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.damage).toEqual([{ targetId: 'p1', shooterId: '', damage: 5 }]);
  });
});

/**
 * Beam overshoot (hostile review of filmed NPC fights, 2026-11-13): an NPC
 * interceptor's wing turrets were drawn ON the pilot, but the beam ran
 * straight past the ship to the edge of the screen. The client draws a
 * remote beam along the shooter's visible barrel (`PixiRenderer`: body
 * angle + mount.baseAngle + slewed mount angle) for the server's distance.
 * The server fired along the AI's AIM vector PLUS the slewed mount angle, so
 * a turret already turned onto the target fired at twice the body's bearing
 * error: a real server miss (full-range distance) drawn down the barrel,
 * straight through the target. The ray must leave along the barrel the
 * client draws (#15: the same angle on both sides of the wire).
 */
describe('AiFireResolver — a turret beam leaves along its visible barrel', () => {
  it('a wing turret slewed onto the pilot hits it, and the wire ray runs down the barrel', () => {
    const shooterId = 'drone-1';
    const bodyAngle = 0;
    // The pilot sits 0.35 rad off the nose, 200 u out (inside the ±30° wing arc).
    const bearing = 0.35;
    const tx = -Math.sin(bearing) * 200;
    const ty = Math.cos(bearing) * 200;
    const beams: LaserFiredEvent[] = [];
    const damage: string[] = [];
    const deps: AiFireResolverDeps = {
      lastFireClientTick: new Map(),
      swarmEntitySnapshot: (id) => (id === shooterId ? { id, x: 0, y: 0, vx: 0, vy: 0, angle: bodyAngle, angvel: 0 } : null),
      swarmRegistry: { get: (id) => (id === shooterId ? { entityId: 1, shipKind: 'interceptor' } : null) },
      resolveSlotMounts: (kind) => kind.mounts ?? [],
      mountWorldOrigin,
      // Both wing turrets have slewed onto the pilot (ship-relative angles).
      droneMountAngles: new Map([[shooterId, new Float32Array([bearing, bearing])]]),
      playerToSlot: new Map([['p1', 0]]),
      getActiveShip: () => ({ alive: true } as unknown as ShipState),
      shipPoseCache: new Map([['p1', { x: tx, y: ty, angle: 0 }]]),
      playerHitscanDist: (_s, fx, fy, dx, dy, md, cx, cy) => rayHitsSphere(fx, fy, dx, dy, md, cx, cy, 30), // a fighter-sized shield bubble
      applyDamage: (targetId) => damage.push(targetId),
      broadcast: (_t, msg) => beams.push({ ...msg }),
      spawnServerProjectile: () => {},
      spawnServerMissile: () => null,
    };
    const resolver = new AiFireResolver(deps);
    // The AI fires along its exact aim vector at the pilot.
    resolver.resolve(shooterId, tx, ty, 1000, 'p1');

    expect(beams).toHaveLength(2);
    const kind = getShipKind('interceptor');
    for (const b of beams) {
      expect(b.hit).toBe(true);
      expect(b.targetId).toBe('p1');
      // The wire ray's direction is the barrel the client draws.
      const mIdx = kind.mounts!.findIndex((m) => m.id === b.mountId);
      const drawn = bodyAngle + kind.mounts![mIdx]!.baseAngle + bearing;
      const len = Math.hypot(b.toX - b.fromX, b.toY - b.fromY);
      expect((b.toX - b.fromX) / len).toBeCloseTo(-Math.sin(drawn), 5);
      expect((b.toY - b.fromY) / len).toBeCloseTo(Math.cos(drawn), 5);
      // Ends at the pilot's shield, not at the weapon's max range.
      expect(len).toBeLessThan(200);
    }
    expect(damage).toEqual(['p1', 'p1']);
  });
});
