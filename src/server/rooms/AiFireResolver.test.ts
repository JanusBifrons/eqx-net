import { describe, it, expect } from 'vitest';
import { AiFireResolver, type AiFireResolverDeps } from './AiFireResolver.js';
import type { WeaponFireContext } from '../../core/combat/weapons/Weapon.js';
import type { ShipState } from './schema/SectorState.js';

/**
 * Wave-system Phase 2 — locks the drone-beam STRUCTURE pass added to
 * `AiFireResolver.hitscan`. We call `hitscan(ctx, range, damage)` directly with
 * a hand-built ray context (bypassing `resolve()`'s mount machinery — that path
 * is unchanged) so the test isolates exactly the new player+structure
 * closest-of-both selection. Mirrors the TransitOrchestrator hand-rolled-mock
 * pattern: minimal deps, no server, no IPC.
 */

interface Recorded {
  damage: Array<{ targetId: string; shooterId: string; damage: number }>;
  beams: Array<{ hit: boolean; targetId?: string }>;
}

function makeResolver(opts: {
  /** playerId → straight-line hit distance the stubbed `playerHitscanDist`
   *  returns (null ⇒ miss). */
  playerHits?: Map<string, number | null>;
  structures?: Array<{ id: string; x: number; y: number; radius: number }>;
}): { resolver: AiFireResolver; rec: Recorded } {
  const rec: Recorded = { damage: [], beams: [] };
  const playerHits = opts.playerHits ?? new Map<string, number | null>();
  const ships = new Map<string, ShipState>();
  const poses = new Map<string, { x: number; y: number; angle: number }>();
  for (const pid of playerHits.keys()) {
    ships.set(pid, { alive: true } as unknown as ShipState);
    poses.set(pid, { x: 0, y: 0, angle: 0 });
  }
  // `hitscan` calls getActiveShip(pid) then playerHitscanDist(ship, …) for the
  // SAME player in the loop, so we stash the last-probed id and resolve its
  // canned distance from `playerHits`.
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
    structureHitTargets: opts.structures ? () => opts.structures! : undefined,
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

describe('AiFireResolver.hitscan — structure pass (wave-system Phase 2)', () => {
  it('hits a hostile structure in the beam path when no players are present', () => {
    const { resolver, rec } = makeResolver({
      structures: [{ id: 'swarm-7', x: 100, y: 0, radius: 20 }],
    });
    resolver.hitscan(ray(), 500, 9);
    expect(rec.damage).toEqual([{ targetId: 'swarm-7', shooterId: '', damage: 9 }]);
    expect(rec.beams[0]).toEqual({ hit: true, targetId: 'swarm-7' });
  });

  it('picks the CLOSER of a player vs a structure (structure nearer → structure)', () => {
    const { resolver, rec } = makeResolver({
      playerHits: new Map([['p1', 300]]), // player at distance 300
      structures: [{ id: 'swarm-7', x: 100, y: 0, radius: 20 }], // structure entry ~80
    });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.damage).toEqual([{ targetId: 'swarm-7', shooterId: '', damage: 5 }]);
  });

  it('picks the CLOSER of a player vs a structure (player nearer → player)', () => {
    const { resolver, rec } = makeResolver({
      playerHits: new Map([['p1', 40]]), // player at distance 40
      structures: [{ id: 'swarm-7', x: 100, y: 0, radius: 20 }], // structure entry ~80
    });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.damage).toEqual([{ targetId: 'p1', shooterId: '', damage: 5 }]);
  });

  it('misses a structure outside the beam path', () => {
    const { resolver, rec } = makeResolver({
      structures: [{ id: 'swarm-7', x: 0, y: 100, radius: 20 }], // off-axis, ray is +x
    });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.damage).toEqual([]);
    expect(rec.beams[0]).toEqual({ hit: false, targetId: undefined });
  });

  it('no structureHitTargets dep ⇒ players-only (byte-identical to pre-wave)', () => {
    const { resolver, rec } = makeResolver({ playerHits: new Map([['p1', 40]]) });
    resolver.hitscan(ray(), 500, 5);
    expect(rec.damage).toEqual([{ targetId: 'p1', shooterId: '', damage: 5 }]);
  });
});
