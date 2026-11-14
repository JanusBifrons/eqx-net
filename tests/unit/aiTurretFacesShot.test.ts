/**
 * An AI pilot's guns fire where they are drawn (owner, watching the
 * 2026-11-14 fight clips npc-dogfight / fleet-melee: "The turrets also
 * aren't turning to shoot the direction they do").
 *
 * Two mismatches, both server-side:
 *  1. A TURRET ship (interceptor wings, gunship) only trained its turrets on
 *     hostile PILOTS (`WeaponMountTicker.tickDrone` picked among players), so
 *     in a ship-vs-ship fight (drones vs robots) the turrets sat at rest while
 *     the pilot fired: its fire gate was the hull cone PLUS the turret's arc,
 *     and since #572 the shot leaves down the barrel, so it went off at rest.
 *  2. A FIXED nose gun (fighter, scout, heavy, every robot) fired along the
 *     AI's exact lead vector, anywhere inside a 14°-26° hull cone, while the
 *     drawn nose gun points straight ahead.
 *
 * Rule now (the pilot's rule, #19): every AI shot leaves down its drawn barrel
 * (hull + base + the slewed angle the snapshot carries), and only a barrel
 * that bears (`mountFireTolerance`) fires; the AI pilot's turrets train on the
 * lead point it is fighting, whatever that target is.
 */
import { describe, expect, it } from 'vitest';
import { AiFireResolver, type AiFireResolverDeps } from '../../src/server/rooms/AiFireResolver';
import { mountWorldOrigin } from '../../src/server/rooms/mountGeometry';
import { WeaponMountTicker, type SwarmRecord } from '../../src/server/rooms/WeaponMountTicker';
import { HostileDroneBehaviour } from '../../src/core/ai/HostileDroneBehaviour';
import { wrapPi } from '../../src/core/ai/WeaponMountController';
import { FC_MOUNT_FIRE_TOLERANCE } from '../../src/core/combat/fireControlBearing';
import { getShipKind, type ShipKindId } from '../../src/shared-types/shipKinds';
import { SAB_TOTAL_BYTES, SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../src/shared-types/sabLayout';
import type { LaserFiredEvent } from '../../src/shared-types/messages';
import type { ShipState } from '../../src/server/rooms/schema/SectorState';

/** Ship angle convention: 0 = +y, forward = (-sin a, cos a). */
const fwd = (a: number): { x: number; y: number } => ({ x: -Math.sin(a), y: Math.cos(a) });
const angleOf = (x: number, y: number): number => Math.atan2(-x, y);

function resolverFor(kindId: ShipKindId, hullAngle: number, mountAngles?: Float32Array) {
  const shots: Array<{ vx: number; vy: number }> = [];
  const beams: LaserFiredEvent[] = [];
  const lastFire = new Map<string, number>();
  const deps: AiFireResolverDeps = {
    lastFireClientTick: lastFire,
    swarmEntitySnapshot: (id) => (id === 'd' ? { id, x: 0, y: 0, vx: 0, vy: 0, angle: hullAngle, angvel: 0 } : null),
    swarmRegistry: { get: (id) => (id === 'd' ? { entityId: 1, shipKind: kindId } : null) },
    resolveSlotMounts: (kind) => kind.mounts ?? [],
    mountWorldOrigin,
    droneMountAngles: mountAngles ? new Map([['d', mountAngles]]) : new Map(),
    playerToSlot: new Map(),
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    playerHitscanDist: () => null,
    applyDamage: () => {},
    broadcast: (_t, msg) => beams.push({ ...msg }),
    spawnServerProjectile: (_o, _x, _y, vx, vy) => shots.push({ vx, vy }),
    spawnServerMissile: () => null,
  };
  return { resolver: new AiFireResolver(deps), shots, beams, lastFire };
}

describe('AI fire leaves down the drawn barrel', () => {
  it('a fixed nose gun fires along the hull (its drawn gun), not the lead vector', () => {
    const hull = 0.4;
    const { resolver, shots } = resolverFor('robot-square', hull);
    const aim = fwd(hull + 0.15); // inside the gun's bearing window
    resolver.resolve('d', aim.x, aim.y, 1000, 't');
    expect(shots).toHaveLength(1);
    const off = wrapPi(angleOf(shots[0]!.vx, shots[0]!.vy) - hull);
    expect(Math.abs(off), `bolt left ${off.toFixed(3)} rad off the drawn nose gun`).toBeLessThan(1e-6);
  });

  it('a fixed nose gun that does not bear holds fire and spends no cooldown', () => {
    const { resolver, shots, lastFire } = resolverFor('robot-square', 0);
    const aim = fwd(0.4); // the old point-blank cone allowed this
    resolver.resolve('d', aim.x, aim.y, 1000, 't');
    expect(shots).toHaveLength(0);
    expect(lastFire.has('d'), 'cooldown spent on a held shot').toBe(false);
  });

  it('a barrel fires only inside the cone the target hull covers (the AI pilot\'s cone)', () => {
    const outside = resolverFor('robot-square', 0);
    const aim = fwd(0.1); // inside the 0.2 rad window, outside a 0.05 rad hull cone
    outside.resolver.resolve('d', aim.x, aim.y, 1000, 't', 0.05);
    expect(outside.shots).toHaveLength(0);
    expect(outside.lastFire.has('d'), 'cooldown spent on a held shot').toBe(false);
    const inside = resolverFor('robot-square', 0);
    inside.resolver.resolve('d', aim.x, aim.y, 1000, 't', 0.15);
    expect(inside.shots).toHaveLength(1);
    // A cone wider than the window never widens it.
    const wide = resolverFor('robot-square', 0);
    const off = fwd(FC_MOUNT_FIRE_TOLERANCE * 1.2);
    wide.resolver.resolve('d', off.x, off.y, 1000, 't', 1);
    expect(wide.shots).toHaveLength(0);
  });

  it('turrets still at rest do not fire at a target off the nose (they must train first)', () => {
    const kind = getShipKind('interceptor');
    const { resolver, beams } = resolverFor('interceptor', 0, new Float32Array(kind.mounts.length));
    const aim = fwd(0.45); // inside the wing arc, outside the barrel's window
    resolver.resolve('d', aim.x, aim.y, 1000, 't');
    expect(beams, 'a beam fired down a turret pointing elsewhere').toHaveLength(0);
  });

  it('turrets trained on the aim fire, each beam down its barrel', () => {
    const kind = getShipKind('interceptor');
    const bearing = 0.45;
    const { resolver, beams } = resolverFor('interceptor', 0, new Float32Array(kind.mounts.length).fill(bearing));
    const aim = fwd(bearing);
    resolver.resolve('d', aim.x, aim.y, 1000, 't');
    expect(beams).toHaveLength(kind.mounts.length);
    for (const b of beams) {
      const m = kind.mounts.find((x) => x.id === b.mountId)!;
      const off = wrapPi(angleOf(b.toX - b.fromX, b.toY - b.fromY) - (m.baseAngle + bearing));
      expect(Math.abs(off)).toBeLessThan(1e-5);
    }
  });
});

describe('an AI pilot trains its turrets on the fight it is in', () => {
  it('an interceptor fighting another ship (no pilot anywhere) slews its wings onto the aim point', () => {
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(7);
    sab[b + SLOT_X_OFF] = 0;
    sab[b + SLOT_Y_OFF] = 0;
    sab[b + SLOT_ANGLE_OFF] = 0;
    const recs: SwarmRecord[] = [{ id: 'd', slot: 7, kind: 1, shipKind: 'interceptor' }];
    const target = { x: -Math.sin(0.4) * 300, y: Math.cos(0.4) * 300 };
    const pilot = {
      hostileTo: new Set<string>(),
      aimPoint: (out: { x: number; y: number }) => { out.x = target.x; out.y = target.y; return true; },
    };
    const t = new WeaponMountTicker({
      sabF32: sab,
      playerToSlot: new Map(),
      swarmRegistry: { all: () => recs, size: () => 1 },
      shipPoseCache: new Map(),
      getActiveShip: () => undefined as unknown as ShipState,
      aiController: { getBehaviour: () => pilot },
      swarmHealth: () => new Map(),
      resolveSlotMounts: (k) => k.mounts,
      resolveInstanceMounts: () => [],
      resolveInstanceFireMounts: () => [],
    });
    for (let i = 0; i < 30; i++) t.tickDrone();
    const kind = getShipKind('interceptor');
    const angles = t.droneMountAngles.get('d')!;
    for (let i = 0; i < kind.mounts.length; i++) {
      const m = kind.mounts[i]!;
      const want = angleOf(target.x - m.localX, target.y - m.localY);
      const off = Math.abs(wrapPi(m.baseAngle + angles[i]! - want));
      expect(off, `${m.id} still ${off.toFixed(3)} rad off the aim point`).toBeLessThan(0.01);
    }
  });

  it('the brain reports the lead point it fights at, and nothing out of combat', () => {
    const brain = new HostileDroneBehaviour('interceptor');
    const out = { x: 0, y: 0 };
    const view = (tick: number) => ({ players: [{ id: 'p', x: 50, y: 120, vx: 0, vy: 0 }], tick, dtSec: 1 / 60 });
    const self = { id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    brain.tick(self, view(10));
    expect(brain.aimPoint(out), 'not hostile yet: no aim').toBe(false);
    brain.markHostile('p', 10);
    brain.tick(self, view(11));
    expect(brain.aimPoint(out)).toBe(true);
    // A beam has no lead: the aim is the target itself.
    expect(Math.hypot(out.x - 50, out.y - 120)).toBeLessThan(1);
  });

  it('a fixed-gun AI pilot pulls the trigger only when its nose bears (the pilot window)', () => {
    const at = (bearing: number): boolean => {
      const brain = new HostileDroneBehaviour('fighter');
      brain.markHostile('p', 0);
      const d = 40; // point-blank: the old cone was 0.45 rad here
      const p = { id: 'p', x: -Math.sin(bearing) * d, y: Math.cos(bearing) * d, vx: 0, vy: 0 };
      const intent = brain.tick({ id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, { players: [p], tick: 100, dtSec: 1 / 60 });
      return intent.fire !== undefined;
    };
    expect(at(FC_MOUNT_FIRE_TOLERANCE * 0.5)).toBe(true);
    expect(at(0.3)).toBe(false);
  });
});
