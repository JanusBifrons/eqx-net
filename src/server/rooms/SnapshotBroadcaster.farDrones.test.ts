/**
 * Far drones' slim slice (real-scale ranges known gap, docs/architecture/
 * real-scale-ranges.md). The `drones[]` slice used to cover only the
 * recipient's interest window, so a drone 10 km out drew as neutral and
 * undamaged even while it was hunting the pilot and half dead. Now a FAR tier
 * (drones outside interest) carries just `hostile` and `hp`, only when one of
 * them has something to say, at 2 Hz per recipient (`FAR_DRONE_SLICE_EVERY`):
 * the hostility ledger forgets in tens of seconds and hp moves slowly, so the
 * full 20 Hz would only add bytes (#16: the snapshot alone still converges).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, FAR_DRONE_SLICE_EVERY, type SnapshotBroadcasterDeps, type SwarmDroneRec } from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import { getDroneMaxHealth } from './droneKindHelpers.js';

const PID = 'pilot-a';
const SID = `s-${PID}`;

interface Drone extends SwarmDroneRec { entityId: number }

function setup(drones: Drone[], hostileIds: Set<string>, health: Map<string, number>): {
  b: SnapshotBroadcaster;
  snaps: Array<NonNullable<SnapshotMessage['drones']>>;
} {
  const byEid = new Map<number, Drone>();
  for (const d of drones) byEid.set(d.entityId, d);
  const ship = {
    alive: true, isActive: true, shipInstanceId: `inst-${PID}`, playerId: PID, kind: 'fighter',
    level: 1, mounts: [], warp: 0, poseEpoch: 0, shield: 1,
  } as unknown as ShipState;
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {}, child: () => stubLogger,
  } as unknown as Logger;
  const snaps: Array<NonNullable<SnapshotMessage['drones']>> = [];
  const deps = {
    serverTick: () => 100,
    sabU32: new Uint32Array(1024),
    clients: [{ sessionId: SID, socket: { bufferedAmount: 0 }, send: vi.fn(), leave: vi.fn() }] as unknown as ClientArray<Client>,
    sessionToPlayer: new Map([[SID, PID]]),
    playerToSlot: new Map([[PID, 0]]),
    getActiveShip: () => ship,
    shipPoseCache: new Map<string, ShipPhysicsState>([[PID, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }]]),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    shipsMap: new Map([[PID, ship]]) as unknown as MapSchema<ShipState>,
    liveProjectiles: new Map(),
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    swarmRegistry: {
      getByEntityId: (eid: number) => byEid.get(eid) ?? null,
      forEachRecord: (visit: (rec: Drone) => void) => { for (const d of drones) visit(d); },
    },
    swarmHealth: health,
    isDroneHostileTo: (id: string, pid: string) => pid === PID && hostileIds.has(id),
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* none */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
    sendSnapshot: (_c: Client, snap: SnapshotMessage) => {
      snaps.push((snap.drones ?? []).map((d) => ({ ...d })));
    },
  } as unknown as SnapshotBroadcasterDeps;
  return { b: new SnapshotBroadcaster(deps), snaps };
}

const fighterMax = getDroneMaxHealth('fighter')!;

describe('SnapshotBroadcaster — far drones carry hostile + hp outside interest', () => {
  it('a far hostile, damaged drone reports hostile and hp (no turret angles); a quiet far drone stays silent', () => {
    const drones: Drone[] = [
      { id: 'd-hunter', kind: 1, entityId: 11, shipKind: 'fighter' },
      { id: 'd-hurt', kind: 1, entityId: 12, shipKind: 'fighter' },
      { id: 'd-quiet', kind: 1, entityId: 13, shipKind: 'fighter' },
      { id: 'rock', kind: 0, entityId: 14 },
    ];
    const { b, snaps } = setup(drones, new Set(['d-hunter']), new Map([['d-hurt', fighterMax / 2]]));
    for (let i = 0; i < 3 * FAR_DRONE_SLICE_EVERY * 2; i++) b.broadcast(false);

    const all = snaps.flat();
    const hunter = all.find((d) => d.id === 11);
    expect(hunter, 'the far hunter reaches the pilot').toBeDefined();
    expect(hunter!.hostile).toBe(true);
    expect(hunter!.mountAngles).toBeUndefined();
    const hurt = all.find((d) => d.id === 12);
    expect(hurt, 'the far damaged drone reaches the pilot').toBeDefined();
    expect(hurt!.hp).toBe(50);
    expect(hurt!.hostile).toBeFalsy();
    expect(all.some((d) => d.id === 13), 'a full-hull neutral far drone sends nothing').toBe(false);
    expect(all.some((d) => d.id === 14), 'asteroids never ride the drone slice').toBe(false);
  });

  it('rides one snapshot in FAR_DRONE_SLICE_EVERY, and never duplicates an in-interest drone', () => {
    const drones: Drone[] = [
      { id: 'd-near', kind: 1, entityId: 21, shipKind: 'fighter' },
      { id: 'd-far', kind: 1, entityId: 22, shipKind: 'fighter' },
    ];
    const { b, snaps } = setup(drones, new Set(['d-near', 'd-far']), new Map());
    b.interestScratch.set(SID, new Set([21]));
    for (let i = 0; i < 3 * FAR_DRONE_SLICE_EVERY * 4; i++) b.broadcast(false);

    expect(snaps.length).toBeGreaterThanOrEqual(FAR_DRONE_SLICE_EVERY * 4 - 1);
    const withFar = snaps.filter((s) => s.some((d) => d.id === 22)).length;
    expect(withFar).toBeGreaterThanOrEqual(3);
    expect(withFar).toBeLessThanOrEqual(5);
    for (const s of snaps) {
      expect(s.filter((d) => d.id === 21).length, 'the near drone rides once per snapshot').toBe(1);
    }
  });
});
