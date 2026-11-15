/**
 * Take 12 film review: AI pilots boost often, yet on film their ships showed
 * only a faint speed-guessed exhaust, never the blue boost flame a pilot's
 * ship gets. A pilot's boost rides `boostingIds`; an AI ship had nothing on
 * the wire, so the client guessed from speed. Now an in-interest AI ship
 * holding the boost key carries `drones[].boost` (#16: the client draws the
 * boost from the snapshot alone, the real key, not a guess).
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

function setup(drones: Drone[], boosting: Set<string>): {
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
    isDroneBoosting: (id: string) => boosting.has(id),
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

describe('SnapshotBroadcaster — an AI ship holding boost carries drones[].boost', () => {
  it('a boosting in-interest AI ship reports boost; a quiet one sends nothing; it clears when let go', () => {
    const drones: Drone[] = [
      { id: 'ai-boost', kind: 1, entityId: 31, shipKind: 'fighter' },
      { id: 'ai-cruise', kind: 1, entityId: 32, shipKind: 'fighter' },
    ];
    const boosting = new Set(['ai-boost']);
    const { b, snaps } = setup(drones, boosting);
    b.interestScratch.set(SID, new Set([31, 32]));

    const first = nextSnap(b, snaps).drones ?? [];
    const booster = first.find((d) => d.id === 31);
    expect(booster, 'the boosting AI ship rides the slice').toBeDefined();
    expect(booster!.boost).toBe(true);
    expect(first.some((d) => d.id === 32), 'an AI ship with nothing to report sends nothing').toBe(false);

    // It lets go of the boost key: the next snapshot omits it (absent = not boosting).
    boosting.clear();
    const second = nextSnap(b, snaps);
    expect((second.drones ?? []).some((d) => d.boost === true)).toBe(false);
  });
});
