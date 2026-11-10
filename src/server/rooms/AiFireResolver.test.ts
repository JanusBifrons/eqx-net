import { describe, it, expect } from 'vitest';
import { AiFireResolver, type AiFireResolverDeps } from './AiFireResolver.js';
import type { WeaponFireContext } from '../../core/combat/weapons/Weapon.js';
import type { ShipState } from './schema/SectorState.js';

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
