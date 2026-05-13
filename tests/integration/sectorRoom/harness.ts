/**
 * SectorRoom integration test harness (Phase A1, simplified after the
 * 2026-05-13 @colyseus/testing blocker — see docs/LESSONS.md).
 *
 * Strategy: bypass `@colyseus/testing` entirely. The previous attempt
 * to use its `boot()` + `ColyseusTestServer` wrapper crashed in
 * vitest's tinypool IPC layer because Colyseus's Schema instances
 * aren't structuredClone-able through worker-process boundaries.
 * Instead, we drive the production stack directly:
 *
 *  - `new Server({ transport: new WebSocketTransport(...) })` —
 *    same as production `src/server/index.ts`.
 *  - `gameServer.define('test-sector', SectorRoom, opts)`.
 *  - `gameServer.listen(randomPort)` — listen on a per-harness port.
 *  - Client side: `new Client('ws://localhost:port')` from
 *    `colyseus.js`. `joinOrCreate` connects to the room as a real
 *    client.
 *
 * Why this works where `boot()` didn't: nothing crosses vitest's
 * tinypool IPC boundary. Server + client both live in the same
 * Node process as the test. The only serialization is Colyseus's
 * own WebSocket protocol, which IS structuredClone-friendly.
 *
 * Stubbed singletons (in-memory, no I/O):
 *  - `setPersistence(CaptureSink)` — every enqueueCritical/Volatile
 *    is captured into an array (assertable as a side effect) and
 *    discarded; no SQLite, no DB worker.
 *  - `setLimboStore(new LimboStore({}))` — in-memory, no shadow.
 *  - `setPlayerShipStore(new PlayerShipStore({ generateShipId }))`
 *    — deterministic ids for stable test assertions.
 *
 * Real moving parts (not stubbed):
 *  - The SectorRoom itself + its physics worker (`bundleWorker`).
 *  - The Colyseus broadcast pipeline — schema diffs and snapshot
 *    messages flow over a real (localhost) WebSocket transport.
 *  - The Bus (eventemitter3) so SHIP_DESTROYED chains fire.
 *
 * Port collision: each harness instance picks a random port in a
 * 2580–3580 range. Risk of EADDRINUSE between parallel test files
 * is statistically tiny (<1% for 2 files); vitest config still pins
 * integration tests to `singleThread` for safety.
 */
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, type Room as ClientRoom } from 'colyseus.js';
import { createServer, type Server as HttpServer } from 'node:http';
import type { Room as ServerRoom } from 'colyseus';
import { createServerEventsApi, type ServerEventsApi } from './serverEvents.js';

import { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import {
  setPersistence,
  setLimboStore,
  setPlayerShipStore,
} from '../../../src/server/db/PersistenceWorker.js';
import { LimboStore } from '../../../src/server/limbo/LimboStore.js';
import { PlayerShipStore } from '../../../src/server/playerShips/PlayerShipStore.js';
import type {
  IPersistenceSink,
  PersistOp,
} from '../../../src/core/contracts/IPersistenceSink.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

/** No-op persistence sink. Captures every op into an array. */
export class CaptureSink implements IPersistenceSink {
  public readonly ops: PersistOp[] = [];
  enqueueCritical(op: PersistOp): void { this.ops.push(op); }
  enqueueVolatile(op: PersistOp): void { this.ops.push(op); }
  enqueueCriticalAwaitable(op: PersistOp): Promise<{ rowId?: number }> {
    this.ops.push(op);
    return Promise.resolve({});
  }
  shutdown(_opts: { timeoutMs: number }): Promise<{ drained: number }> {
    return Promise.resolve({ drained: this.ops.length });
  }
  reset(): void { this.ops.length = 0; }
}

export interface SectorTestHarness {
  /** The localhost port the test server is listening on. */
  port: number;
  /** Colyseus Client wired to `ws://localhost:port`. Use this to
   *  `joinOrCreate` rooms; one client per simulated player. */
  client: Client;
  /** Captured persistence ops. */
  sink: CaptureSink;
  /** Direct access to the SectorRoom instance on the server side.
   *  Returns the first defined room after a client has joined. */
  getServerRoom(): ServerRoom<SectorState> | null;
  /** Connect a fresh client connection as a named player. */
  connectAs(playerId: string, joinOpts?: Record<string, unknown>): Promise<ClientRoom<SectorState>>;
  /** Send a `leave()` from the client side. */
  disconnectClient(room: ClientRoom<SectorState>): Promise<void>;
  /** Wait for the next snapshot. Note: snapshot broadcasts are suppressed
   *  while the sector is idle (no motion / projectiles). Use {@link sendThrust}
   *  before this call to wake the broadcast loop. */
  waitForSnapshot(room: ClientRoom<SectorState>, timeoutMs?: number): Promise<SnapshotMessage>;
  /** Send a thrust input to unidle the sector and trigger snapshot broadcasts.
   *  Production sectors are "idle from birth" with a stationary spawned ship —
   *  `noteSectorEvent` fires only when shipPoseCache shows motion, which only
   *  happens after the physics worker applies an INPUT impulse. */
  sendThrust(room: ClientRoom<SectorState>): void;
  /** Sleep real wall-clock (physics worker uses setImmediate scheduling
   *  in the worker thread; fake timers wouldn't reach it). PREFER
   *  `events.waitFor(...)` over blind `advance(N)` when waiting for a
   *  specific server-side event — it's faster (polls at 25 ms vs the
   *  blind 100+ ms sleep) and self-documents what the test is waiting
   *  on. */
  advance(ms: number): Promise<void>;
  /** Server-events assertion API. Reads from `ServerEventLog`'s
   *  module-level ring buffer; the buffer is auto-cleared on harness
   *  boot so each test starts with a clean slate. */
  events: ServerEventsApi;
  /** Tear down: clients, server, restore singletons. */
  cleanup(): Promise<void>;
}

function pickRandomPort(): number {
  // 2580–3580. Server listens on the same port as production (2567)
  // is left untouched by tests.
  return 2580 + Math.floor(Math.random() * 1000);
}

export async function bootSectorTestServer(opts: {
  sectorKey?: string;
  droneCount?: number;
  testMode?: boolean;
} = {}): Promise<SectorTestHarness> {
  // 1. Stub the persistence singletons FIRST. SectorRoom.onCreate
  //    reads these via module-level singletons, so the injection has
  //    to land before the room is constructed.
  const sink = new CaptureSink();
  setPersistence(sink);
  setLimboStore(new LimboStore({}));
  setPlayerShipStore(new PlayerShipStore({
    generateShipId: ((): () => string => {
      let n = 0;
      return () => `test-ship-${++n}`;
    })(),
  }));

  // 2026-05-13 — clear the ServerEventLog ring buffer so each test
  // starts with no leaked events from the prior run. The buffer is
  // module-level and we run integration tests with pool: threads +
  // singleThread + isolate:false, so the module state persists
  // across tests in the same file. Without this, `events.count(...)`
  // could see counts from earlier tests and break assertions.
  const events = createServerEventsApi();
  events.clear();

  // 2. Construct a Colyseus Server + transport + listen on a random
  //    port. This is the exact production wiring; no test wrapper.
  const port = pickRandomPort();
  const httpServer: HttpServer = createServer();
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });
  gameServer.define('test-sector', SectorRoom, {
    sectorKey: opts.sectorKey,
    droneCount: opts.droneCount ?? 0,
    testMode: opts.testMode ?? true,
  });
  await gameServer.listen(port);

  // 3. Construct a colyseus.js Client pointed at our localhost
  //    server. Same client the production browser code uses.
  const client = new Client(`ws://localhost:${port}`);

  const connectedRooms: ClientRoom<SectorState>[] = [];
  let firstServerRoomCache: ServerRoom<SectorState> | null = null;
  let firstRoomId: string | null = null;

  const harness: SectorTestHarness = {
    port,
    client,
    sink,
    getServerRoom() {
      if (firstServerRoomCache) return firstServerRoomCache;
      // We need a synchronous lookup. matchMaker.query is async and
      // returns RoomCache metadata; matchMaker.getLocalRoomById gives
      // the actual Room instance. We stash a roomId on first join via
      // the harness's connectAs (see below) so this lookup is O(1).
      if (!firstRoomId) return null;
      firstServerRoomCache = matchMaker.getLocalRoomById(firstRoomId) as unknown as ServerRoom<SectorState>;
      return firstServerRoomCache;
    },
    async connectAs(playerId, joinOpts = {}) {
      const room = await client.joinOrCreate<SectorState>('test-sector', {
        playerId,
        ...joinOpts,
      });
      connectedRooms.push(room);
      // Cache the room id from the first successful join so the
      // sync `getServerRoom()` lookup can resolve to the server-side
      // Room instance without an async matchMaker.query.
      if (!firstRoomId) firstRoomId = room.roomId;
      return room;
    },
    async disconnectClient(room) {
      try { await room.leave(); } catch { /* ignore */ }
      const idx = connectedRooms.indexOf(room);
      if (idx !== -1) connectedRooms.splice(idx, 1);
    },
    async waitForSnapshot(room, timeoutMs = 1000) {
      return new Promise<SnapshotMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitForSnapshot timed out')), timeoutMs);
        room.onMessage('snapshot', (snap: unknown) => {
          clearTimeout(timer);
          resolve(snap as SnapshotMessage);
        });
      });
    },
    sendThrust(room) {
      // tick:0 is well below any temporal-plausibility gate (which only
      // applies to fire claims, not inputs) so the worker will apply the
      // impulse on its next tick regardless of clock skew.
      room.send('input', {
        type: 'input',
        tick: 0,
        thrust: true,
        turnLeft: false,
        turnRight: false,
      });
    },
    async advance(ms) {
      await new Promise((r) => setTimeout(r, ms));
    },
    events,
    async cleanup() {
      for (const r of [...connectedRooms]) {
        try { await r.leave(); } catch { /* ignore */ }
      }
      connectedRooms.length = 0;
      try { await gameServer.gracefullyShutdown(false); } catch { /* ignore */ }
      try { httpServer.close(); } catch { /* ignore */ }
      // Reset the singletons.
      setLimboStore(new LimboStore({}));
      setPlayerShipStore(new PlayerShipStore({}));
    },
  };

  return harness;
}
