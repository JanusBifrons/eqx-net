/**
 * Charge-up on the wire (plan step 6): an in-interest AI ship with charging
 * mounts carries `drones[].chargingMask` + `chargeStartTick`, read from the
 * ONE per-mount store (`WeaponMountTicker.charges`); a ship that isn't
 * charging sends nothing for it, and the fields clear when the charge ends
 * (#16: a late joiner sees the charge from the snapshot alone).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps, type SwarmDroneRec } from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import { MountCharges, NOT_CHARGING } from './WeaponMountTicker.js';

const PID = 'pilot-a';
const SID = `s-${PID}`;

interface Drone extends SwarmDroneRec { entityId: number }

function setup(drones: Drone[], charges: MountCharges): {
  b: SnapshotBroadcaster;
  snaps: SnapshotMessage[];
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
  const snaps: SnapshotMessage[] = [];
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
    },
    swarmHealth: new Map(),
    isDroneHostileTo: () => false,
    droneCharges: charges,
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* none */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
    sendSnapshot: (_c: Client, snap: SnapshotMessage) => {
      snaps.push({ ...snap, drones: (snap.drones ?? []).map((d) => ({ ...d })) } as SnapshotMessage);
    },
  } as unknown as SnapshotBroadcasterDeps;
  return { b: new SnapshotBroadcaster(deps), snaps };
}

/** Broadcast until the recipient's next snapshot goes out (one per cadence). */
function nextSnap(b: SnapshotBroadcaster, snaps: SnapshotMessage[]): SnapshotMessage {
  const n = snaps.length;
  for (let i = 0; i < 12 && snaps.length === n; i++) b.broadcast(false);
  expect(snaps.length, 'a snapshot went out').toBeGreaterThan(n);
  return snaps.at(-1)!;
}

describe('SnapshotBroadcaster — a charging AI ship carries drones[].chargingMask + chargeStartTick', () => {
  it('reports the charging mounts and the earliest start; a quiet ship sends nothing; it clears when the charge ends', () => {
    const drones: Drone[] = [
      { id: 'ai-charge', kind: 1, entityId: 31, shipKind: 'battleship' },
      { id: 'ai-quiet', kind: 1, entityId: 32, shipKind: 'battleship' },
    ];
    const charges = new MountCharges();
    const starts = charges.startsFor('ai-charge', 6);
    starts[1] = 90;
    starts[4] = 75;
    charges.startsFor('ai-quiet', 6); // made, all idle
    const { b, snaps } = setup(drones, charges);
    b.interestScratch.set(SID, new Set([31, 32]));

    const first = nextSnap(b, snaps).drones ?? [];
    const charger = first.find((d) => d.id === 31);
    expect(charger, 'the charging AI ship rides the slice').toBeDefined();
    expect(charger!.chargingMask).toBe((1 << 1) | (1 << 4));
    expect(charger!.chargeStartTick).toBe(75);
    expect(first.some((d) => d.id === 32), 'an idle ship with nothing to report sends nothing').toBe(false);

    // The charges end (fired or cancelled): the next snapshot omits them.
    starts[1] = NOT_CHARGING;
    starts[4] = NOT_CHARGING;
    const second = nextSnap(b, snaps);
    expect((second.drones ?? []).some((d) => (d.chargingMask ?? 0) !== 0 || d.chargeStartTick !== undefined)).toBe(false);
  });

  it('per-mount starts: mounts that began apart carry chargeOffsets (one per set bit); together, none', () => {
    const drones: Drone[] = [{ id: 'rail-bb', kind: 1, entityId: 41, shipKind: 'battleship' }];
    const charges = new MountCharges();
    const starts = charges.startsFor('rail-bb', 6);
    starts[0] = 200;
    starts[2] = 140;
    starts[5] = 170;
    const { b, snaps } = setup(drones, charges);
    b.interestScratch.set(SID, new Set([41]));
    const d = (nextSnap(b, snaps).drones ?? []).find((x) => x.id === 41)!;
    expect(d.chargingMask).toBe((1 << 0) | (1 << 2) | (1 << 5));
    expect(d.chargeStartTick).toBe(140);
    // Lowest bit first: mount 0 (+60), mount 2 (+0), mount 5 (+30).
    expect(d.chargeOffsets).toEqual([60, 0, 30]);

    // All on the same tick: the default, so no offsets on the wire.
    starts[0] = 140;
    starts[5] = 140;
    const same = (nextSnap(b, snaps).drones ?? []).find((x) => x.id === 41)!;
    expect(same.chargeStartTick).toBe(140);
    expect(same.chargeOffsets).toBeUndefined();
  });
});
