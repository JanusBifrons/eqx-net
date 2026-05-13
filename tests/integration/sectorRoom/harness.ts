/**
 * SectorRoom integration test harness (Phase A1) — **WIP, NOT YET
 * USABLE**.
 *
 * Status: 2026-05-13 attempt blocked at multiple layers; pivoted to
 * Phase A3 (Pixi renderer extraction) which catches the highest-value
 * bug class with much less friction. See `docs/LESSONS.md` Phase A1
 * entry for the full incident report.
 *
 * Blockers encountered (in order, each surfaced AFTER fixing the
 * previous):
 *  1. `@colyseus/tools@0.17.19` was installed as a transitive dep
 *     (left over from a previous `@colyseus/testing@0.17` install).
 *     `@colyseus/testing@0.16.3`'s index.ts imports tools, which
 *     imports `defineServer` from `@colyseus/core@0.17` — but we have
 *     0.16.24. Fixed by `pnpm add -D @colyseus/tools@^0.16.0` (now
 *     resolves to 0.16.20 alongside 0.17.19).
 *  2. `node:sqlite` import via Database.ts → PersistenceWorker.ts →
 *     SectorRoom. Vite's resolver mishandled the `node:` prefix and
 *     tried to load `sqlite` (no prefix). Worked around with a
 *     resolve.alias to `sqliteStub.ts`.
 *  3. `@colyseus/schema@3.x` legacy `experimentalDecorators` not
 *     applied by vitest's default esbuild transform. Fixed with
 *     `esbuild.tsconfigRaw` in vitest.config.
 *  4. tinypool serialization crash when vitest reports test results
 *     — Colyseus's Schema instances aren't structuredClone-able
 *     through the worker IPC. `TypeError: ERR_INVALID_ARG_TYPE` in
 *     `deserialize`. Tried both `forks` and `threads` pools; same
 *     failure mode either way. This is the load-bearing blocker.
 *
 * What DOES work as of this checkpoint:
 *  - The Server boots in vitest. Colyseus prints its banner.
 *  - The harness factory's setPersistence/setLimboStore/setPlayerShipStore
 *    seam pattern is correct (the in-memory stub plumbing works).
 *
 * What's left to figure out:
 *  - Either configure vitest pool to handle Schema serialization, OR
 *    run integration tests in a separate process (e.g. via a node
 *    script outside vitest) and have vitest just verify the artefact.
 *  - Alternative: write a manual SectorRoom test (no Colyseus server)
 *    that directly instantiates the room class and calls onCreate /
 *    onJoin / onLeave / update with mocked clients. Heavier mocking
 *    but no IPC serialization. The existing
 *    `src/server/transit/TransitOrchestrator.test.ts` is the gold
 *    standard for this style; scaling it up to room level is a few
 *    hundred lines of mock plumbing.
 *
 * The files in this directory (`harness.ts`, `lingering.test.ts`,
 * `sqliteStub.ts`) are kept in-tree as a starting point for the next
 * attempt. The vitest config has been reverted to its pre-Phase-A1
 * shape (these files are excluded from the test run) so the suite
 * stays green.
 *
 * Original aspiration (still valid for the next attempt):
 *
 * Spins up a REAL `SectorRoom` in-process via `@colyseus/testing`'s
 * `ColyseusTestServer`, with the persistence singletons stubbed to
 * in-memory implementations so tests don't touch SQLite. Physics
 * worker is real — the SAB lifecycle, swarm broadcast, and snapshot
 * loop all run as in production.
 *
 * This is the FIRST consumer of `@colyseus/testing@0.16.3` in the
 * repo. Every existing server-side test today uses a hand-rolled mock
 * (`TransitOrchestrator.test.ts` is the gold standard for that style),
 * which is great for orchestrator-shaped logic but cannot catch the
 * "server didn't broadcast it" / "client didn't route it" class of bug
 * that has bitten Phase 6b twice. This harness is the missing rung.
 *
 * **Port collision warning**: `@colyseus/testing`'s `boot(server)` calls
 * `gameServer.listen(2568)` with a hardcoded port. Vitest runs test
 * files in parallel by default, so two integration test files both
 * importing this harness would EADDRINUSE. The vitest config sets
 * `poolOptions.threads.singleThread` for the `tests/integration/`
 * glob so the integration suite runs serially. Do not lift this
 * restriction without first solving the port-randomisation problem.
 *
 * **Stubbed singletons**:
 *  - `setPersistence(NoOpSink)` — every enqueueCritical / enqueueVolatile
 *    is captured into an array (so tests can assert side effects) and
 *    discarded; no SQLite, no worker.
 *  - `setLimboStore(new LimboStore({}))` — in-memory, no shadow writes.
 *  - `setPlayerShipStore(new PlayerShipStore({ generateShipId, now }))`
 *    — deterministic UUIDs + fake clock so test assertions are stable.
 *
 * **Real moving parts** (not stubbed):
 *  - The SectorRoom itself + its physics worker (`bundleWorker`).
 *  - The Colyseus broadcast pipeline — schema diffs and snapshot
 *    messages flow over a real (in-process) WebSocket transport.
 *  - The Bus (eventemitter3) so SHIP_DESTROYED / SHIP_DESPAWNED chains
 *    fire naturally.
 *
 * Survey of the Phase 6b bug: had this harness existed, a single test
 * asserting "after a fresh-spawn-with-existing-linger, `state.ships`
 * has TWO entries (active + lingering) AND the snapshot includes both"
 * would have flagged every regression that took 4+ smoke-test cycles
 * to surface. The cost is ~1 s of harness boot per test file. Worth it.
 */
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ColyseusTestServer } from '@colyseus/testing';
import { createServer, type Server as HttpServer } from 'node:http';
import type { Room as ServerRoom } from 'colyseus';
import type { Room as ClientRoom } from 'colyseus.js';

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

/**
 * No-op persistence sink. Captures every op into an array so tests
 * can assert side effects (e.g. "abandoning a ship enqueued a
 * PLAYER_SHIP_DELETE"), but does no I/O.
 */
export class CaptureSink implements IPersistenceSink {
  public readonly ops: PersistOp[] = [];
  enqueueCritical(op: PersistOp): void {
    this.ops.push(op);
  }
  enqueueVolatile(op: PersistOp): void {
    this.ops.push(op);
  }
  enqueueCriticalAwaitable(op: PersistOp): Promise<{ rowId?: number }> {
    this.ops.push(op);
    return Promise.resolve({});
  }
  shutdown(_opts: { timeoutMs: number }): Promise<{ drained: number }> {
    return Promise.resolve({ drained: this.ops.length });
  }
  /** Clear captured ops between test cases. */
  reset(): void {
    this.ops.length = 0;
  }
}

export interface SectorTestHarness {
  /** The Colyseus TestServer wrapper exposing `.sdk.joinOrCreate` etc. */
  testServer: ColyseusTestServer;
  /** The room id created by `createRoom`. Use with `getServerRoom()`. */
  roomId: string;
  /** Captured persistence ops (assert side effects). */
  sink: CaptureSink;
  /** Direct access to the server-side room instance (typed). */
  getServerRoom(): ServerRoom<SectorState>;
  /** Connect a fake client to the room. */
  connectAs(playerId: string, joinOpts?: Record<string, unknown>): Promise<ClientRoom>;
  /** Disconnect a client (graceful leave). */
  disconnectClient(client: ClientRoom): Promise<void>;
  /** Wait for the next snapshot message on this client. Resolves with the parsed payload. */
  waitForSnapshot(client: ClientRoom, timeoutMs?: number): Promise<SnapshotMessage>;
  /** Block until N ms of wall-clock has elapsed (real timers — the physics
   *  worker uses setImmediate, not fake timers, so we can't bypass it). */
  advance(ms: number): Promise<void>;
  /** Tear down: clean up clients, dispose room, shut down test server,
   *  restore the persistence singletons. */
  cleanup(): Promise<void>;
}

const TEST_PORT_BASE = 2580;

/**
 * Boot a single SectorRoom for testing. Returns a harness with helpers.
 * The room is registered as `'test-sector'` with sectorKey=null
 * (engineering-room semantics — no roster persistence for that room,
 * but the harness still installs an in-memory PlayerShipStore so any
 * test that joins a galaxy-keyed room can verify roster mutations).
 *
 * For galaxy-flavoured tests, pass `opts.sectorKey: 'sol-prime'` (or
 * similar). The harness wires the room with that key.
 */
export async function bootSectorTestServer(opts: {
  sectorKey?: string;
  /** Drone count to seed at room start. Defaults to 0 for deterministic tests. */
  droneCount?: number;
  /** Test-mode flag forwarded to SectorRoom. Defaults to true. */
  testMode?: boolean;
} = {}): Promise<SectorTestHarness> {
  // --- Stub the persistence singletons BEFORE the room is created.
  //     SectorRoom's onCreate reads `getLimboStore()` + `getPlayerShipStore()`
  //     via module-level singletons; we inject in-memory replacements
  //     via the test seams.
  const sink = new CaptureSink();
  setPersistence(sink);
  setLimboStore(new LimboStore({}));
  setPlayerShipStore(new PlayerShipStore({
    // Deterministic id sequence — every test sees the same shipInstanceIds.
    generateShipId: ((): () => string => {
      let n = 0;
      return () => `test-ship-${++n}`;
    })(),
  }));

  // --- Construct a Colyseus Server with a real (in-process) WS transport.
  //     We use a unique port per harness boot to avoid EADDRINUSE if the
  //     vitest poolOptions are ever relaxed to allow parallel integration
  //     tests. Port is base + random offset; collision risk is negligible.
  const port = TEST_PORT_BASE + Math.floor(Math.random() * 1000);
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

  // --- Wrap the Server in the TestServer helper.
  const testServer = new ColyseusTestServer(gameServer);

  // --- Create one room up front so tests can connect to it by id.
  const serverRoom = await testServer.createRoom<SectorState>('test-sector', {});

  const connectedClients: ClientRoom[] = [];

  const harness: SectorTestHarness = {
    testServer,
    roomId: serverRoom.roomId,
    sink,
    getServerRoom(): ServerRoom<SectorState> {
      return testServer.getRoomById<SectorState>(serverRoom.roomId);
    },
    async connectAs(playerId, joinOpts = {}) {
      const client = await testServer.sdk.joinOrCreate('test-sector', {
        playerId,
        ...joinOpts,
      });
      connectedClients.push(client);
      return client;
    },
    async disconnectClient(client) {
      // `leave(true)` is a consent-leave; the server's onLeave receives
      // `consented=true` and runs the despawn (NOT linger) branch. For
      // testing the linger path use `leave(false)` semantics — but
      // colyseus.js's leave() doesn't expose that distinction in 0.16.
      // For our tests, the server's `shouldLinger` predicate is what
      // decides; we just call leave() and let the server route.
      await client.leave();
      const idx = connectedClients.indexOf(client);
      if (idx !== -1) connectedClients.splice(idx, 1);
    },
    async waitForSnapshot(client, timeoutMs = 1000) {
      return new Promise<SnapshotMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitForSnapshot timed out')), timeoutMs);
        const handler = (snap: SnapshotMessage): void => {
          clearTimeout(timer);
          // Detach by reassigning to an empty function — colyseus.js
          // onMessage doesn't return an off() seam at this version.
          (handler as { detached?: boolean }).detached = true;
          resolve(snap);
        };
        client.onMessage('snapshot', (snap: unknown) => {
          if ((handler as { detached?: boolean }).detached) return;
          handler(snap as SnapshotMessage);
        });
      });
    },
    async advance(ms) {
      // Physics worker uses setImmediate + performance.now() based
      // scheduling — fake timers don't reach into the worker thread,
      // so we sleep real wall-clock. 1ms of wall-clock ≈ 0-1 physics
      // ticks at 60Hz; budget tests accordingly.
      await new Promise((r) => setTimeout(r, ms));
    },
    async cleanup() {
      // Best-effort: leave any straggler clients, dispose the room, then
      // shutdown the test server (which closes the underlying gameServer
      // and HTTP transport).
      for (const c of [...connectedClients]) {
        try { await c.leave(); } catch { /* ignore */ }
      }
      connectedClients.length = 0;
      await testServer.cleanup();
      await testServer.shutdown();
      // Restore the singletons so a subsequent test file gets a fresh
      // PlayerShipStore / LimboStore / persistence rather than ours.
      setLimboStore(new LimboStore({}));
      setPlayerShipStore(new PlayerShipStore({}));
    },
  };

  return harness;
}
