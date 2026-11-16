/**
 * Mining-tool range gradient parity (#15, owner 2026-11-16, plan
 * partitioned-chasing-lark): a mining laser's fire gate reach scales with its
 * mount size (`mountWeaponReach`: XL keeps 12,000 u, S ≈ 5,455 u). The server's
 * player fire gate (`SectorRoom.mountBearsOnLock`, via `PlayerFireResolver`)
 * and the client's ghost gate (`ColyseusGameClient.fcMountBears`) must give the
 * same answer for the same mount and target, or the client predicts beams the
 * server refuses (or misses ones it fires). Fails when either side drops the
 * mount size.
 */
import { describe, it, expect } from 'vitest';
import { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { ColyseusGameClient } from '../../../src/client/net/ColyseusClient.js';
import { fillFireTargetShape, newFireTargetShape, type FireTargetShape } from '../../../src/core/combat/fireControlBearing.js';
import { mountWeaponReach } from '../../../src/core/combat/mountReach.js';
import type { WeaponMount } from '../../../src/shared-types/shipKinds.js';
import type { WeaponId } from '../../../src/core/combat/WeaponCatalogue.js';

type Size = WeaponMount['size'];
type Gate = (mountId: string, weaponId: WeaponId, size: Size, ox: number, oy: number, angle: number) => boolean;

/** A rock (kindless circle, radius 0) dead ahead of a mount at the origin
 *  facing +y, `d` units out. */
function fillRock(out: FireTargetShape, d: number): boolean {
  fillFireTargetShape(out, 0, d, 0, false, null, false, 0);
  return true;
}

/** The server gate, on a room stub whose lock resolves to the rock. */
function serverGate(d: number): Gate {
  const self = {
    _lockTarget: newFireTargetShape(),
    locksFor: () => ({ aimKeyFor: () => 'r:1' }),
    lockOwner: (pid: string) => pid,
    resolveLockTarget: (_owner: string, _key: string, out: FireTargetShape) => fillRock(out, d),
  };
  const fn = (SectorRoom.prototype as unknown as Record<string, (...a: unknown[]) => boolean>)['mountBearsOnLock']!;
  return (mountId, weaponId, size, ox, oy, angle) => fn.call(self, 'p1', mountId, ox, oy, angle, weaponId, size);
}

/** The client gate, on a client stub whose group aim resolves to the rock. */
function clientGate(d: number): Gate {
  const self = Object.create(ColyseusGameClient.prototype) as Record<string, unknown>;
  Object.assign(self, {
    _fcSalvo: new Set<string>(),
    _fcBearPose: newFireTargetShape(),
    mirror: { localPlayerId: null, ships: new Map() },
    fcMountAimKey: () => 'r:1',
    fcTargetPose: (_key: string, out: FireTargetShape) => fillRock(out, d),
  });
  const fn = self['fcMountBears'] as (...a: unknown[]) => boolean;
  return (mountId, weaponId, size, ox, oy, angle) => fn.call(self, mountId, weaponId, size, ox, oy, angle);
}

describe('mining laser reach by mount size: server and client fire gates agree (#15)', () => {
  const sReach = mountWeaponReach({ weaponId: 'mining_laser', size: 'S' });
  const xlReach = mountWeaponReach({ weaponId: 'mining_laser', size: 'XL' });

  it('an XL mining laser fires at a rock an S one is refused at, on both sides', () => {
    const d = (sReach + xlReach) / 2; // ~8,700 u: inside XL, outside S
    const server = serverGate(d);
    const client = clientGate(d);
    for (const [size, want] of [['XL', true], ['S', false], [undefined, false]] as Array<[Size, boolean]>) {
      expect(server('mine-1', 'mining_laser', size, 0, 0, 0), `server, ${size ?? 'unsized'}`).toBe(want);
      expect(client('mine-1', 'mining_laser', size, 0, 0, 0), `client, ${size ?? 'unsized'}`).toBe(want);
    }
  });

  it('both sides agree across sizes and distances (mining laser, tractor, a gun)', () => {
    for (const weaponId of ['mining_laser', 'tractor', 'laser'] as WeaponId[]) {
      for (const size of ['AA', 'S', 'M', 'L', 'XL', undefined] as Size[]) {
        const reach = mountWeaponReach({ weaponId, size });
        for (const d of [reach * 0.98, reach * 1.02]) {
          const s = serverGate(d)('m', weaponId, size, 0, 0, 0);
          expect(clientGate(d)('m', weaponId, size, 0, 0, 0), `${weaponId} ${size ?? 'unsized'} @ ${Math.round(d)}`).toBe(s);
          expect(s).toBe(d < reach);
        }
      }
    }
  });
});
