import 'dotenv/config';
import { definePerfRooms } from './rooms/perfRooms.js';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { createServer } from 'node:http';
import { pino } from 'pino';
import { SectorRoom } from './rooms/SectorRoom.js';
import { SHOWCASE_ROOMS } from './rooms/showcaseRooms.js';
import { defineEngineeringRooms } from './rooms/testRooms/engineeringRooms.js';
import { defineScenarioRooms } from './rooms/testRooms/scenarioRooms.js';
import { defineWorldRooms } from './rooms/testRooms/worldRooms.js';
import { installGcMonitor } from './debug/GcMonitor.js';
import { authRouter } from './routes/authRouter.js';
import { createDevRouter } from './routes/devRouter.js';
import { galaxyRouter } from './routes/galaxyRouter.js';
import { economyRouter, setEconomyRouteProvider } from './routes/economyRouter.js';
import { setTradeSink } from './economy/tradeSink.js';
import { pushRouter } from './routes/pushRouter.js';
import { flushAudit } from './audit/GameplayAuditLog.js';
import { persistence, getPersistenceHealth } from './db/PersistenceWorker.js';
import { GALAXY_SECTORS } from '../core/galaxy/galaxy.js';
import { resolveSectorConfig } from './galaxy/GalaxyRegistry.js';
import { setIncomingPlayerSink } from './livingworld/incomingPlayerSink.js';
import { setGalaxyStatsProvider } from './livingworld/galaxyStatsProvider.js';
import { setContractsProvider } from './livingworld/contractsProvider.js';
import { setBountyBoard } from './economy/BountyBoard.js';
import { resolveCorsPolicy, corsMiddleware, securityHeadersMiddleware } from './net/httpCors.js';
import { shouldRegisterTestRooms } from './rooms/testRoomGating.js';
import { installProcessGuards } from './orchestration/processGuards.js';
import { startPersistenceWorker, listenHttp, hydratePlayerStores } from './boot/persistenceBoot.js';
import { createGalaxyRooms } from './boot/galaxyRoomsBoot.js';
import { startLivingWorld } from './boot/livingWorldBoot.js';
import { startEconomy } from './boot/economyBoot.js';
import { createWorldHandles } from './boot/worldHandles.js';

const logger = pino({
  name: 'server',
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

const PORT = Number(process.env['PORT'] ?? 2567);

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
/** The Living World + economy directors; filled by the boot steps in `main()`. */
const world = createWorldHandles();
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
 * the old client splash screen and ran on the client's clock — moved here so
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
  app.use(createDevRouter({
    convoyDirector: () => world.convoyDirector,
    livingWorldDirector: () => world.livingWorldDirector,
    robotDirector: () => world.robotDirector,
    eventDirector: () => world.eventDirector,
  }));
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
// Per-feature room modules in rooms/testRooms/ (a new test room is a row there).
defineEngineeringRooms(gameServer);
// Showcase capture rooms — staged scenes for the repeatable showcase video
// (docs/architecture/showcase-pipeline.md). Options live in
// rooms/showcaseRooms.ts so the integration test boots exactly these.
for (const [name, opts] of Object.entries(SHOWCASE_ROOMS)) {
  gameServer.define(name, SectorRoom, opts).filterBy(['testId']);
}
defineScenarioRooms(gameServer);
defineWorldRooms(gameServer);
// Perf scenes: one `perf-<id>` room per catalogue entry.
definePerfRooms(gameServer, SectorRoom);
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

  // Ordered boot steps (src/server/boot/). Order is load-bearing: see each step.
  await startPersistenceWorker({ logger });
  await listenHttp({ logger, httpServer, port: PORT });
  hydratePlayerStores({ logger });
  const galaxyRooms = await createGalaxyRooms({ logger });
  // Living World — start the population director over the live galaxy
  // rooms (production timings). Single process-global owner of the 25
  // hunter bots; unref'd control loop so it never keeps Node alive on
  // its own. Stopped in `shutdown()`. The EQX_DISABLE_LIVING_WORLD
  // kill-switch (ops/playtest) skips it entirely so building gameplay is
  // peaceful — ambient sector drones stay neutral. Re-arm by unsetting it.
  startLivingWorld({ logger, galaxyRooms, world });
  startEconomy({ logger, galaxyRooms, world });

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
    world.livingWorldDirector?.persistState();
    world.livingWorldDirector?.stop();
    world.robotDirector?.persistState();
    world.robotDirector?.stop();
    world.robotTerritory?.stop();
    world.eliteDirector?.stop();
    world.flagshipDirector?.persist();
    world.flagshipDirector?.stop();
    world.eventDirector?.stop();
    setContractsProvider(null);
    setBountyBoard(null);
    setTradeSink(null);
    setEconomyRouteProvider(null);
    world.tradeDirector?.stop();
    world.convoyDirector?.stop();
    world.economyStore?.saveMarket();
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
