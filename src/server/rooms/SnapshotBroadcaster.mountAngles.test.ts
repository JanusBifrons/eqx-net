/**
 * Each ship's turret angles ride its OWN snapshot entry (owner, three times:
 * "turrets still don't turn"; showcase take 9, fleet-melee: a drone fighter's
 * drawn nose gun sat in line with its hull while its shots left 15-20° off).
 *
 * The broadcaster pooled the `mountAngles` arrays by LENGTH, one array per
 * length, so every ship and drone with one turret (every nose turret since
 * the fighter, scout, heavy and robots got one) shared the same array within
 * a snapshot: each overwrote it, and the wire carried the LAST one's angle
 * for all of them. On film every AI pilot's nose gun was drawn at some other
 * ship's angle. The arrays are encoded when the recipient's snapshot is sent,
 * so this test copies them at send time exactly as the encoder reads them.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps, type SwarmDroneRec } from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

const PID = 'pilot-a';
const SID = `s-${PID}`;

interface Drone extends SwarmDroneRec { entityId: number }

type Sent = { drones: Array<{ id: number; mountAngles?: number[] }>; own?: number[] };

function setup(drones: Drone[], droneAngles: Map<string, Float32Array>, playerAngles: Map<string, Float32Array>): { b: SnapshotBroadcaster; sent: Sent[] } {
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
  const sent: Sent[] = [];
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
    swarmHealth: new Map(),
    isDroneHostileTo: () => false,
    playerMountAngles: playerAngles,
    droneMountAngles: droneAngles,
    missileSim: { live: function* () { /* none */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
    // What the encoder reads, read when the snapshot is sent.
    sendSnapshot: (_c: Client, snap: SnapshotMessage) => {
      sent.push({
        drones: (snap.drones ?? []).map((d) => ({ id: d.id, mountAngles: d.mountAngles?.slice() })),
        own: Object.values(snap.states)[0]?.mountAngles?.slice(),
      });
    },
  } as unknown as SnapshotBroadcasterDeps;
  return { b: new SnapshotBroadcaster(deps), sent };
}

describe('SnapshotBroadcaster — each ship carries its own turret angles', () => {
  it('two one-turret drones and a one-turret pilot keep their own angles on the wire', () => {
    const drones: Drone[] = [
      { id: 'd-left', kind: 1, entityId: 31, shipKind: 'fighter' },
      { id: 'd-right', kind: 1, entityId: 32, shipKind: 'robot-square' },
    ];
    const droneAngles = new Map([['d-left', new Float32Array([0.3])], ['d-right', new Float32Array([-0.2])]]);
    const playerAngles = new Map([[PID, new Float32Array([0.1])]]);
    const { b, sent } = setup(drones, droneAngles, playerAngles);
    b.interestScratch.set(SID, new Set([31, 32]));
    for (let i = 0; i < 6; i++) b.broadcast(false);

    expect(sent.length).toBeGreaterThan(0);
    const s = sent[sent.length - 1]!;
    const left = s.drones.find((d) => d.id === 31);
    const right = s.drones.find((d) => d.id === 32);
    expect(left?.mountAngles?.[0], 'the fighter drone\'s nose turret angle').toBeCloseTo(0.3, 4);
    expect(right?.mountAngles?.[0], 'the robot\'s nose turret angle').toBeCloseTo(-0.2, 4);
    expect(s.own?.[0], 'the pilot\'s own nose turret angle').toBeCloseTo(0.1, 4);
  });
});
