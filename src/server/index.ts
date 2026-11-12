import 'dotenv/config';
import { PERF_SCENES } from '../shared-types/perf/perfScenes.js';
import { scenePerfViews, recordClientReading, clientPerfReadings } from './rooms/scene/scenePerfRegistry.js';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import path from 'node:path';
import { createServer } from 'node:http';
import { pino } from 'pino';
import { SectorRoom } from './rooms/SectorRoom.js';
import { galaxySectorsToBoot } from './rooms/galaxyBoot.js';
import { GATE_TEST_PREBUILT, SCENARIO, STRUCTURE_SCENARIO_PREBUILT } from './rooms/scenarioLayouts.js';
import { SHOWCASE_ROOMS } from './rooms/showcaseRooms.js';
import { getRecentEvents, getRecentEventsByTag, clearEvents } from './debug/ServerEventLog.js';
import { installGcMonitor } from './debug/GcMonitor.js';
import { authRouter } from './routes/authRouter.js';
import { diagRouter, devStatsHandler, devLimboHandler, devPlayerShipsHandler, devPlayerShipsAbandonHandler, devResetSectorHandler, devResetRosterHandler, devWebrtcCountersHandler } from './routes/diagRouter.js';
import { galaxyRouter } from './routes/galaxyRouter.js';
import { economyRouter, setEconomyRouteProvider } from './routes/economyRouter.js';
import { EconomyStore, hydrateEconomyStore } from './economy/EconomyStore.js';
import { TradeDirector } from './economy/TradeDirector.js';
import { getTradeSink, setTradeSink } from './economy/tradeSink.js';
import { pushNotifier } from './push/PushNotifier.js';
import { pushRouter } from './routes/pushRouter.js';
import { devAuditHandler } from './audit/auditRoute.js';
import { flushAudit } from './audit/GameplayAuditLog.js';
import {
  initWorker,
  persistence,
  initPlayerShipStore,
  initHoldStore,
  initAccountPlayerRegistry,
  getPersistenceHealth,
  getPersistence,
  getHoldStore,
  getPlayerShipStore,
  getWallet,
  initWallet,
  initLabBoard,
  migrateLegacyHoldCredits,
} from './db/PersistenceWorker.js';
import { getUser } from './auth/AuthService.js';
import { GALAXY_SECTORS, getSector } from '../core/galaxy/galaxy.js';
import { ConvoyDirector, isConvoysDisabled } from './economy/ConvoyDirector.js';
import { isNpcBasesDisabled } from './bases/NpcBaseSubsystem.js';
import { resolveSectorConfig } from './galaxy/GalaxyRegistry.js';
import { LivingWorldDirector, LIVING_WORLD_BOT_COUNT, isLivingWorldDisabled, resolveBotSpoolMs, resolveBotHopMs, type LivingWorldOptions } from './livingworld/LivingWorldDirector.js';
import { setIncomingPlayerSink } from './livingworld/incomingPlayerSink.js';
import { setGalaxyStatsProvider } from './livingworld/galaxyStatsProvider.js';
import { ROBOT_DIRECTOR_OPTIONS, ROBOT_BOT_COUNT, isRobotsDisabled } from './livingworld/robotDirector.js';
import { RobotTerritory } from './livingworld/RobotTerritory.js';
import { EliteDirector } from './livingworld/EliteDirector.js';
import { FlagshipDirector, type FlagshipStatePayload } from './livingworld/FlagshipDirector.js';
import { EventDirector } from './livingworld/EventDirector.js';
import { sumCounts } from './livingworld/countMaps.js';
import { setContractsProvider } from './livingworld/contractsProvider.js';
import { BountyBoard, setBountyBoard } from './economy/BountyBoard.js';
import { WORLD_EVENT_KINDS, type WorldEventKind } from '../shared-types/worldEvents.js';
import { DirectorPersistence, type DirectorStatePayload } from './livingworld/DirectorPersistence.js';
import { db } from './db/Database.js';
import { resolveCorsPolicy, corsMiddleware, securityHeadersMiddleware } from './net/httpCors.js';
import { shouldRegisterTestRooms } from './rooms/testRoomGating.js';
import { installProcessGuards } from './orchestration/processGuards.js';
import { getTeleportBroker } from './teleport/TeleportBroker.js';
/** v4 T1 — the owner the teleport-test room's base belongs to (the E2E joins
 *  as this id). Kept in sync with tests/e2e/teleporter.spec.ts. */
const TELEPORT_TEST_OWNER = 'face0000-0000-4000-8000-000000000002';

const logger = pino({
  name: 'server',
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

const PORT = Number(process.env['PORT'] ?? 2567);
// Default 500; bump via `EQX_DEV_EVENTS_MAX` to match the ring's actual size
// when ServerEventLog is configured larger (e.g. diagnostic captures).
const MAX_DEV_EVENTS = Number(process.env['EQX_DEV_EVENTS_MAX'] ?? 500);

const app = express();

// CORS policy + baseline security headers (plan squishy-canyon, S1 + S7).
// `ALLOWED_ORIGINS` (comma-separated) is the explicit allowlist; non-production
// reflects any origin (dev/LAN/netgate ergonomics); production is closed by
// default. See src/server/net/httpCors.ts + docs/architecture/security.md.
const corsPolicy = resolveCorsPolicy();
app.use(securityHeadersMiddleware());
app.use(corsMiddleware(corsPolicy));

app.options('*', (_req, res) => { res.sendStatus(204); });

// `/diag/capture` carries the full client log ring — up to 30000 entries
// when `?diag=1` (ClientLogger `DIAG_MAX_ENTRIES`) + the server-events
// bundle — which exceeds the 2 MB global cap. Parse THIS dev-only route
// with a much larger limit, registered BEFORE the global parser so it
// consumes the body first; the global `express.json()` then no-ops
// (`req._body` is already set), so `/auth` and every other route keep
// the safe 2 MB limit. Matches the route's own `MAX_BYTES` ceiling.
app.use('/diag/capture', express.json({ limit: '64mb' }));
// 2 MB body limit for all other routes. Default Express limit is 100 KB,
// which 413's any non-trivial diagnostic capture (a 500-entry log +
// server events is ~150 KB+).
app.use(express.json({ limit: '2mb' }));
app.use('/auth', authRouter);
// Phase 8 — public route exposing the galaxy graph for the landing screen
// and the in-game galaxy-map overlay.
app.use('/galaxy', galaxyRouter);
app.use('/trade', economyRouter);
// Web Push (PWA notifications): VAPID public key + subscribe/unsubscribe.
app.use('/push', pushRouter);

/**
 * Server health probe. The client polls this to gate the pre-game UI
 * (landing screen "Join the fight" button + banner) and to render the
 * hype-number above the CTA. Returns 200 with `{ status, ready, tick,
 * playersOnline }` whenever the HTTP layer is up — `ready` is `true`
 * only after `main()` has finished hydrating Limbo, the roster, and the
 * eager galaxy rooms. Until then the client knows the process is alive
 * but joining would likely fail, so the join button stays disabled with
 * a "warming up" banner instead of an error.
 *
 * Keep this endpoint cheap: no DB queries, no schema instances. It's
 * the highest-frequency endpoint in the app and runs on the main
 * event loop.
 */
let serverReady = false;
/** Process-global Living World population brain. Constructed in `main()`
 *  after the eager galaxy rooms exist; stopped on shutdown. */
let livingWorldDirector: LivingWorldDirector | null = null;
/** Living World P1b — the robot-side director (null when disarmed). */
let robotDirector: LivingWorldDirector | null = null;
/** Living World P3 — robot territory + nexus (null when robots are disarmed). */
let robotTerritory: RobotTerritory | null = null;
/** Living World P4a — named elites (null when the Living World is disabled). */
let eliteDirector: EliteDirector | null = null;
let flagshipDirector: FlagshipDirector | null = null;
/** Living World P4b — world events (null when the Living World is disabled). */
let eventDirector: EventDirector | null = null;
const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();
/** Living World P2 — the economy (null until boot finishes). */
let economyStore: EconomyStore | null = null;
let tradeDirector: TradeDirector | null = null;
let convoyDirector: ConvoyDirector | null = null;
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    ready: serverReady,
    tick: Date.now(),
    playersOnline: fakePlayerCount(),
    // R4 — persistence observability: hydrate failures + live worker-sink
    // queue depth / critical-lane failures / lost-lane flag. Cheap integer reads.
    persistence: getPersistenceHealth(),
  });
});

/**
 * Deterministic-per-minute "X players fighting" hype number. Returns
 * 600–900, the same value across all clients hitting the server in the
 * same minute, rotating once per minute. Pre-moved-server: lived in
 * `MetaLandingScreen.tsx` and ran on the client's clock — moved here so
 * (a) every concurrent visitor sees the same number, (b) when we swap
 * this for a real `matchMaker`-summed count later the client doesn't
 * change. */
function fakePlayerCount(now: number = Date.now()): number {
  const minute = Math.floor(now / 60_000);
  let h = (minute * 2654435761) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return 600 + (h % 300);
}

// Dev-only endpoints for E2E test inspection and debugging.
if (process.env['NODE_ENV'] !== 'production') {
  app.post('/test/burn', (_req, res) => {
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) { /* intentional busy-wait */ }
    res.json({ ok: true });
  });

  // T2 — convoys in flight (phase, hauler pose, target).
  // GET /dev/perf — perf-scene rooms: scene status, server tick cost, counts.
  app.get('/dev/perf', (_req, res) => {
    res.json({ rooms: scenePerfViews() });
  });

  // Perf lab: a device posts its reading when a scene ends; GET lists them.
  app.post('/dev/perf/client', (req, res) => {
    const file = recordClientReading({ ...(req.body as object), receivedAt: new Date().toISOString(), rooms: scenePerfViews() });
    res.json({ ok: true, saved: file !== null });
  });
  app.get('/dev/perf/client', (_req, res) => {
    res.json({ readings: clientPerfReadings() });
  });

  app.get('/dev/convoys', (_req, res) => {
    res.json({ convoys: convoyDirector?.debugView() ?? [] });
  });

  // GET /dev/events?limit=N — recent server events (snapshots, joins, leaves).
  app.get('/dev/events', (req, res) => {
    const limit = Math.min(Number(req.query['limit'] ?? 200), MAX_DEV_EVENTS);
    // ?tag= returns the newest matching entries from the whole ring.
    const tag = typeof req.query['tag'] === 'string' ? req.query['tag'] : undefined;
    res.json({ events: tag ? getRecentEventsByTag(tag, limit) : getRecentEvents(limit) });
  });

  // POST /dev/events/clear — reset the ring buffer between test runs.
  app.post('/dev/events/clear', (_req, res) => {
    clearEvents();
    res.json({ ok: true });
  });

  // POST /diag/capture — accepts a JSON capture from a connected client and
  // writes it to diag/captures/<timestamp>-<id>.json. Used to diagnose mobile
  // reconciliation issues (and any other "play for a bit then capture" loop).
  // Files there are gitignored.
  app.use('/diag', diagRouter);

  // GET /dev/stats?email=foo — kill/death counts for a user. Phase 7 E2E gate.
  app.get('/dev/stats', devStatsHandler);

  // GET /dev/limbo?playerId=foo — Phase 8 sub-phase B Limbo inspection.
  app.get('/dev/limbo', devLimboHandler);

  // GET /dev/webrtc-counters?roomId=<colyseus-roomId> — Phase 4 iteration 3
  // swift-otter diagnostic. Returns the room's per-session WebRTC counters
  // (sentViaDc / sentViaWs / degraded / dcThrows / etc) so the Phase 4
  // E2E can localise DC throughput variance.
  app.get('/dev/webrtc-counters', (req, res) => {
    void devWebrtcCountersHandler(req, res);
  });

  // GET /dev/memory — where the server's memory goes: the process (rss, V8
  // heap, external/array buffers) and each room's physics worker heap. Found
  // 2026-11-07: an idle dev server held ~1.7 GB, ~37 MB of it per sector
  // worker before any body exists.
  // `?gc=1` collects garbage first (main thread + each physics worker), so the
  // reading is what is live, not what V8 has not collected yet. Needs the
  // server started with --expose-gc (scripts/soak-galaxy.ts does); else a no-op.
  app.get('/dev/memory', (req, res) => {
    void (async () => {
      const MB = 1048576;
      const gc = req.query['gc'] === '1';
      if (gc) (globalThis as { gc?: () => void }).gc?.();
      const m = process.memoryUsage();
      const listings = await matchMaker.query({});
      const gcDone = new Set<number>();
      const rooms: Array<{ room: string; roomId: string; clients: number; worker: number | null }> = [];
      const workers = new Map<number, number>(); // pool worker → heap MB (shared by its rooms)
      for (const l of listings) {
        const r = matchMaker.getLocalRoomById(l.roomId) as unknown as SectorRoom | undefined;
        // One collection per pool worker (several rooms share one).
        const idx = r && typeof r.workerHeapStats === 'function' ? (await r.workerHeapStats(false))?.workerIndex : undefined;
        const wantGc = gc && idx !== undefined && !gcDone.has(idx);
        if (wantGc) gcDone.add(idx);
        const h = r && typeof r.workerHeapStats === 'function' ? await r.workerHeapStats(wantGc) : null;
        if (h) workers.set(h.workerIndex, Math.round(h.usedBytes / MB));
        rooms.push({ room: l.name, roomId: l.roomId, clients: l.clients, worker: h ? h.workerIndex : null });
      }
      res.json({
        rssMb: Math.round(m.rss / MB), heapUsedMb: Math.round(m.heapUsed / MB), heapTotalMb: Math.round(m.heapTotal / MB),
        externalMb: Math.round(m.external / MB), arrayBuffersMb: Math.round(m.arrayBuffers / MB),
        rooms: rooms.length, physicsWorkers: workers.size,
        workerHeapMb: Object.fromEntries(workers), workerHeapTotalMb: [...workers.values()].reduce((s, v) => s + v, 0),
        perRoom: rooms,
      });
    })().catch((err: unknown) => res.status(500).json({ error: String(err) }));
  });

  // GET /dev/population — Living World director snapshot (per-sector
  // players/bots, totals, in-transit/respawning) for E2E + diagnostics.
  // Read-only; mirrors /dev/limbo's inspection-only shape.
  app.get('/dev/population', (req, res) => {
    // `?allegiance=robots` inspects the robot director (Living World P1b).
    const d = req.query['allegiance'] === 'robots' ? robotDirector : livingWorldDirector;
    res.json(d ? d.snapshot() : { ready: false });
  });

  // POST /dev/world-event/start?kind=incursion|mothership|salvage&sector=<key>
  // — Living World P4b test trigger: start a world event now (no 9-min lull).
  app.post('/dev/world-event/start', (req, res) => {
    const kind = String(req.query['kind'] ?? '');
    const sector = String(req.query['sector'] ?? '');
    if (!eventDirector || !(WORLD_EVENT_KINDS as readonly string[]).includes(kind)) {
      res.status(400).json({ ok: false });
      return;
    }
    res.json({ ok: eventDirector.startEvent(kind as WorldEventKind, sector), event: eventDirector.activeEvent() });
  });

  // GET /dev/time-scale — every live sector's game speed (time scale stream).
  // POST /dev/time-scale?room=<roomId|sectorKey>&scale=N — set one sector's
  // speed (0.25–4), e.g. for a demo, a video or slow motion.
  const timeScaleRooms = async (): Promise<SectorRoom[]> => {
    const out: SectorRoom[] = [];
    for (const l of await matchMaker.query({})) {
      const r = matchMaker.getLocalRoomById(l.roomId) as unknown as SectorRoom | undefined;
      if (r && typeof r.setTimeScale === 'function') out.push(r);
    }
    return out;
  };
  app.get('/dev/time-scale', (_req, res) => {
    void timeScaleRooms().then((rooms) => res.json({
      rooms: rooms.map((r) => ({ roomId: r.roomId, sectorKey: r.timeScaleSectorKey(), timeScale: r.gameClock.scale })),
    })).catch((err: unknown) => res.status(500).json({ error: String(err) }));
  });
  app.post('/dev/time-scale', (req, res) => {
    const target = String(req.query['room'] ?? '');
    const scale = Number(req.query['scale']);
    if (!target || !Number.isFinite(scale) || scale <= 0) { res.status(400).json({ ok: false }); return; }
    void timeScaleRooms().then((rooms) => {
      const r = rooms.find((x) => x.roomId === target || x.timeScaleSectorKey() === target);
      if (!r) { res.status(404).json({ ok: false }); return; }
      // Glides there like a dimmer; `&snap=1` jumps at once.
      res.json({ ok: true, roomId: r.roomId, timeScale: r.setTimeScale(scale, req.query['snap'] !== '1') });
    }).catch((err: unknown) => res.status(500).json({ error: String(err) }));
  });

  // GET /dev/audit?player=&owner=&sector=&event=&since=&until=&limit=&source=&format=
  // — query the gameplay audit log (durable NDJSON history + live ring tail).
  // Answers "what happened to my base?" from the running server. The audit
  // WRITE path is NOT gated (runs in normal play); only this read endpoint is.
  app.get('/dev/audit', (req, res) => {
    void devAuditHandler(req, res);
  });

  // GET /dev/player-ships?playerId=foo — Phase 2 multi-ship roster
  // inspection. Returns the player's full roster (up to 10 entries).
  app.get('/dev/player-ships', devPlayerShipsHandler);

  // POST /dev/player-ships/:shipId/abandon — Phase 3 roster abandonment.
  // Body: { playerId: string }. Drops a stored / lingering ship from the
  // roster. Returns 409 when the ship is currently active.
  app.post('/dev/player-ships/:shipId/abandon', devPlayerShipsAbandonHandler);

  // POST /dev/reset-sector?key=<roomName> — surgical reset for smoke testing.
  // Wipes one (or all) sector's in-memory + persisted swarm state and forces
  // a fresh re-spawn. See diagRouter.ts for the full mechanism.
  app.post('/dev/reset-sector', (req, res) => {
    void devResetSectorHandler(req, res);
  });

  // POST /dev/reset-roster — wipe a player's roster rows. Used by the
  // happy-path UI E2E to ensure a known-empty starting roster.
  app.post('/dev/reset-roster', devResetRosterHandler);
}

const httpServer = createServer(app);

// plan: imperative-taco-r2 webrtc, Phase -1 — explicit TCP_NODELAY belt-
// and-braces. The `ws` library already calls `socket.setNoDelay()` on every
// WebSocket connection (node_modules/ws/lib/websocket.js:242), so Nagle's
// algorithm should be disabled by default. We re-apply at the TCP-level
// `connection` event for two reasons:
//   1. Guards against future `ws` version changes that drop the default.
//   2. Logs that setNoDelay was applied so phone-smoke captures contain
//      runtime confirmation. Node's `net.Socket` doesn't expose a read-
//      back getter for the TCP_NODELAY state (only the `setNoDelay()`
//      setter), so we record that the call succeeded — not the value.
let _tcpNoDelayLoggedOnce = false;
httpServer.on('connection', (socket) => {
  try {
    socket.setNoDelay(true);
    if (!_tcpNoDelayLoggedOnce) {
      _tcpNoDelayLoggedOnce = true;
      logger.info(
        { applied: true, kind: 'tcp_nodelay_first_connection' },
        'TCP_NODELAY applied to first inbound connection',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'setNoDelay failed on inbound connection');
  }
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// Phase 8 — register one persistent SectorRoom per galaxy sector. These rooms
// are eagerly instantiated in main() (see matchMaker.create loop) so they
// hydrate from snapshots at boot, not on first traveller, and so transit
// reservations always find a live room. They survive having zero players —
// the simulation continues to tick (drones patrol, asteroids drift) so the
// world feels alive even when nobody's logged in.
for (const sector of GALAXY_SECTORS) {
  gameServer.define(`galaxy-${sector.key}`, SectorRoom, resolveSectorConfig(sector.key));
}

// Engineering + test rooms (plan squishy-canyon, S6): registered ONLY outside
// production (or with EQX_ENABLE_TEST_ROOMS=1). They carry testMode overrides
// (initialHull, testTimeScale, dronePoses, startHostile) and load/burn knobs
// (swarm-tidi-burn's tickBurnMs is a free CPU-burn DoS) that must never be
// joinable by a production client. The galaxy rooms above stay unconditional.
if (shouldRegisterTestRooms()) {
// Engineering rooms — defined here, NOT pre-created. They lazy-spawn on first
// `joinOrCreate` and have no persistent identity (sectorKey is undefined),
// so their state is ephemeral by design.
gameServer.define('sector', SectorRoom, { maxClients: 16 });
// `filterBy(['testId'])` lets each Playwright spec create its OWN room
// instance by passing a unique `testId` in JoinOptions. Without a
// testId the room is shared (back-compat). Per-test isolation +
// parallelism: two specs running concurrently each get their own
// physics worker + Colyseus state, with no cross-test pollution.
gameServer
  .define('test-sector', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    maxClients: 8,
  })
  .filterBy(['testId']);
// E2E-only accelerated test sector — physics ticks 10x faster so
// ghost-TTL / projectile-lifetime / regen / warp-spool tests compress
// real-time waits 10x. Same shape as test-sector otherwise (no drones,
// no asteroids, testMode=true). Same `filterBy(['testId'])` isolation
// as above.
gameServer
  .define('test-sector-fast', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    maxClients: 8,
    testTimeScale: 10,
  })
  .filterBy(['testId']);
// Auto-fire E2E room (weapon-autofire-boost-mechanics). A single hull-exposed
// drone parked 150 u ahead of the player spawn — within every weapon's
// auto-fire range (beam 250). Join with `?startHostile=1` to make the drone
// aggress: it marks hostile server-side and attacks, and the resulting `damage`
// → `markHostile` mirror reliably flags it hostile on the CLIENT once the drone
// has registered (the join-time `bot_aggro` alone can race ahead of client
// registration). The client then auto-fires back with NO player input — pair
// with a high `?initialHull` so the player survives to fire. WITHOUT
// `startHostile` the drone stays neutral/idle, so the spec can also assert
// auto-fire does NOT engage a non-hostile drone. `testTimeScale: 10` compresses
// the cooldown/regen cadence. `dronePoses` is a hardcoded room option (NOT a URL
// param), so the drone must live in a dedicated room like this — `test-sector-
// fast` has no drones. filterBy(testId) isolates parallel specs.
gameServer
  .define('auto-fire-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    testTimeScale: 10,
    dronePoses: [{ kind: 'fighter', x: 0, y: 150, angle: 0, hullExposed: true }],
    defaultSpawnX: 0,
    defaultSpawnY: 0,
    maxClients: 4,
  })
  .filterBy(['testId']);
// 2026-06-03 — deterministic respawn-cascade environment (test-coverage-audit
// Phase 3). A test-sector with 4 drones so a client joining `?startHostile=1`
// reproduces the BOT-PRESSURE conditions the original
// `respawn-cascade-input-routing.spec.ts` needed (the orphaned-client bug
// "only repros under bot pressure" — it passed in the no-hostility feel-test).
// The spec pairs this with a huge `initialHull` so the player SURVIVES the
// pressure (hostile fire still drives the damage/aggro state-churn that the
// cascade cleanup must tolerate, but the player never dies → the thrust-moves-
// the-ship assertion stays deterministic). Replaces the old spec's live
// `galaxy-sol-prime` + `diag=1` join.
gameServer
  .define('cascade-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    droneCount: 4,
    maxClients: 8,
  })
  .filterBy(['testId']);
// exp/fire-control — a 1v3 for the Fire Control footage + e2e: two fighters and a
// heavy parked ~1400 u ahead of spawn. Join with ?startHostile=1&ui=d: you fly in
// and lock them while they lock you (locking goes both ways).
gameServer
  .define('fc-duel', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    dronePoses: [
      { kind: 'fighter', x: -320, y: 1400, angle: Math.PI },
      { kind: 'heavy', x: 0, y: 1550, angle: Math.PI },
      { kind: 'fighter', x: 320, y: 1400, angle: Math.PI },
    ],
    defaultSpawnX: 0,
    defaultSpawnY: 0,
    maxClients: 4,
  })
  .filterBy(['testId']);
// Phase 5e soak room. swarmCount can be overridden per join via room
// options, but the default of 500 is the master plan's acceptance gate.
gameServer.define('swarm-soak', SectorRoom, {
  swarmCount: 500,
  swarmRatio: 0.8,
  swarmRadius: 18_000,
  maxClients: 8,
});
// 2026-05-09 — AI lockstep "feel" test room. Tight cluster of drones around
// origin so the player can engage immediately and observe per-drone AI
// behaviour without the swarm-soak server-hitch / GC-pause confounders.
// Spawns at (0,0) by default; URL-param `spawnX`/`spawnY` still wins.
gameServer.define('feel-test', SectorRoom, {
  testMode: true,
  asteroidConfig: [],
  swarmCount: 10,
  swarmRatio: 0,        // 0 asteroids — 10 drones only
  swarmRadius: 300,     // tight ring centred on origin
  defaultSpawnX: 0,
  defaultSpawnY: 0,
  maxClients: 4,
});
// 2026-05-18 — drone-snapshot-interpolation pivot, Step 6 render-smoothness
// regression lock. 25 drones (the >12 in-pack regime the old 10-drone
// `feel-test` room was structurally blind to — the bug the pivot fixed
// only manifests above ~12). Used by `tests/e2e/feel-test-lockstep.spec.ts`
// to assert on-screen drone sprites TRACK (never pin/freeze/lurch) while
// the player strafes through the pack. Same shape as `feel-test`, wider
// ring so 25 drones aren't overlapping at spawn.
gameServer.define('feel-test-25', SectorRoom, {
  testMode: true,
  asteroidConfig: [],
  swarmCount: 25,
  swarmRatio: 0,        // 0 asteroids — 25 drones only
  swarmRadius: 500,     // ring centred on origin, room for 25
  defaultSpawnX: 0,
  defaultSpawnY: 0,
  maxClients: 4,
});
// Six hull-exposed `havok` COMPOSITE drones ringed close to the player spawn;
// with `?startHostile=1` the player auto-fires and each kill breaks into one
// scrap entity per component. Was the netgate `scrap-load` scenario (removed in
// wrap-up W4); still used by the scrap showcase shot.
gameServer.define('feel-test-scrap', SectorRoom, {
  testMode: true,
  asteroidConfig: [],
  dronePoses: [
    { kind: 'havok', x: 200, y: 0, hullExposed: true },
    { kind: 'havok', x: -200, y: 0, hullExposed: true },
    { kind: 'havok', x: 0, y: 200, hullExposed: true },
    { kind: 'havok', x: 0, y: -200, hullExposed: true },
    { kind: 'havok', x: 150, y: 150, hullExposed: true },
    { kind: 'havok', x: -150, y: -150, hullExposed: true },
  ],
  defaultSpawnX: 0,
  defaultSpawnY: 0,
  maxClients: 4,
});
// Phase-1 issue 5 (2026-06-18) — scrap-collision reproduction. Pre-seeds 50
// free-floating SCRAP pieces in a dense corridor AHEAD of spawn (a steady `scenarioScrap` seed
// instead of death-timing-dependent drone kills (cf. feel-test-scrap)). The E2E flies the player
// straight through to measure prediction corrections/drift through a scrap
// cascade. testMode-true + filterBy(testId) for isolation. Drives
// `tests/e2e/scrap-collision-stress.spec.ts`.
gameServer
  .define('scrap-stress-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    scenarioScrapCount: 50,
    defaultSpawnX: 0,
    defaultSpawnY: 0,
    maxClients: 4,
  })
  .filterBy(['testId']);
// 2026-06-01 — phone-stall-test: heavy-combat repro environment for
// `tests/mobile-perf/phone-galaxy-stall-repro.spec.ts`. 35 drones in
// a tight ring (matches the user's wb1al4/jfd81u swarm count) so the
// load is immediate (no Living World warp-in wait) and the test
// doesn't pollute live galaxy rooms. testMode-true → accepts
// `initialHull` / `initialShield` / `startHostile` JoinOptions
// (near-invulnerable ship at full hostile-from-spawn aggro).
gameServer
  .define('phone-stall-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    swarmCount: 35,
    swarmRatio: 0,
    swarmRadius: 800,
    defaultSpawnX: 0,
    defaultSpawnY: 0,
    maxClients: 4,
  })
  .filterBy(['testId']);
// 2026-05-11 — Phase 4c (multi-mount / turret refactor) engineering room.
// Deterministic spawn of 6 multi-mount drones (alternating interceptor +
// gunship) in a tight ring 250 u from origin, so the player spawns into
// immediate view of every rotating-turret kind. Use `?room=mount-test`
// from the URL to join. Drones spawn IDLE (orbiting origin); fire any
// weapon at one to mark it hostile and trigger COMBAT so its turrets
// start tracking you. The `droneKinds` round-robin ensures exactly
// 3 interceptors + 3 gunships every time, no asteroid clutter, no
// random fighter/scout/heavy filler. Spawn at origin.
gameServer.define('mount-test', SectorRoom, {
  testMode: true,
  asteroidConfig: [],
  swarmCount: 6,
  swarmRatio: 0,
  swarmRadius: 250,
  droneKinds: ['interceptor', 'gunship', 'interceptor', 'gunship', 'interceptor', 'gunship'],
  defaultSpawnX: 0,
  defaultSpawnY: 0,
  maxClients: 4,
});
// 2026-05-27 — Shield-test engineering room. Five non-hostile drones in
// a 200 u ring around origin so the player can ram them and fire at
// their shields without combat noise. One of each non-fighter kind for
// visual variety + so the player can confirm the per-kind shield
// radius math (SHIELD_RADIUS_PAD) is correct on every silhouette.
//
// Drones spawn IDLE — they orbit gently around the ring. They become
// Drones run `PassiveDroneBehaviour` (peacefulDrones: true) — they take
// damage and die normally, but they never pursue or fire, so the player
// can ram + beam them indefinitely without combat noise drowning out the
// shield/hull collider-swap signal under test.
//
// Use `?room=shield-test` from the URL to join.
gameServer.define('shield-test', SectorRoom, {
  testMode: true,
  asteroidConfig: [],
  // 6 drones in the gallery: 4 huge Crossguard T-ships dominate the
  // scene + 1 fighter + 1 scout for size-contrast reference. With
  // each Crossguard at radius 200, swarmRadius bumped to 2400 so they
  // don't overlap-spawn (the SwarmSpawner places them uniformly inside
  // the disc — at 200 radius each, 4 of them need ~1600+ u of headroom).
  swarmCount: 6,
  swarmRatio: 0,
  swarmRadius: 2400,
  droneKinds: ['crossguard', 'crossguard', 'crossguard', 'crossguard', 'fighter', 'scout'],
  peacefulDrones: true,
  defaultSpawnX: 0,
  defaultSpawnY: 0,
  maxClients: 4,
});
// 2026-05-28 (poses retuned 2026-06-11) — Hull-collision engineering room.
// Deterministic "interlock" scenario: two stationary Crossguards nested as
// tightly as possible WITHOUT their polygons touching — every contact face is
// exactly 1 u apart. Bounding circles overlap by ~120 u, so the polygon
// collider's correctness is the only thing keeping them from colliding.
//
// Clean right-angle T (the elbow slope was removed 2026-06-11). The Crossguard
// polygon (post the `shipShapeToPolygon` Y-flip + scale 10) in body-local math
// frame is:
//   - Crossbar: x ∈ [-140, +140], y ∈ [+100, +160]
//   - Stem:     x ∈ [-40,  +40], y ∈ [-120, +100]   (reflex flush at y=+100)
// "Forward" (math +Y) = direction of the crossbar.
//
// With a clean (flat-bottomed) crossbar the closest crossbar↔stem approach is
// the OUTER crossbar bottom at y=+100 (no slope), so the exact 1 u-gap offsets
// are Δx = 81 (stem-width 80 + 1) and Δy = 21:
//   - T1 (upright T)  at (-40.5, +10.5), angle 0
//       stem world:    x ∈ [-80.5, -0.5], y ∈ [-109.5, +110.5]
//       crossbar bottom world: y = +110.5
//   - T2 (inverted T) at (+40.5, -10.5), angle π
//       stem world:    x ∈ [+0.5, +80.5], y ∈ [-110.5, +109.5]
//       crossbar bottom world (inverted → top): y = -110.5
//
// All three 1 u minimum gaps:
//   - Stems  (x): T1 right edge -0.5 to T2 left edge +0.5 → 1 u
//   - T1 stem bottom (-109.5) to T2 crossbar top (-110.5) → 1 u
//   - T2 stem top   (+109.5) to T1 crossbar bottom (+110.5) → 1 u
//
// `setHullExposed` emits TRIANGLE colliders, which DO fire CONTACT_FORCE_EVENTS
// for static overlap (`convexHull` does not — the 2026-05-28 regression). So a
// spurious contact at the 1 u interlock (wrong-winding triangle, Y-axis flip, a
// collider exceeding the silhouette) fires `collision_resolved` and the
// `tests/e2e/t-ship-no-self-collision.spec.ts` negative-control fails — and the
// `hull-collision-overlap-test` POSITIVE control proves the events would fire.
//
// Use `?room=hull-collision-test&testId=<uuid>` from a browser to load
// the scenario. `filterBy(['testId'])` so parallel specs each get their
// own physics-worker-backed room.
gameServer
  .define('hull-collision-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    dronePoses: [
      { kind: 'crossguard', x: -40.5, y:  10.5, angle: 0,         hullExposed: true },
      { kind: 'crossguard', x:  40.5, y: -10.5, angle: Math.PI,   hullExposed: true },
    ],
    // Spawn the player NEAR the test scene (not at 1500u away) so the
    // initial predWorld-vs-server lerp doesn't visually drag the
    // player through the drones during the spawn-correction window.
    // Smoke 2026-05-28 (capture 40uesb) showed `lerpOffset: (-1500, 0)`
    // for 5+ seconds after join — visually the player appeared at (0,0)
    // overlapping the drones while predWorld was at (1500, 0) and no
    // collision could fire. 600 u east-of-scene keeps the player clear
    // of the I-beam (which is x ∈ [-180.5, +180.5]) so they spawn outside
    // the drones, and close enough that the welcome → first-snapshot
    // pose-reconcile is <1 s of perceived drift.
    defaultSpawnX: 600,
    defaultSpawnY: 0,
    maxClients: 4,
  })
  .filterBy(['testId']);
// Generic Entity Pipeline P4 — `?room=structure-test&testId=<uuid>` loads a
// single static, damageable STRUCTURE (pose-core kind 2) directly ahead of the
// player so the browser can verify it renders + is shootable (the client half
// of the "for free" proof). filterBy(['testId']) isolates parallel specs.
gameServer
  .define('structure-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    structurePoses: [
      // Straight ahead of a spawn-angle-0 ship (forward = +Y), well within
      // weapon range so a forward shot lands on the structure's collider.
      { id: 'struct-0', x: 0, y: 150, radius: 60 },
    ],
    defaultSpawnX: 0,
    defaultSpawnY: 0,
    maxClients: 4,
  })
  .filterBy(['testId']);
// Gates (plan soft-leaping-truffle v2, phase V) — two powered Shield Gates:
// west opens for anyone not hostile, east is owner-only (owner `scenario`).
// Spawn south of a gate with ?spawnX=±400&spawnY=-1300 and fly north.
gameServer
  .define('gate-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    structureGridPulseMs: 100,
    prebuiltStructures: GATE_TEST_PREBUILT.map((p) => ({ ...p })),
    defaultSpawnX: -400,
    defaultSpawnY: -1300,
    maxClients: 4,
  })
  .filterBy(['testId']);
// Structures plan (Phase 3-5) — a fully-built, POWERED grid scenario for the
// client-half E2Es. Pre-built (no construction wait) + auto-connected: a Capital
// + 2 Solar (power), a Miner next to an asteroid (mining → mineral bank), and a
// Turret next to a parked drone (turret kills it). Avoids the place-ahead UI
// overlap problem; the E2E observes the grid-power / minerals HUD + the drone
// dying (swarm count drops). filterBy(['testId']) isolates parallel specs.
gameServer
  .define('structure-scenario-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    structureGridPulseMs: 100,
    // Phase V footprints — the shared powered scenario grid (see scenarioLayouts.ts).
    prebuiltStructures: [...STRUCTURE_SCENARIO_PREBUILT],
    scenarioAsteroids: [{ ...SCENARIO.asteroid }],
    scenarioDrones: [{ ...SCENARIO.drone }],
    defaultSpawnX: 900,
    defaultSpawnY: 900,
    maxClients: 4,
  })
  .filterBy(['testId']);
// Showcase capture rooms — staged scenes for the repeatable showcase video
// (docs/architecture/showcase-pipeline.md). Options live in
// rooms/showcaseRooms.ts so the integration test boots exactly these.
for (const [name, opts] of Object.entries(SHOWCASE_ROOMS)) {
  gameServer.define(name, SectorRoom, opts).filterBy(['testId']);
}
// Off-screen radar SANDBOX (plan sparkling-wondering-rose) — `?room=radar-sandbox`.
// The ship spawns at a FIXED point S=(-3000,-3000) (off-centre so contacts can sit
// beyond the 10 000 u radar range while staying inside the drone ±10 000 /
// structure ±5 000 world bounds). Every contact is at a MEASURED offset from S:
// one drone ON screen (must get no icon), static contacts at graded distances +
// bearings (incl. diagonals/corners), one beyond range (must get no icon),
// hostile vs neutral, structures + an asteroid, and three drones on scripted
// paths — flying in/out of view, a tangential pass and a corner crossing.
// Peaceful (nothing attacks). Join with a testId to isolate parallel specs.
const RADAR_S = { x: -3000, y: -3000 };
const rs = (dx: number, dy: number): { x: number; y: number } => ({ x: RADAR_S.x + dx, y: RADAR_S.y + dy });
const RADAR_SANDBOX_LAYOUT = {
  spawn: RADAR_S,
  dronePoses: [
    { kind: 'fighter' as const, ...rs(350, 0) },                 // 0 on screen at zoom 1 → no icon
    { kind: 'fighter' as const, ...rs(900, 0), hostile: true },   // 1 east, near, hostile
    { kind: 'fighter' as const, ...rs(0, 1800) },                 // 2 north, mid
    { kind: 'fighter' as const, ...rs(-2500, 0), hostile: true }, // 3 west, far-ish, hostile
    { kind: 'fighter' as const, ...rs(2475, -2475) },             // 4 SE diagonal ~3500
    { kind: 'fighter' as const, ...rs(4950, 4950) },              // 5 NE ~7000 (far)
    { kind: 'fighter' as const, ...rs(7780, 7780) },              // 6 ~11 000 → beyond range, no icon
    { kind: 'fighter' as const, ...rs(-1500, -1100), hostile: true }, // 7 SW
    // Scripted movers.
    { kind: 'fighter' as const, ...rs(300, 250), path: { toX: RADAR_S.x + 3300, toY: RADAR_S.y + 250, speed: 260 } },           // 8 fly in/out east
    { kind: 'fighter' as const, ...rs(-2200, 1100), path: { toX: RADAR_S.x + 2200, toY: RADAR_S.y + 1100, speed: 320 }, hostile: true }, // 9 tangential north
    { kind: 'fighter' as const, ...rs(500, -500), path: { toX: RADAR_S.x + 2500, toY: RADAR_S.y - 2500, speed: 200 } },          // 10 corner crossing SE
  ],
  prebuiltStructures: [
    { kind: 'capital' as const, ...rs(-1200, 1400) },
    { kind: 'solar' as const, ...rs(1600, -1200) },
  ],
  scenarioAsteroids: [{ ...rs(-700, -1500), radius: 40 }],
};
gameServer
  .define('radar-sandbox', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    dronePoses: RADAR_SANDBOX_LAYOUT.dronePoses,
    prebuiltStructures: RADAR_SANDBOX_LAYOUT.prebuiltStructures,
    scenarioAsteroids: RADAR_SANDBOX_LAYOUT.scenarioAsteroids,
    defaultSpawnX: RADAR_S.x,
    defaultSpawnY: RADAR_S.y,
    maxClients: 4,
  })
  .filterBy(['testId']);
// Structure SCALE (plan soft-leaping-truffle v2, A0): a citadel-size, rule-valid
// structure lattice (448 structures incl. a 48-pylon fence, all built +
// powered, owner 'scenario'). For scale measurement, perf arms and showcases.
// Spawn sits south of the fence (fence half-extent 2300).
gameServer
  .define('structure-scale-test', SectorRoom, {
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    peacefulDrones: true,
    scaleGrid: { n: 400, seed: 7, fence: true },
    defaultSpawnX: 0,
    defaultSpawnY: -2900,
    maxClients: 8,
  })
  .filterBy(['testId']);
// D2 (plan soft-leaping-truffle v3) — one NPC base grown by the production-chain
// generator per room (npc-base-<tier>), owned by npc:traders:<tier>, built and
// stocked; the pilot spawns south of the fence. filterBy(testId) isolates specs.
gameServer
  .define('npc-base-outpost', SectorRoom, {
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    peacefulDrones: true,
    sectorFeatures: ['asteroid'],
    npcBases: [{ baseId: 'outpost', role: 'mining', tier: 'outpost', seed: 11, x: 0, y: 0, features: ['asteroid'] }],
    defaultSpawnX: 0,
    defaultSpawnY: -2600,
    maxClients: 8,
  })
  .filterBy(['testId']);
gameServer
  .define('npc-base-settlement', SectorRoom, {
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    peacefulDrones: true,
    sectorFeatures: ['minerals'],
    npcBases: [{ baseId: 'settlement', role: 'refinery', tier: 'settlement', seed: 12, x: 0, y: 0, features: ['minerals'] }],
    defaultSpawnX: 0,
    defaultSpawnY: -3600,
    maxClients: 8,
  })
  .filterBy(['testId']);
gameServer
  .define('npc-base-stronghold', SectorRoom, {
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    peacefulDrones: true,
    sectorFeatures: [],
    npcBases: [{ baseId: 'stronghold', role: 'manufactory', tier: 'stronghold', seed: 14, x: 0, y: 0, features: [] }],
    defaultSpawnX: 0,
    defaultSpawnY: -4400,
    maxClients: 8,
  })
  .filterBy(['testId']);
gameServer
  .define('npc-base-citadel', SectorRoom, {
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    peacefulDrones: true,
    sectorFeatures: [],
    npcBases: [{ baseId: 'citadel', role: 'assembly', tier: 'citadel', seed: 15, x: 0, y: 0, features: [] }],
    defaultSpawnX: 0,
    defaultSpawnY: -4800,
    maxClients: 8,
  })
  .filterBy(['testId']);
// D3 — a habitat station (role colony: habitat modules, spires, hydroponics) for the showcase and
// tests.
gameServer
  .define('npc-base-colony', SectorRoom, {
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    peacefulDrones: true,
    sectorFeatures: ['station'],
    npcBases: [{ baseId: 'colony', role: 'colony', tier: 'settlement', seed: 16, x: 0, y: 0, features: ['station'] }],
    defaultSpawnX: 0,
    defaultSpawnY: -3600,
    maxClients: 8,
  })
  .filterBy(['testId']);
// Wave-system E2E (tests/e2e/wave-attack.spec.ts) — a DIRECTOR-MANAGED galaxy
// room (real sectorKey) seeded with a PRE-BUILT, player-owned READY base
// (Capital + Miner + Solar + Turret, owner `wave-tester`). Single eager
// instance (NO filterBy) so the LivingWorldDirector can hold a reference (it's
// added to the director's room map at boot when `EQX_E2E_WAVE=1`). The base is
// ready at boot; `waveNeedsOwner` holds the wave until the test client joins
// AS the owner, so the spec draws its wave whenever it runs. Asteroids + a
// parked drone give the seeded turret + miner something to do. droneCount 0 so
// the only drones that appear are the incoming wave squad.
gameServer.define('galaxy-wave-test', SectorRoom, {
  sectorKey: 'galaxy-wave-test',
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  // NOT peacefulDrones: the room has no ambient drones, and the option gave
  // the WAVE's own bots the passive brain (spawnDrone uses the room's drone
  // behaviour), so the squad never fired at the base; the spec passed only
  // when a drone happened to ram a structure (2026-11-08).
  structureGridPulseMs: 100,
  // Phase V footprints — the shared powered scenario grid (see scenarioLayouts.ts).
  prebuiltStructures: [...STRUCTURE_SCENARIO_PREBUILT],
  // Fixed sentinel UUID (the server rejects non-UUID playerIds). The wave spec
  // joins AS this id so the seeded base is owned by the present player and the
  // owner-presence gate releases the wave. Kept in sync with
  // tests/e2e/wave-attack.spec.ts WAVE_OWNER_ID.
  prebuiltStructuresOwner: 'face0000-0000-4000-8000-000000000001',
  scenarioAsteroids: [{ ...SCENARIO.asteroid }],
  defaultSpawnX: 0,
  defaultSpawnY: 900,
  maxClients: 4,
  // Every run must start from the seeded READY base: a saved snapshot brought
  // back the last run's razed base and parked hull (2026-11-08).
  persistSector: false,
  // The wave lands within bolt reach of the Solar NW (-250, 400) and outside
  // the Turret's 600 u (it sits at 150, -400), so the attack lands in the
  // spec's window instead of after a flight from anywhere in the sector.
  testWaveArrival: { x: -900, y: 700 },
  // Waves ignore owner presence in play, so without this a wave fired at
  // server boot and landed before a spec that ran later joined (2026-11-09).
  waveNeedsOwner: true,
});
// 2026-05-28 — POSITIVE control for hull-collision-test. Two crossguards
// at exactly the same world position (0, 0), hull-exposed. The polygons
// MUST interpenetrate → Rapier MUST emit contact events → server MUST
// broadcast collision_resolved → client MUST increment
// collisionEventsApplied. If this room ever reports 0, the test
// infrastructure is broken (data-pred-stats not populated, contacts not
// propagating, or the drones aren't actually spawning) — NOT a concave-
// hull defect. Used by the second case in
// `tests/e2e/t-ship-no-self-collision.spec.ts` to lock the assertion
// surface itself, so the no-collision case is meaningful.
gameServer
  .define('hull-collision-overlap-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    dronePoses: [
      { kind: 'crossguard', x: 0, y: 0, angle: 0,         hullExposed: true },
      { kind: 'crossguard', x: 0, y: 0, angle: Math.PI,   hullExposed: true },
    ],
    // Same predWorld-lerp consideration as `hull-collision-test`: park
    // the player close to the test scene so the spawn-correction window
    // doesn't visually drag them through the drones.
    defaultSpawnX: 600,
    defaultSpawnY: 0,
    maxClients: 4,
  })
  .filterBy(['testId']);
// 2026-05-28 — Ramming probe room: a deliberate visual-vs-physics
// stress test. Spawns one gigantic L-shape drone at math (0, 0) angle
// 0 (post Y-flip in `shipShapeToPolygon` the L's vertical arm sits at
// x ∈ [0, 400], y ∈ [-600, 1000]; the horizontal arm at x ∈ [0, 1600],
// y ∈ [-1000, -600]; armpit at math (400, -600)). The local player
// spawns at math (500, 500), facing math -Y (`initialAngle = π`), so
// they thrust straight INTO the armpit and hit the horizontal arm's
// top edge at math y = -600. The `ramming_probe` diag logs every
// frame the player is within 400 u of the L; the
// `tests/e2e/ramming-probe-armpit.spec.ts` test asserts the visual-
// vs-physics gap (`visVsPhys`) stays bounded.
//
// L mass = 5 — heavy enough not to scatter on contact, light enough
// for the player to push it noticeably (so the probe captures both
// the player-side AND the drone-side response). Hull-down on spawn
// (`hullExposed: true`) so the polygon collider is active immediately
// without waiting for shield regen.
gameServer
  .define('ramming-probe-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    // Disable the ramming-damage path entirely — collision_resolved
    // still broadcasts (velocity sync stays lockstep) but applyDamage
    // doesn't fire. Player can ram the L all day without dying;
    // probe gets a clean signal.
    disableCollisionDamage: true,
    // L at math (0, 0), rotated π/4 (45° CCW math). With the symmetric
    // L's reflex at body-local math (-600, -600), the rotation maps it
    // to world (0, -848.5) — directly south of the player spawn.
    // Combined with URL `?initialAngle=3.14159` (= π), forward thrust
    // sends the player straight at the armpit along x=0.
    dronePoses: [
      // 2026-05-28 BISECT — angle 0 (axis-aligned). The L's π/4 rotation
      // put the rectangle's pointy corner directly in the player's path
      // → glancing impact, slide off the corner, escape. With angle 0 the
      // rectangle is axis-aligned: player at (0, 2000) thrusting -Y hits
      // the FLAT top edge at world y = 1000 perpendicular. No sliding —
      // sustained pressure against a flat wall.
      { kind: 'el', x: 0, y: 0, angle: 0, hullExposed: true },
    ],
    defaultSpawnX: 0,
    // 2026-05-28 BISECT — spawn at +2000 so the player starts CLEAR of
    // the scale-10 rectangle test shape. Body-local rectangle spans
    // ±1000, rotated π/4 = world bounding box ~±1414, so spawn at
    // y=500 would be INSIDE the rectangle. Player at y=2000 with
    // `initialAngle=π` thrusts straight down at the rectangle.
    defaultSpawnY: 2000,
    maxClients: 4,
  })
  .filterBy(['testId']);
// 2026-06-03 — deterministic combat target room (test-coverage-audit Phase 3).
// One PEACEFUL, hull-exposed heavy parked at (0, 200) — directly +y of the
// player's (0,0) spawn. A player joining `?room=combat-drone-test&shipKind=
// interceptor` (initialAngle 0 ⇒ faces +y) fires a hitscan beam straight up
// the x=0 line and is GUARANTEED to hit the drone (200u < 250u beam range).
// Used by `tests/e2e/combat/swarm-hit-detected.spec.ts` (observer sees the
// shooter's swarm-N hit) and the rewritten `tests/e2e/drone-destruction.spec.ts`
// (hold fire → drone count drops by exactly 1). peacefulDrones (Passive
// behaviour = stationary) keeps it on the beam line; hullExposed drops its
// shield so the first beam tick lands on hull. Kind 'heavy' (540 HP) is chosen
// so the swarm-hit observer has a ~3.5s window to catch the hit broadcast
// before the drone dies (a 180-HP scout died in ~1.2s and flaked the
// observation on the determinism repeat-pass); the interceptor still destroys
// it well inside drone-destruction's 8s deadline.
gameServer
  .define('combat-drone-test', SectorRoom, {
    testMode: true,
    asteroidConfig: [],
    peacefulDrones: true,
    dronePoses: [
      { kind: 'heavy', x: 0, y: 200, angle: 0, hullExposed: true },
    ],
    defaultSpawnX: 0,
    defaultSpawnY: 0,
    maxClients: 4,
  })
  .filterBy(['testId']);
// 2026-06-03 — isolated, bot-free, LINGER-CAPABLE test room for the
// lingering-hull / ship-pool E2E suite (tests/e2e/linger/).
// Unlike every other test room it carries a real `sectorKey`, so the
// galaxy-only linger + abandon-poll paths (LeaveHandler `shouldLinger`,
// SectorRoom abandon detection) actually fire — engineering rooms
// (sectorKey===null) fully despawn on leave and never linger. It is NOT
// in GALAXY_SECTORS and is NOT eagerly created, so the
// LivingWorldDirector (built from the eager `galaxy-*` map) never routes
// hunter bots here; `droneCount: 0` + `asteroidConfig: []` keep the
// scene deterministic for screenshots. `filterBy(['testId'])` gives
// per-test room isolation. Snapshot persistence writes only benign
// empty-swarm rows (droneCount 0), so no DB guard is needed.
gameServer
  .define('galaxy-test', SectorRoom, {
    sectorKey: 'galaxy-test',
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    maxClients: 8,
  })
  .filterBy(['testId']);
// Living World showcase (plan peppy-jumping-pinwheel) — the scripted video's
// scene: a ROBOT squad and a DRONE squad parked to fight just north of spawn
// (they engage each other on sight — allegiances P0), so loot pods rain down.
// A real sectorKey so roster + holds work (pickup / deposit). Test-only room.
gameServer
  .define('living-world-showcase', SectorRoom, {
    sectorKey: 'living-world-showcase',
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    maxClients: 4,
    dronePoses: [
      { kind: 'fighter', x: -260, y: 520, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'fighter', x: -300, y: 620, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'scout', x: -240, y: 720, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'robot-square', x: 260, y: 540, angle: Math.PI / 2, hullExposed: true },
      { kind: 'robot-square', x: 300, y: 640, angle: Math.PI / 2, hullExposed: true },
      { kind: 'robot-square', x: 240, y: 740, angle: Math.PI / 2, hullExposed: true },
    ],
  })
  .filterBy(['testId']);
// Living World P2 — trade rooms (testMode). Both join the TradeDirector
// (`tradeEnabled`) and stock any storage the player places (`seedStorageHold`),
// so a test can post a deal at once. `trade-showcase` also sends two robot
// cubes to meet each incoming hauler (`haulerRaiders`) — the raid on camera.
gameServer
  .define('trade-test', SectorRoom, {
    sectorKey: 'trade-test',
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    maxClients: 4,
    tradeEnabled: true,
    seedStorageHold: { goods: { salvage: 120, alloy: 20 }, credits: 3000 },
    // Every trade-test instance shares this sectorKey: without this, a test's
    // structures were restored into the next run's room (cargo-panel placed
    // its Capital onto an old one and was refused; test audit 2026-11-06).
    persistSector: false,
  })
  .filterBy(['testId']);
// C2/C3 break-in E2Es: a Capital owned by 'scenario' (a neutral owner, so its
// cargo is locked to a visiting pilot) holding 7 alloy, a peaceful NPC fighter
// beside the spawn, and breakInMs so a break-in resolves in under a second.
// A real sectorKey: cargo access needs the ship's roster row.
gameServer
  .define('break-in-test', SectorRoom, {
    sectorKey: 'break-in-test',
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    peacefulDrones: true,
    breakInMs: 800,
    prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }],
    prebuiltStorageGoods: { alloy: 7 },
    dronePoses: [{ kind: 'fighter', x: 260, y: -650, angle: 0 }],
    defaultSpawnX: 0,
    defaultSpawnY: -650,
    maxClients: 4,
  })
  .filterBy(['testId']);
// v4 T1 — teleporters: a powered Capital with a teleporter on each side,
// paired at seed, owned by a fixed sentinel the E2E joins as (anonymous
// context + localStorage eqxPlayerId). Jump cycles run 10× fast and the grid
// pulses every 100 ms, so a capacitor fills in a couple of seconds.
const TELEPORT_TEST_OPTS = {
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  peacefulDrones: true,
  structureGridPulseMs: 100,
  prebuiltStructures: [
    { kind: 'capital', x: 0, y: 0 },
    { kind: 'connector', x: -600, y: 0 },
    { kind: 'connector', x: 600, y: 0 },
    { kind: 'teleporter', x: -1300, y: 0 },
    { kind: 'teleporter', x: 1300, y: 0 },
  ],
  prebuiltStructuresOwner: TELEPORT_TEST_OWNER,
  prebuiltStorageGoods: { alloy: 50 },
  pairTeleporters: true,
  defaultSpawnX: 0,
  defaultSpawnY: 900,
  maxClients: 4,
};
gameServer
  .define('teleport-test', SectorRoom, { ...TELEPORT_TEST_OPTS, sectorKey: 'teleport-test', teleportCycleScale: 0.1 })
  .filterBy(['testId']);
// v4 A — one alien gate (no twin) for the disable E2E: firing inside its
// zone disables the pilot. Spawn at (0, -1500) (inside the zone).
gameServer
  .define('alien-gate-test', SectorRoom, {
    sectorKey: 'alien-gate-test',
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    peacefulDrones: true,
    testAlienGate: { x: 0, y: 0, neighbour: 'vega-reach' },
    // Lock-to-fire: a peaceful fighter just ahead of the spawn (inside the
    // gate's zone) gives the pilot something to lock and fire at.
    dronePoses: [{ kind: 'fighter', x: 0, y: -1350, angle: 0, hullExposed: true }],
    defaultSpawnX: 0,
    defaultSpawnY: -1500,
    maxClients: 4,
  })
  .filterBy(['testId']);
// v4 T4 — the same layout with a half-speed cycle, so a rider has ~6 s
// between the toll prompt (pad armed) and the swap to answer it.
gameServer
  .define('teleport-toll-test', SectorRoom, { ...TELEPORT_TEST_OPTS, sectorKey: 'teleport-toll-test', teleportCycleScale: 0.5 })
  .filterBy(['testId']);
gameServer
  .define('trade-showcase', SectorRoom, {
    sectorKey: 'trade-showcase',
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    maxClients: 4,
    tradeEnabled: true,
    seedStorageHold: { goods: { salvage: 120, alloy: 20 }, credits: 3000 },
    haulerRaiders: 2,
  })
  .filterBy(['testId']);
// Living World P3 showcase — a robot NEXUS (shields down) guarded by robot
// cubes, with a drone pack drifting in. testMode, filterBy testId.
gameServer
  .define('nexus-showcase', SectorRoom, {
    sectorKey: 'nexus-showcase',
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    maxClients: 4,
    dronePoses: [
      { kind: 'robot-nexus', x: 0, y: 700, angle: Math.PI, hullExposed: true },
      { kind: 'robot-square', x: -260, y: 560, angle: Math.PI, hullExposed: true },
      { kind: 'robot-square', x: 260, y: 560, angle: Math.PI, hullExposed: true },
      { kind: 'robot-circle', x: 0, y: 480, angle: Math.PI, hullExposed: true },
      { kind: 'fighter', x: -700, y: 200, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'fighter', x: -760, y: 320, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'heavy', x: -820, y: 140, angle: -Math.PI / 2, hullExposed: true },
    ],
  })
  .filterBy(['testId']);
// Living World P1b showcase — one full mixed-tier ROBOT squad (hexagon lead,
// two circles, three cubes) vs six drones, the pilot spawning between them.
// Robots are hostile to the pilot too, so the recording shows a real three-way
// fight. testMode, filterBy testId (one room per recording).
gameServer
  .define('robots-showcase', SectorRoom, {
    sectorKey: 'robots-showcase',
    testMode: true,
    droneCount: 0,
    asteroidConfig: [],
    maxClients: 4,
    dronePoses: [
      // Shields start DOWN (hullExposed) so kills land within a short recording.
      { kind: 'fighter', x: -420, y: 380, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'fighter', x: -470, y: 500, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'fighter', x: -420, y: 620, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'scout', x: -520, y: 440, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'scout', x: -520, y: 580, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'heavy', x: -600, y: 510, angle: -Math.PI / 2, hullExposed: true },
      { kind: 'robot-hexagon', x: 560, y: 510, angle: Math.PI / 2, hullExposed: true },
      { kind: 'robot-circle', x: 470, y: 420, angle: Math.PI / 2, hullExposed: true },
      { kind: 'robot-circle', x: 470, y: 600, angle: Math.PI / 2, hullExposed: true },
      { kind: 'robot-square', x: 400, y: 360, angle: Math.PI / 2, hullExposed: true },
      { kind: 'robot-square', x: 380, y: 510, angle: Math.PI / 2, hullExposed: true },
      { kind: 'robot-square', x: 400, y: 660, angle: Math.PI / 2, hullExposed: true },
    ],
  })
  .filterBy(['testId']);
// Phase 6 TiDi acceptance gate. 4000 entities (3200 asteroids + 800 active
// drones at the 0.8 ratio). Diagnostic captures show this only consumes
// ~1.5 ms/tick on a typical dev machine — well under the 14 ms TiDi
// threshold — so TiDi will NOT engage here in steady state. Use this room
// to verify gameplay/feel at scale; use `swarm-tidi-burn` to verify the
// TiDi pipeline end-to-end.
gameServer.define('swarm-tidi', SectorRoom, {
  swarmCount: 4000,
  swarmRatio: 0.8,
  swarmRadius: 32_000,
  maxClients: 4,
});
// Phase 6 synthetic-load room. 16 ms/tick of busy-wait CPU burn pushes the
// server's `update()` comfortably over the 14 ms threshold so TiDi engages
// reliably for the acceptance E2E. Caveat (per Phase 6 testing notes):
// burns ≥ 16 ms slow the server's wall-clock tick cadence below 60 Hz,
// which makes the client's wall-clock-anchored input loop race ahead and
// produce a high reconciler-correction rate. That's expected for the
// acceptance test (which only asserts TiDi/shedder mechanics, not feel).
// Real production TiDi is driven by physics-side overruns (worker step),
// where the server thread stays at 60 Hz and no clock skew occurs.
gameServer.define('swarm-tidi-burn', SectorRoom, {
  swarmCount: 500, // smaller swarm so the burn dominates the budget signal
  swarmRatio: 0.8,
  swarmRadius: 18_000,
  tickBurnMs: 16,
  maxClients: 4,
});
// Perf scenes (plan prancy-squishing-donut P1): one room per catalogue
// entry, `perf-<id>`. Played by `pnpm perf:scenes`.
for (const scene of PERF_SCENES) {
  gameServer
    .define(`perf-${scene.id}`, SectorRoom, {
      testMode: true,
      defaultSpawnX: scene.spawn.x,
      defaultSpawnY: scene.spawn.y,
      maxClients: 4,
      // Fault injection for the runner's self-test: burn N ms of every tick.
      tickBurnMs: Number(process.env['EQX_PERF_BURN_MS'] ?? 0),
      // Fixed work: no TiDi, no load shedding (they hide an overload).
      perfFixedLoad: true,
      ...scene.room,
    })
    .filterBy(['testId']);
}
} // end shouldRegisterTestRooms() gate (S6)

// A6 (S6): warn loudly if the dev-override bypass is armed in production. It's
// an E2E-only flag (bypasses testMode gating on JoinOptions); never set it in
// production. Semantics are unchanged — e2e:phone:stall depends on the flag.
if (process.env['EQX_ALLOW_DEV_OVERRIDES'] === '1' && process.env['NODE_ENV'] === 'production') {
  logger.warn('EQX_ALLOW_DEV_OVERRIDES=1 in production — dev override bypass is active (E2E-only flag)');
}

httpServer.on('upgrade', (req) => {
  logger.info({ url: req.url }, 'WS upgrade received');
});

async function main(): Promise<void> {
  // Install the V8 GC pause observer FIRST so any GCs triggered by
  // bootstrap (worker spawn, hydration, eager room creation) are
  // captured. The observer is process-wide; idempotent if called twice.
  installGcMonitor();

  const dbPath = process.env['DB_PATH'] ?? path.resolve(process.cwd(), 'eqx.db');
  await initWorker({ dbPath });
  logger.info({ dbPath }, 'persistence worker READY');

  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, () => {
      logger.info({ port: PORT }, 'EQX Peri server started');
      resolve();
    });
  });

  // Phase 2 multi-ship roster — same boot ordering. Reads the
  // `player_ships` rows and seeds the in-memory PlayerShipStore so any
  // galaxy room's onJoin can resolve a shipId without a race.
  const { hydrated: rosterHydrated } = initPlayerShipStore();
  logger.info({ hydrated: rosterHydrated }, 'Player-ship roster hydrated from disk');

  // Living World P1a — the unified hold table (ship cargo, loot pods, storage).
  // BEFORE the galaxy rooms: their hydrate respawns this sector's loot pods.
  const { hydrated: holdsHydrated } = initHoldStore();
  logger.info({ hydrated: holdsHydrated }, 'Holds hydrated from disk');

  // PR 3a — account-bound player identity. Hydrate the account→playerId
  // bindings + aliases and fold each account's historical per-browser ids
  // into one canonical playerId. AFTER the roster (re-keys rows), BEFORE the
  // galaxy rooms (they map persisted owners through the registry on hydrate).
  const identity = initAccountPlayerRegistry();
  logger.info(identity, 'Account-bound player identity hydrated + merged');

  // Economy v2 W1 — the virtual wallet (credits are never in holds). Hydrate
  // AFTER the identity merge (rows fold onto canonical ids), then move any
  // pre-wallet hold credits into their owners' wallets (one-time, idempotent).
  const { hydrated: walletsHydrated } = initWallet();
  const migrated = migrateLegacyHoldCredits();
  logger.info({ wallets: walletsHydrated, ...migrated }, 'Wallets hydrated (+ legacy hold credits migrated)');
  // Economy v2 W3 — the running Research Lab jobs (they hold their blueprints).
  logger.info(initLabBoard(), 'Research Lab jobs hydrated');

  // Phase 8 — eagerly instantiate each galaxy room so they hydrate from
  // snapshots at boot (not on first traveller) and so future transit
  // reservations always find a live destination. Sequential await: the
  // matchmaker doesn't love parallel `create` calls during boot.
  const galaxyRooms = new Map<string, SectorRoom>();
  // EQX_GALAXY_SECTORS (memory, 2026-11-07): which sectors boot eagerly. Unset
  // = all (normal play). A test or showcase server that only uses test rooms
  // boots none; a sector left out still starts on demand when someone joins.
  const bootSectors = galaxySectorsToBoot(GALAXY_SECTORS.map((s) => s.key));
  if (bootSectors.length !== GALAXY_SECTORS.length) logger.info({ sectors: bootSectors }, 'EQX_GALAXY_SECTORS: booting a subset of the galaxy');
  for (const sector of GALAXY_SECTORS) {
    if (!bootSectors.includes(sector.key)) continue;
    try {
      const listing = await matchMaker.createRoom(`galaxy-${sector.key}`, {});
      const room = matchMaker.getLocalRoomById(listing.roomId) as unknown as SectorRoom;
      galaxyRooms.set(sector.key, room);
      logger.info({ sectorKey: sector.key }, 'galaxy room created');
    } catch (err) {
      logger.error({ err, sectorKey: sector.key }, 'failed to eagerly create galaxy room');
    }
  }

  // Wave-system E2E — when EQX_E2E_WAVE=1, eager-create the player-owned
  // ready-base room and add it to the director's room map so the WaveDirector
  // polls it + sends a squad once the owner (`wave-tester`) joins. Boot-gated
  // so production never spins it up. Added AFTER the galaxy loop so no squad
  // homes here (squads home at sectorKeys[0..2]); the assigned squad warps IN
  // → fires the warp_warning banner the spec asserts on.
  if (process.env['EQX_E2E_WAVE'] === '1') {
    try {
      const listing = await matchMaker.createRoom('galaxy-wave-test', {});
      const room = matchMaker.getLocalRoomById(listing.roomId) as unknown as SectorRoom;
      galaxyRooms.set('galaxy-wave-test', room);
      logger.info('E2E wave-attack room created + director-managed (EQX_E2E_WAVE=1)');
    } catch (err) {
      logger.error({ err }, 'failed to create E2E wave-attack room');
    }
  }

  // Living World — start the population director over the live galaxy
  // rooms (production timings). Single process-global owner of the 25
  // hunter bots; unref'd control loop so it never keeps Node alive on
  // its own. Stopped in `shutdown()`. The EQX_DISABLE_LIVING_WORLD
  // kill-switch (ops/playtest) skips it entirely so building gameplay is
  // peaceful — ambient sector drones stay neutral. Re-arm by unsetting it.
  if (isLivingWorldDisabled()) {
    logger.warn(
      { sectors: galaxyRooms.size },
      'living world DISARMED — no hunter bots will spawn or hunt (EQX_DISABLE_LIVING_WORLD set); unset + restart to re-arm',
    );
  } else {
    // Drone-squad spool follows the production `SPOOL_DURATION_MS` (5 min)
    // unless `EQX_BOT_SPOOL_MS` injects a faster value (E2E convergence); the
    // per-hop inter-sector flight uses the `hopTravelMs` default unless
    // `EQX_BOT_HOP_MS` injects a faster value.
    const botSpoolMs = resolveBotSpoolMs();
    const botHopMs = resolveBotHopMs();
    const directorOpts: Partial<LivingWorldOptions> = {};
    if (botSpoolMs !== undefined) directorOpts.spoolMs = botSpoolMs;
    if (botHopMs !== undefined) directorOpts.hopTravelMs = botHopMs;
    // Phase 5 — director-state persistence ("restart from any state"): shadow the
    // abstract squad continuity on the CRITICAL lane (same model as Limbo/roster)
    // and hydrate it from the read-only main-thread connection inside start(). The
    // singleton director_state row's table is created by the worker's schema
    // bootstrap (initWorker, above); a first-boot SELECT miss is caught in
    // hydrate() → fresh seed.
    const directorPersistence = new DirectorPersistence({
      saveRow: (payload: DirectorStatePayload) => {
        persistence.enqueueCritical({
          type: 'DIRECTOR_STATE_PUT',
          payloadJson: JSON.stringify(payload),
          ts: Date.now(),
        });
      },
      // The wave E2E server (EQX_E2E_WAVE=1) starts the director fresh: a
      // restored squad already assigned to the test base, or the faction's
      // last dispatch time (5-min cadence), meant a run a minute after the
      // previous one drew no wave (2026-11-08).
      loadRow: () =>
        process.env['EQX_E2E_WAVE'] === '1'
          ? undefined
          : (db
              .prepare('SELECT payload_json, created_at FROM director_state WHERE id = 1')
              .get() as { payload_json: string; created_at: number } | undefined),
      logger,
    });
    // Living World P1b — the ROBOT side: a second director instance (mixed-tier
    // `rbot-` squads, roam-only, hostile on sight via the stance table). Its
    // own persistence row lives in `allegiance_director_state`.
    if (isRobotsDisabled()) {
      logger.warn('robot director DISARMED (EQX_DISABLE_ROBOTS set)');
    } else {
      const robotPersistence = new DirectorPersistence({
        saveRow: (payload: DirectorStatePayload) => {
          persistence.enqueueCritical({
            type: 'ALLEGIANCE_DIRECTOR_STATE_PUT',
            allegiance: 'robots',
            payloadJson: JSON.stringify(payload),
            ts: Date.now(),
          });
        },
        loadRow: () =>
          db
            .prepare("SELECT payload_json, created_at FROM allegiance_director_state WHERE allegiance = 'robots'")
            .get() as { payload_json: string; created_at: number } | undefined,
        logger,
      });
      robotDirector = new LivingWorldDirector(galaxyRooms, {
        ...directorOpts,
        ...ROBOT_DIRECTOR_OPTIONS,
        directorPersistence: robotPersistence,
      });
      robotDirector.start();
      // v4 T3 — teleporters carry robot bots across sectors.
      const rdMover = robotDirector;
      getTeleportBroker().addBotMover((id, from, to, x, y) => rdMover.teleportBot(id, from, to, x, y));
      // Living World P3 — robot territory + the nexus (reinforcements spawn at
      // it; robot-held sectors show on the galaxy map).
      const rd = robotDirector;
      const territory = new RobotTerritory(galaxyRooms, () => rd.activeBotCountsBySector());
      rd.setHooks({
        respawnAnchor: () => territory.respawnAnchor(),
        onTick: (now) => territory.tick(now),
      });
      territory.start();
      robotTerritory = territory;
      logger.info({ bots: ROBOT_BOT_COUNT, nexus: territory.nexusState() }, 'robot director started');
    }
    livingWorldDirector = new LivingWorldDirector(galaxyRooms, {
      ...directorOpts,
      directorPersistence,
      // Robots are enemies of every player on the galaxy map.
      hooks: {
        // Robots are hostile to every player on sight: the robot director's bots
        // AND an active incursion's raiders both show as enemies on the map.
        extraEnemyCounts: () => sumCounts(robotDirector?.activeBotCountsBySector() ?? EMPTY_COUNTS, eventDirector?.hostileCountsBySector() ?? EMPTY_COUNTS),
        // P3 — robot-held sectors show the robots as owner on the galaxy map.
        sectorOwner: (key) => robotTerritory?.sectorOwner(key) ?? null,
        // P4a — named elites: ticked on the drone director's control loop and
        // marked on the galaxy map.
        onTick: (now) => {
          eliteDirector?.tick(now);
          flagshipDirector?.tick(now);
          eventDirector?.tick(now);
        },
        sectorElite: (key) => eliteDirector?.sectorElite(key) ?? null,
        // W2a — flagship fleets show as capital sightings on the galaxy map.
        sectorCapital: (key) => flagshipDirector?.sectorCapital(key) ?? null,
        // P4b — world events show on the galaxy map.
        sectorEvent: (key) => eventDirector?.sectorEvent(key) ?? null,
      },
    });
    // W2a — flagship fleets: capital ships + escorts roaming pocket to pocket
    // (solar-system sectors). Persisted in allegiance_director_state ('flagships').
    if (process.env['EQX_DISABLE_FLAGSHIPS'] === '1' || process.env['EQX_DISABLE_FLAGSHIPS'] === 'true') {
      logger.warn('flagship fleets DISARMED (EQX_DISABLE_FLAGSHIPS set)');
    } else {
      let restore: FlagshipStatePayload | null = null;
      try {
        const row = db
          .prepare("SELECT payload_json, created_at FROM allegiance_director_state WHERE allegiance = 'flagships'")
          .get() as { payload_json: string; created_at: number } | undefined;
        if (row && Date.now() - row.created_at < 24 * 60 * 60 * 1000) restore = JSON.parse(row.payload_json) as FlagshipStatePayload;
      } catch (err) {
        logger.warn({ err }, 'flagship state unreadable — fresh fleets');
      }
      flagshipDirector = new FlagshipDirector(galaxyRooms, {
        restore,
        save: (payload) => persistence.enqueueCritical({
          type: 'ALLEGIANCE_DIRECTOR_STATE_PUT', allegiance: 'flagships', payloadJson: JSON.stringify(payload), ts: Date.now(),
        }),
      });
      flagshipDirector.start();
    }
    eliteDirector = new EliteDirector(galaxyRooms);
    eliteDirector.start();
    eventDirector = new EventDirector(galaxyRooms);
    eventDirector.start();
    // P4c — the Contracts board reads the live elites + event.
    const ed = eliteDirector;
    const evd = eventDirector;
    // P4c-2 — player bounties: paid from the wallet, the board persisted as
    // one economy-state record (economy v2 W1).
    const bounties = new BountyBoard(getWallet(), getPersistence, {
      maxShipLevel: (pid) => getPlayerShipStore().listByPlayer(pid).reduce((m, r) => Math.max(m, r.level), 0),
      nameOf: (pid) => {
        const uid = getPlayerShipStore().listByPlayer(pid).find((r) => r.userId !== null)?.userId ?? null;
        const u = uid ? getUser(uid) : null;
        return u ? (u.displayName ?? null) : null;
      },
      lastSectorOf: (pid) => getPlayerShipStore().listByPlayer(pid)[0]?.lastSectorKey ?? null,
    });
    const bountyRow = db
      .prepare("SELECT payload_json FROM economy_state WHERE key = 'bounties'")
      .get() as { payload_json: string } | undefined;
    bounties.hydrate(bountyRow?.payload_json);
    setBountyBoard(bounties);
    setContractsProvider({ elites: () => ed.elites(), activeEvent: () => evd.activeEvent(), bounties: () => bounties.open() });
    livingWorldDirector.start();
    // v4 T3 — teleporters carry drone bots across sectors.
    const lwMover = livingWorldDirector;
    getTeleportBroker().addBotMover((id, from, to, x, y) => lwMover.teleportBot(id, from, to, x, y));
    // Phase-4 P0 — let the per-room TransitOrchestrator + destination rooms feed
    // inbound PLAYERS into the director's IncomingRegistry (the "incoming" banner)
    // without an import cycle. Null when the Living World is disabled.
    setIncomingPlayerSink(livingWorldDirector);
    // Phase-3 — serve live per-sector counts at GET /galaxy/snapshot from the
    // director's control-tick cache (null when the Living World is disabled).
    setGalaxyStatsProvider(livingWorldDirector);
    logger.info(
      {
        sectors: galaxyRooms.size,
        bots: LIVING_WORLD_BOT_COUNT,
        botSpoolMs: botSpoolMs ?? 'default',
        botHopMs: botHopMs ?? 'default',
      },
      'living world director started',
    );
  }

  // Living World P2 — the economy: market, reputation, trade deals carried by
  // physical haulers. Independent of the squad directors (trade still runs when
  // the Living World kill switch is set). Hydrate BEFORE start(): the director's
  // boot reconcile unwinds any run that was in flight when the server stopped.
  economyStore = new EconomyStore({ persistence: getPersistence });
  const econ = hydrateEconomyStore(economyStore, (sql) => db.prepare(sql).all());
  tradeDirector = new TradeDirector(galaxyRooms, economyStore, getHoldStore(), {
    push: (pid, title, body, tag) => pushNotifier.notifyTrade(pid, title, body, tag),
    wallet: getWallet(),
  });
  tradeDirector.start();
  setTradeSink(tradeDirector);
  // T2 (plan soft-leaping-truffle v3) — convoys between the galaxy's NPC bases.
  if (!isConvoysDisabled() && !isNpcBasesDisabled()) {
    const convoyRooms = new Map<string, SectorRoom>();
    for (const [key, room] of galaxyRooms) if (getSector(key)) convoyRooms.set(key, room);
    convoyDirector = new ConvoyDirector(convoyRooms, getHoldStore(), undefined, undefined, { wallet: getWallet(), sink: getTradeSink });
    convoyDirector.start();
  }
  const store = economyStore;
  const director = tradeDirector;
  setEconomyRouteProvider({
    offersFor: (pid, sector) => director.offersFor(pid, sector),
    view: (pid) => store.view(pid),
    factions: (pid) => store.factionsView(pid, (other) => {
      const uid = getPlayerShipStore().listByPlayer(other).find((r) => r.userId !== null)?.userId ?? null;
      const u = uid ? getUser(uid) : null;
      return u?.displayName ?? u?.email ?? 'A pilot';
    }),
  });
  logger.info(econ, 'trade director started');

  // All boot work is done — joining a galaxy room will now succeed.
  // Flip the /healthz `ready` flag so the client landing screen enables
  // the Join CTA.
  serverReady = true;
  logger.info('server ready — /healthz now reports ready:true');
}

/**
 * Drain the persistence worker, then shut down Colyseus, then exit.
 *
 * Production (Linux/Fly.io) drives this via SIGTERM. Windows dev drives it
 * via the dev-only POST /dev/shutdown endpoint below — Windows + tsx + pnpm
 * delivers Ctrl+C as a process-group event that tears down the JS process
 * before any handler can complete (see docs/LESSONS.md).
 */
const shutdown = async (sig: string, exitCode = 0): Promise<void> => {
  logger.info({ sig }, 'shutdown received, draining persistence');
  const forceExit = setTimeout(() => {
    logger.error('shutdown hard deadline reached, force-exiting');
    process.exit(2);
  }, 10_000);
  forceExit.unref();

  // Living World — stop the control loop, abandon in-flight bot
  // transits, unsubscribe the bus listeners. (The loop is unref'd, but
  // an explicit stop keeps a graceful shutdown clean and deterministic.)
  try {
    setIncomingPlayerSink(null);
    setGalaxyStatsProvider(null);
    // Phase 5 — flush the director's abstract squad continuity onto the CRITICAL
    // lane BEFORE the persistence drain below, so a restart resumes where we left
    // off (the throttled in-loop persist only bounds loss on an unclean kill).
    livingWorldDirector?.persistState();
    livingWorldDirector?.stop();
    robotDirector?.persistState();
    robotDirector?.stop();
    robotTerritory?.stop();
    eliteDirector?.stop();
    flagshipDirector?.persist();
    flagshipDirector?.stop();
    eventDirector?.stop();
    setContractsProvider(null);
    setBountyBoard(null);
    setTradeSink(null);
    setEconomyRouteProvider(null);
    tradeDirector?.stop();
    convoyDirector?.stop();
    economyStore?.saveMarket();
  } catch (err) {
    logger.warn({ err }, 'livingWorldDirector.persistState/stop threw');
  }

  // Drain the audit log's worker-thread file buffer before exit so the
  // tail of the durable NDJSON is not lost on a graceful shutdown.
  try {
    await flushAudit();
  } catch (err) {
    logger.warn({ err }, 'audit log flush threw');
  }

  try {
    const { drained } = await persistence.shutdown({ timeoutMs: 8000 });
    logger.info({ drained }, 'persistence worker drained');
  } catch (err) {
    logger.error({ err }, 'persistence shutdown timed out');
  }
  try {
    await gameServer.gracefullyShutdown();
  } catch (err) {
    logger.error({ err }, 'colyseus graceful shutdown failed');
  }
  process.exit(exitCode);
};

let shuttingDown = false;
const onSignal = (sig: string): void => {
  if (shuttingDown) {
    process.exit(130);
  }
  shuttingDown = true;
  void shutdown(sig);
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

// R1: catch otherwise-unhandled fatals, drain, and exit non-zero so the
// supervisor restarts a clean instance (never log-and-continue an authority).
installProcessGuards({
  logger,
  onFatal: (_err, source) => {
    if (shuttingDown) { process.exit(1); }
    shuttingDown = true;
    void shutdown(source, 1);
  },
});

if (process.env['NODE_ENV'] !== 'production') {
  // Dev-only deterministic drain trigger — POST /dev/shutdown drains
  // persistence + colyseus + exits cleanly. Used on Windows where Ctrl+C
  // is unreliable through the pnpm/tsx wrapper chain.
  app.post('/dev/shutdown', (_req, res) => {
    res.json({ ok: true, draining: true });
    setTimeout(() => onSignal('HTTP_SHUTDOWN'), 50);
  });
}

main().catch((err: unknown) => {
  logger.error({ err }, 'server boot failed');
  process.exit(1);
});
