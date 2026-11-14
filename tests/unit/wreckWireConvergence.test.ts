/**
 * Sub-capital break-up slice 3 — the client's wreck set converges from
 * welcome ∪ snapshots (#16), even when it misses snapshots.
 *
 * The real `SnapshotBroadcaster` (server) feeds the real `WreckGeometryStore`
 * (client), optionally through the real `SnapshotCoalescer`:
 *   - a forced miss (every snapshot dropped while adds AND removes happen,
 *     until their windows have passed) is repaired by the rolling resync;
 *   - a coalescer that drops two snapshots in three loses nothing;
 *   - applying the same snapshot twice changes nothing (idempotent).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from '../../src/server/rooms/SnapshotBroadcaster.js';
import { WRECK_DELTA_WINDOW, WRECK_RESYNC_CHUNK, WRECK_RESYNC_EVERY } from '../../src/server/rooms/WreckWireDeltas.js';
import { WreckGeometryStore } from '../../src/client/net/wreckGeometryStore.js';
import { SnapshotCoalescer } from '../../src/client/net/SnapshotCoalescer.js';
import { FRACTURE_ALGO_VERSION } from '../../src/core/destruction/fractureHull.js';
import type { ShipPhysicsState } from '../../src/core/physics/World.js';
import type { ShipState } from '../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage, WreckDescriptor } from '../../src/shared-types/messages.js';

const PID = 'pilot-a';
const SID = `s-${PID}`;

function wreck(id: number, seed = 1000 + id): WreckDescriptor {
  return {
    wreckId: id, parentKind: 'battleship', seed, killX: 10, killY: -20,
    killBlowDamage: 0.3, recentDamageRate: 0.8, snapChance: 0.1, algoVersion: FRACTURE_ALGO_VERSION,
  };
}

class ServerWrecks {
  readonly list: WreckDescriptor[] = [];
  version = 0;
  add(d: WreckDescriptor): void { this.list.push(d); this.version++; }
  remove(id: number): void {
    const i = this.list.findIndex((d) => d.wreckId === id);
    if (i >= 0) { this.list.splice(i, 1); this.version++; }
  }
}

function broadcaster(w: ServerWrecks, onSnap: (s: SnapshotMessage) => void): SnapshotBroadcaster {
  const ship = {
    alive: true, isActive: true, shipInstanceId: `inst-${PID}`, playerId: PID, kind: 'fighter',
    level: 1, mounts: [], warp: 0, poseEpoch: 0, shield: 1,
  } as unknown as ShipState;
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as unknown as Logger;
  return new SnapshotBroadcaster({
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
    swarmRegistry: { getByEntityId: () => null },
    swarmHealth: new Map(),
    isDroneHostileTo: () => false,
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* none */ } },
    logger: log,
    serverLogEvent: () => {},
    getWrecks: () => w.list,
    wrecksVersion: () => w.version,
    // The wire is a structured copy: the broadcaster reuses its arrays (#14).
    sendSnapshot: (_c: Client, snap: SnapshotMessage) => onSnap(JSON.parse(JSON.stringify(snap)) as SnapshotMessage),
  } as unknown as SnapshotBroadcasterDeps);
}

function sameSet(store: WreckGeometryStore, w: ServerWrecks): boolean {
  if (store.descriptors.size !== w.list.length) return false;
  for (const d of w.list) if (store.descriptors.get(d.wreckId)?.seed !== d.seed) return false;
  return true;
}

describe('wreck wire — the client converges from welcome ∪ snapshots', () => {
  it('the rolling resync repairs a forced miss of adds AND removes', () => {
    const w = new ServerWrecks();
    for (let id = 1; id <= 20; id++) w.add(wreck(id));
    const store = new WreckGeometryStore();
    store.apply(w.list); // the welcome's full set
    let deliver = false;
    const b = broadcaster(w, (s) => { if (deliver) store.applySnapshot(s); });

    // Forced miss: churn while every snapshot is lost, until the windows pass.
    for (let id = 21; id <= 25; id++) w.add(wreck(id));
    w.remove(2); w.remove(7); w.remove(13);
    for (let c = 0; c < WRECK_DELTA_WINDOW * 3; c++) b.broadcast(false);
    expect(sameSet(store, w)).toBe(false);

    // Snapshots flow again: only the resync can repair it.
    deliver = true;
    const cycles = Math.ceil(w.list.length / WRECK_RESYNC_CHUNK) + 2;
    let at = -1;
    for (let c = 0; c < WRECK_RESYNC_EVERY * cycles; c++) {
      b.broadcast(false);
      if (at < 0 && sameSet(store, w)) at = c;
    }
    expect(sameSet(store, w), 'the client set matches the server set').toBe(true);
    // eslint-disable-next-line no-console -- the convergence time the PR cites
    console.log(`resync converged after ${(at / 60).toFixed(1)} s (${w.list.length} live wrecks)`);
  });

  it('a coalescer dropping two snapshots in three loses no add or remove', () => {
    const w = new ServerWrecks();
    for (let id = 1; id <= 10; id++) w.add(wreck(id));
    const store = new WreckGeometryStore();
    store.apply(w.list);
    const co = new SnapshotCoalescer(true);
    let n = 0;
    const b = broadcaster(w, (s) => {
      co.enqueue(s);
      if (++n % 3 === 0) co.drain((x) => store.applySnapshot(x));
    });
    let next = 11;
    for (let c = 0; c < 600; c++) {
      if (c % 7 === 0) w.add(wreck(next++));
      if (c % 11 === 0 && w.list.length > 4) w.remove(w.list[1]!.wreckId);
      b.broadcast(false);
      // Within a window of the last change the deltas alone must have done it.
    }
    for (let c = 0; c < WRECK_DELTA_WINDOW; c++) b.broadcast(false);
    co.drain((x) => store.applySnapshot(x));
    expect(sameSet(store, w)).toBe(true);
  });

  it('applying the same snapshot twice changes nothing', () => {
    const store = new WreckGeometryStore();
    const snap = {
      serverTick: 1, states: {},
      wreckAdds: [wreck(1), wreck(2)], wreckRemoves: [3],
      wreckSync: { lo: 1, hi: 5, d: [wreck(1), wreck(2)] },
    } as unknown as SnapshotMessage;
    store.applySnapshot(snap);
    const first = [...store.descriptors.keys()];
    store.applySnapshot(snap);
    expect([...store.descriptors.keys()]).toEqual(first);
    expect(first.sort()).toEqual([1, 2]);
  });

  it('a malformed descriptor is dropped, never applied', () => {
    const store = new WreckGeometryStore();
    store.applySnapshot({
      serverTick: 1, states: {},
      wreckAdds: [{ wreckId: 'x', parentKind: 'battleship' }, wreck(4)],
      wreckRemoves: ['bad'],
    } as unknown as SnapshotMessage);
    expect([...store.descriptors.keys()]).toEqual([4]);
    expect(store.rejected).toBe(2);
  });
});
