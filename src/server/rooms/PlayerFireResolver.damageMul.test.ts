import { describe, it, expect } from 'vitest';
import { PlayerFireResolver, type PlayerFireResolverDeps } from './PlayerFireResolver.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import type { ShipState } from './schema/SectorState.js';
import type { StatAlloc } from '../../core/leveling/shipStats.js';
import type { Client } from 'colyseus';

/**
 * MUST-FIX #1 (Phase 4 review, plan: effervescent-umbrella) — `mul.damage` is
 * applied to OUTGOING PLAYER weapon damage. Before the fix, spending points on
 * the `damage` stat was a SILENT no-op (a player shot from an upgraded ship
 * dealt the catalogue base damage). This drives the FULL `resolve()` fire path
 * (the only path that reads `ship.statAlloc`) and captures the projectile/
 * applyDamage damage so an upgraded shooter is proven to deal MORE.
 *
 * Hand-rolled-mock pattern (mirrors AiFireResolver.test.ts): minimal deps, no
 * server, no IPC. The fighter's mount fires the `laser` PROJECTILE weapon, so
 * the outgoing damage lands on `spawnServerProjectile`'s damage arg.
 */

interface Recorded {
  projectiles: Array<{ damage: number }>;
  hitscanDamage: Array<{ targetId: string; damage: number }>;
}

function makeResolver(statAlloc: StatAlloc): {
  resolver: PlayerFireResolver;
  ship: ShipState;
  rec: Recorded;
  fire: () => void;
} {
  const rec: Recorded = { projectiles: [], hitscanDamage: [] };
  const fighterKind = getShipKind('fighter');
  const ship = {
    kind: 'fighter',
    alive: true,
    energy: 1000,
    statAlloc,
    mounts: [],
  } as unknown as ShipState;

  const deps: PlayerFireResolverDeps = {
    sabF32: new Float32Array(0),
    serverTick: () => 100,
    sessionToPlayer: new Map([['sess', 'p1']]),
    getActiveShip: (pid) => (pid === 'p1' ? ship : undefined),
    lastFireClientTick: new Map(),
    snapshotRing: { getPoseAt: () => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 }) },
    shipPoseCache: new Map([['p1', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 } as never]]),
    playerToSlot: new Map<string, number>(),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    swarmRegistry: { get: () => null, all: () => [] },
    playerMountAngles: new Map(),
    resolveSlotMounts: (kind: ShipKind) => kind.mounts,
    resolveInstanceMounts: () => fighterKind.mounts,
    resolveInstanceFireMounts: () => fighterKind.mounts,
    mountWorldOrigin: (x, y) => ({ x, y }),
    playerHitscanDist: () => null,
    spawnServerProjectile: (_o, _x, _y, _vx, _vy, damage) => rec.projectiles.push({ damage }),
    spawnServerMissile: () => null,
    applyDamage: (targetId, _s, damage) => rec.hitscanDamage.push({ targetId, damage }),
    broadcast: () => {},
    serverLogEvent: () => {},
    logger: { warn: () => {}, info: () => {} } as never,
  };

  const resolver = new PlayerFireResolver(deps);
  const client = { sessionId: 'sess', send: () => {} } as unknown as Client;
  const fire = () =>
    resolver.resolve(client, {
      type: 'fire',
      tick: 100,
      clientShotId: 'shot-1',
      weapon: 'hitscan',
      dirAngle: 0,
    });
  return { resolver, ship, rec, fire };
}

describe('PlayerFireResolver — outgoing player damage scales with mul.damage', () => {
  const baseDamage = getWeapon(getShipKind('fighter').mounts[0]!.weaponId).damage;

  it('an un-upgraded shooter deals the catalogue base damage', () => {
    const { rec, fire } = makeResolver({});
    fire();
    expect(rec.projectiles).toHaveLength(1);
    expect(rec.projectiles[0]!.damage).toBeCloseTo(baseDamage, 6);
  });

  it('a damage-upgraded shooter deals MORE than the base (the dead-code fix)', () => {
    // 4 damage points ⇒ +20 % (STAT_POINT_FRAC 0.05 × 4).
    const { rec, fire } = makeResolver({ damage: 4 });
    fire();
    expect(rec.projectiles).toHaveLength(1);
    expect(rec.projectiles[0]!.damage).toBeCloseTo(baseDamage * 1.2, 6);
    expect(rec.projectiles[0]!.damage).toBeGreaterThan(baseDamage);
  });
});
