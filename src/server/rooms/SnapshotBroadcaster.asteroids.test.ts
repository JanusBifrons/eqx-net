/**
 * WS-4 Phase 6 (R2.23 enabler) — the slim `asteroids[]` snapshot slice
 * (failing-first, Invariant #13). The bug-class this locks: a MINED asteroid's
 * finite resource pool must reach the client so the inspector (WS-9) can show
 * remaining ore — but an UNTOUCHED rock must add ZERO bytes (the emit-when-
 * changed wire discipline that keeps quiet sectors free).
 *
 * Lives at the broadcaster level because that's where the emit GATE lives
 * (`resources < resourcesMax` ⇒ emit; full ⇒ omit) — the load-bearing decision.
 * Mirrors the proven `drones[].hp` emit pattern. Red before Phase 6: there is
 * no `asteroids` field on the snapshot at all.
 *
 * Harness mirrors SnapshotBroadcaster.routing.test.ts (a fake colyseus client
 * whose `send` captures the emitted snap), plus an injected interest set + a
 * `getByEntityId` stub returning asteroid records.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import {
  SnapshotBroadcaster,
  type SnapshotBroadcasterDeps,
  type SwarmDroneRec,
} from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

interface FakeClient {
  sessionId: string;
  socket?: { bufferedAmount?: number };
  send: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
}

function makeFakeClient(sessionId: string): FakeClient {
  return { sessionId, socket: { bufferedAmount: 0 }, send: vi.fn(), leave: vi.fn() };
}

/** One-recipient harness with an injectable asteroid registry. */
function makeDeps(asteroids: Map<number, SwarmDroneRec>): {
  deps: SnapshotBroadcasterDeps;
  client: FakeClient;
} {
  const sabU32 = new Uint32Array(1024);
  const playerToSlot = new Map<string, number>([['p0', 0]]);
  const sessionToPlayer = new Map<string, string>([['s0', 'p0']]);
  const shipPoseCache = new Map<string, ShipPhysicsState>([
    ['p0', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }],
  ]);
  const ships = new Map<string, ShipState>([
    ['p0', { alive: true, isActive: true, shipInstanceId: 'inst-p0', playerId: 'p0' } as unknown as ShipState],
  ]);
  const client = makeFakeClient('s0');
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {}, child: () => stubLogger,
  } as unknown as Logger;

  const deps: SnapshotBroadcasterDeps = {
    serverTick: () => 100,
    sabU32,
    clients: [client] as unknown as ClientArray<Client>,
    sessionToPlayer,
    playerToSlot,
    getActiveShip: (pid: string) => ships.get(pid),
    shipPoseCache,
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    shipsMap: ships as unknown as MapSchema<ShipState>,
    wreckPoseCache: new Map(),
    liveProjectiles: new Map() as unknown as SnapshotBroadcasterDeps['liveProjectiles'],
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    swarmRegistry: { getByEntityId: (eid: number) => asteroids.get(eid) ?? null },
    swarmHealth: new Map(),
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* none */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
  };
  return { deps, client };
}

/** Drive enough broadcasts that the recipient passes the 20 Hz phase gate. */
function lastSnap(client: FakeClient): SnapshotMessage | undefined {
  const calls = client.send.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.[0] === 'snapshot') return calls[i]?.[1] as SnapshotMessage;
  }
  return undefined;
}

describe('SnapshotBroadcaster — asteroids[] slice (WS-4 Phase 6 / R2.23)', () => {
  it('emits a MINED asteroid (resources < max) and OMITS a full one', () => {
    const asteroids = new Map<number, SwarmDroneRec>([
      [10, { id: 'a10', kind: 0, resources: 50, resourcesMax: 100 }], // mined → emit
      [11, { id: 'a11', kind: 0, resources: 100, resourcesMax: 100 }], // full → omit
    ]);
    const { deps, client } = makeDeps(asteroids);
    const broadcaster = new SnapshotBroadcaster(deps);
    // Both rocks are in the recipient's interest window.
    broadcaster.interestScratch.set('s0', new Set([10, 11]));

    for (let i = 0; i < 60; i++) broadcaster.broadcast(false);

    const snap = lastSnap(client);
    expect(snap, 'a snapshot was sent').toBeDefined();
    expect(snap!.asteroids, 'mined asteroid produced a slice').toBeDefined();
    expect(snap!.asteroids!.length).toBe(1);
    const entry = snap!.asteroids![0]!;
    expect(entry.id).toBe(10);
    expect(entry.resources).toBe(50);
    expect(entry.resourcesMax).toBe(100);
    // The full rock (id 11) must NOT appear — zero bytes for untouched ore.
    expect(snap!.asteroids!.some((a) => a.id === 11)).toBe(false);
  });

  it('omits the slice entirely when no in-interest asteroid is mined (zero bytes)', () => {
    const asteroids = new Map<number, SwarmDroneRec>([
      [12, { id: 'a12', kind: 0, resources: 100, resourcesMax: 100 }], // full
      [13, { id: 'a13', kind: 0 }], // never mined (no resources fields)
    ]);
    const { deps, client } = makeDeps(asteroids);
    const broadcaster = new SnapshotBroadcaster(deps);
    broadcaster.interestScratch.set('s0', new Set([12, 13]));

    for (let i = 0; i < 60; i++) broadcaster.broadcast(false);

    const snap = lastSnap(client);
    expect(snap).toBeDefined();
    // notepack drops `undefined`, so an absent slice is genuinely zero bytes.
    expect(snap!.asteroids).toBeUndefined();
  });
});
