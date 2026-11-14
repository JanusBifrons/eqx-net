/**
 * Fire control — the client's fire pass measures range per mount to the
 * target's hull, like the server (#15, #19).
 *
 * Owner decision (2026-11-14): fire range is measured from each turret to the
 * nearest point of the target's true hull. The client's capital pass
 * (`fcFireMounts`) measured mount → target CENTRE against reach × √1.1, so a
 * battleship's AA (reach ~1,428 u) never fired at a battleship lying alongside
 * (centres 1,700 u apart, hull ~1,200 u from the starboard AA): the client
 * never sent the shot. The server's gate (`SectorRoom.mountBearsOnLock`) and
 * these passes now call the one `mountFiresOn`, on a target shape both sides
 * fill with the one `fillFireTargetShape`.
 *
 * Locks: (1) the AA salvo against a battleship alongside is exactly the set of
 * mounts the shared gate passes for the server's view of that target, and is
 * not empty; (2) a drone out of every AA mount's reach gets no salvo; (3) the
 * client's target shape equals the server-side fill for ships (shield up and
 * down), structures and pilots.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import {
  fillFireTargetShape, mountFiresOn, newFireTargetShape, type FireTargetShape,
} from '@core/combat/fireControlBearing';
import { mountWeaponReach } from '@core/combat/mountReach';
import { getShipKind } from '@shared-types/shipKinds';
import type { SwarmRenderState } from '@core/contracts/IRenderer';

interface Internals {
  room: { send: (type: string, msg: unknown) => void } | null;
  predWorld: { getShipState: (id: string) => { x: number; y: number; angle: number } | null } | null;
  predEnergy: number;
  inputTick: number;
  _fcGroups: ReadonlyArray<{ id: string; m: number; l: ReadonlyArray<{ t: string; s: number; p: number }> }>;
  _fcSalvo: Set<string>;
  sendFire: (tick: number) => void;
  fcFireTick: (spaceHeld: boolean) => void;
  fcTargetPose: (key: string, out: FireTargetShape) => boolean;
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string; mountAngles?: number[]; shieldDown?: boolean }>;
    swarm: Map<number, SwarmRenderState>;
    localPlayerId: string | null;
  };
}

const ME = 'me';
const wrap = (a: number): number => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;

function swarmShip(shipKind: string, x: number, y: number, shieldDown = false): SwarmRenderState {
  return { kind: 1, shipKind, x, y, vx: 0, vy: 0, angle: 0, radius: getShipKind(shipKind).radius, shieldDown } as unknown as SwarmRenderState;
}

describe('client fire pass: per-mount range to the hull (fcFireMounts)', () => {
  let client: ColyseusGameClient;
  let c: Internals;
  let salvos: string[][];

  beforeEach(() => {
    client = new ColyseusGameClient();
    c = client as unknown as Internals;
    c.room = { send: vi.fn() };
    c.predWorld = { getShipState: () => ({ x: 0, y: 0, angle: 0 }) };
    c.predEnergy = 1e9;
    c.inputTick = 1000;
    c.mirror.localPlayerId = ME;
    c.mirror.swarm = new Map();
    salvos = [];
    c.sendFire = () => { salvos.push([...c._fcSalvo]); };
  });

  /** Own battleship at the origin facing +y, every turret trained on (tx, ty). */
  function placeOwnShip(tx: number, ty: number): void {
    const mounts = getShipKind('battleship').mounts;
    const mountAngles = mounts.map((m) => wrap(Math.atan2(-(tx - m.localX), ty - m.localY) - m.baseAngle));
    c.mirror.ships.set(ME, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'battleship', mountAngles });
    c._fcGroups = [{ id: 'aa', m: 0, l: [{ t: 's:1', s: 2, p: 100 }] }];
  }

  /** The AA mounts the shared gate passes for the SERVER's view of the target. */
  function serverAaMounts(e: SwarmRenderState): string[] {
    const kind = getShipKind('battleship');
    const aa = new Set(kind.slots!.find((s) => s.id === 'aa')!.mountIds);
    const t = newFireTargetShape();
    // SectorRoom.fillSwarmFireShape's inputs: rec.kind, rec.shipKind, !rec.shieldDown, rec.radius.
    fillFireTargetShape(t, e.x, e.y, e.angle, e.kind === 1, e.shipKind ?? null, e.shieldDown !== true, e.radius);
    const angles = c.mirror.ships.get(ME)!.mountAngles!;
    const out: string[] = [];
    kind.mounts.forEach((m, i) => {
      if (!aa.has(m.id)) return;
      if (mountFiresOn(m.weaponId, mountWeaponReach(m), m.localX, m.localY, m.baseAngle + angles[i]!, t)) out.push(m.id);
    });
    return out;
  }

  it('the AA fires at a battleship alongside whose hull is in reach (centres 1.7 km apart)', () => {
    const target = swarmShip('battleship', 1_700, 0);
    c.mirror.swarm.set(1, target);
    placeOwnShip(1_700, 0);
    c.fcFireTick(false);
    const want = serverAaMounts(target);
    expect(want, 'the shared gate passes some starboard AA mount').toContain('aa-s1');
    expect(salvos.length, 'the client sent the AA salvo').toBe(1);
    expect(new Set(salvos[0])).toEqual(new Set(want));
  });

  it('no AA salvo at a drone out of every AA mount\'s reach', () => {
    const target = swarmShip('heavy', 1_550, 0);
    c.mirror.swarm.set(1, target);
    placeOwnShip(1_550, 0);
    c.fcFireTick(false);
    expect(serverAaMounts(target)).toEqual([]);
    expect(salvos.length).toBe(0);
  });

  it('the client target shape equals the server-side fill (#15)', () => {
    const got = newFireTargetShape();
    const want = newFireTargetShape();
    const cases: Array<[number, SwarmRenderState]> = [
      [1, swarmShip('fighter', 100, 200, false)],
      [2, swarmShip('heavy', -300, 50, true)],
      [3, { kind: 2, x: 40, y: -60, vx: 0, vy: 0, angle: 0.3, radius: 55 } as unknown as SwarmRenderState],
    ];
    for (const [id, e] of cases) {
      c.mirror.swarm.set(id, e);
      expect(c.fcTargetPose(`s:${id}`, got)).toBe(true);
      fillFireTargetShape(want, e.x, e.y, e.angle, e.kind === 1, e.shipKind ?? null, e.shieldDown !== true, e.radius);
      expect(got).toEqual(want);
    }
    // A pilot: server fills from ShipState (kind, shield > 0) + the pose cache.
    c.mirror.ships.set('other', { x: 5, y: 6, vx: 0, vy: 0, angle: 1, kind: 'gunship', shieldDown: true });
    expect(c.fcTargetPose('p:other', got)).toBe(true);
    fillFireTargetShape(want, 5, 6, 1, true, 'gunship', false, 0);
    expect(got).toEqual(want);
  });
});
