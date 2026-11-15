/**
 * RTS fleet warp S4 — a parked hull's snapshot `warp` phase. A hull spooling
 * in a fleet warp shows the build-up (1) and a hull a fleet warp just handed
 * in shows the drop (3), through the SAME deps an active ship's phase uses
 * (`transitSpooling` / `warpArrived`, asked with the hull's shipInstanceId).
 * Before S4 the lingering loop hard-set 0, so no client could draw either.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

const PID = 'p0';
const HULL = 'hull-A';

function setup(spooling: Set<string>, arrived: Set<string>): { broadcaster: SnapshotBroadcaster; sent: SnapshotMessage[] } {
  const sent: SnapshotMessage[] = [];
  const pose = (x: number): ShipPhysicsState => ({ x, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });
  const active = { alive: true, isActive: true, shipInstanceId: 'inst-p0', playerId: PID, shield: 1, level: 1 } as unknown as ShipState;
  const parked = { alive: true, isActive: false, shipInstanceId: HULL, playerId: PID, shield: 1, level: 1 } as unknown as ShipState;
  const client = {
    sessionId: 's0',
    socket: { bufferedAmount: 0 },
    send: vi.fn((_t: string, snap: SnapshotMessage) => { sent.push(JSON.parse(JSON.stringify(snap)) as SnapshotMessage); }),
    leave: vi.fn(),
  };
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {},
    child: () => stubLogger,
  } as unknown as Logger;
  const deps: SnapshotBroadcasterDeps = {
    serverTick: () => 100,
    sabU32: new Uint32Array(1024),
    clients: [client] as unknown as ClientArray<Client>,
    sessionToPlayer: new Map([['s0', PID]]),
    playerToSlot: new Map([[PID, 0]]),
    getActiveShip: (pid: string) => (pid === PID ? active : undefined),
    shipPoseCache: new Map([[PID, pose(0)]]),
    lingeringSlots: new Map([[HULL, 5]]),
    lingeringPoseCache: new Map([[HULL, pose(100)]]),
    shipsMap: new Map<string, ShipState>([[PID, active], [HULL, parked]]) as unknown as MapSchema<ShipState>,
    liveProjectiles: new Map() as unknown as SnapshotBroadcasterDeps['liveProjectiles'],
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    swarmRegistry: { getByEntityId: () => null },
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* empty */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
    transitSpooling: (id) => spooling.has(id),
    warpArrived: (id) => arrived.has(id),
  };
  return { broadcaster: new SnapshotBroadcaster(deps), sent };
}

function firstSnap(b: SnapshotBroadcaster, sent: SnapshotMessage[]): SnapshotMessage {
  for (let i = 0; i < 300 && sent.length < 1; i++) b.broadcast(false);
  return sent[0]!;
}

describe('SnapshotBroadcaster — parked hull warp phase (RTS fleet warp S4)', () => {
  it('a hull spooling in a fleet warp carries warp 1', () => {
    const { broadcaster, sent } = setup(new Set([HULL]), new Set());
    expect(firstSnap(broadcaster, sent).states[HULL]!.warp).toBe(1);
  });

  it('a hull just handed in by a fleet warp carries warp 3', () => {
    const { broadcaster, sent } = setup(new Set(), new Set([HULL]));
    expect(firstSnap(broadcaster, sent).states[HULL]!.warp).toBe(3);
  });

  it('spooling wins over arrived; an idle hull carries no warp field', () => {
    const both = setup(new Set([HULL]), new Set([HULL]));
    expect(firstSnap(both.broadcaster, both.sent).states[HULL]!.warp).toBe(1);
    const idle = setup(new Set(), new Set());
    expect(firstSnap(idle.broadcaster, idle.sent).states[HULL]!.warp).toBeUndefined();
  });

  it('the pilot of a fleet member (keyed by playerId nowhere) shows the build-up via its shipInstanceId', () => {
    const { broadcaster, sent } = setup(new Set(['inst-p0']), new Set());
    const snap = firstSnap(broadcaster, sent);
    expect(snap.states['inst-p0']!.warp).toBe(1);
    expect(snap.states[HULL]!.warp).toBeUndefined();
  });
});
