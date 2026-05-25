import 'dotenv/config';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import path from 'node:path';
import { createServer } from 'node:http';
import { pino } from 'pino';
import { SectorRoom } from './rooms/SectorRoom.js';
import { getRecentEvents, clearEvents } from './debug/ServerEventLog.js';
import { installGcMonitor } from './debug/GcMonitor.js';
import { authRouter } from './routes/authRouter.js';
import { diagRouter, devStatsHandler, devLimboHandler, devPlayerShipsHandler, devPlayerShipsAbandonHandler, devResetSectorHandler, devResetRosterHandler } from './routes/diagRouter.js';
import { galaxyRouter } from './routes/galaxyRouter.js';
import { initWorker, persistence, initLimboStore, getLimboStore, initPlayerShipStore } from './db/PersistenceWorker.js';
import { GALAXY_SECTORS } from '../core/galaxy/galaxy.js';
import { resolveSectorConfig } from './galaxy/GalaxyRegistry.js';
import { LivingWorldDirector, LIVING_WORLD_BOT_COUNT } from './livingworld/LivingWorldDirector.js';

const logger = pino({
  name: 'server',
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

const PORT = Number(process.env['PORT'] ?? 2567);
const MAX_DEV_EVENTS = 500;

const app = express();

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  next();
});

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
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    ready: serverReady,
    tick: Date.now(),
    playersOnline: fakePlayerCount(),
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

  // GET /dev/events?limit=N — recent server events (snapshots, joins, leaves).
  app.get('/dev/events', (req, res) => {
    const limit = Math.min(Number(req.query['limit'] ?? 200), MAX_DEV_EVENTS);
    res.json({ events: getRecentEvents(limit) });
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

  // GET /dev/population — Living World director snapshot (per-sector
  // players/bots, totals, in-transit/respawning) for E2E + diagnostics.
  // Read-only; mirrors /dev/limbo's inspection-only shape.
  app.get('/dev/population', (_req, res) => {
    res.json(livingWorldDirector ? livingWorldDirector.snapshot() : { ready: false });
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

  // Phase 8 sub-phase B — hydrate the LimboStore from on-disk rows that
  // survived the last shutdown, then start the prune timer. Done before
  // the eager-create loop so any galaxy room's onJoin can `take` a fresh
  // hydrated entry without a race.
  const { hydrated } = initLimboStore();
  logger.info({ hydrated }, 'Limbo hydrated from disk');

  // Phase 2 multi-ship roster — same boot ordering. Reads the
  // `player_ships` rows and seeds the in-memory PlayerShipStore so any
  // galaxy room's onJoin can resolve a shipId without a race.
  const { hydrated: rosterHydrated } = initPlayerShipStore();
  logger.info({ hydrated: rosterHydrated }, 'Player-ship roster hydrated from disk');

  // Phase 8 — eagerly instantiate each galaxy room so they hydrate from
  // snapshots at boot (not on first traveller) and so future transit
  // reservations always find a live destination. Sequential await: the
  // matchmaker doesn't love parallel `create` calls during boot.
  const galaxyRooms = new Map<string, SectorRoom>();
  for (const sector of GALAXY_SECTORS) {
    try {
      const listing = await matchMaker.createRoom(`galaxy-${sector.key}`, {});
      const room = matchMaker.getLocalRoomById(listing.roomId) as unknown as SectorRoom;
      galaxyRooms.set(sector.key, room);
      logger.info({ sectorKey: sector.key }, 'galaxy room created');
    } catch (err) {
      logger.error({ err, sectorKey: sector.key }, 'failed to eagerly create galaxy room');
    }
  }

  // Living World — start the population director over the live galaxy
  // rooms (production timings). Single process-global owner of the 25
  // hunter bots; unref'd control loop so it never keeps Node alive on
  // its own. Stopped in `shutdown()`.
  livingWorldDirector = new LivingWorldDirector(galaxyRooms);
  livingWorldDirector.start();
  logger.info(
    { sectors: galaxyRooms.size, bots: LIVING_WORLD_BOT_COUNT },
    'living world director started',
  );

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
const shutdown = async (sig: string): Promise<void> => {
  logger.info({ sig }, 'shutdown received, draining persistence');
  const forceExit = setTimeout(() => {
    logger.error('shutdown hard deadline reached, force-exiting');
    process.exit(2);
  }, 10_000);
  forceExit.unref();

  // Phase 8 sub-phase B — stop the Limbo prune timer first so it doesn't
  // race the persistence drain. The persistence shadow already mirrored
  // every Limbo mutation through CRITICAL, so the existing drain handles
  // them; nothing else to flush.
  try {
    getLimboStore().stopPruneTimer();
  } catch (err) {
    logger.warn({ err }, 'limboStore.stopPruneTimer threw');
  }

  // Living World — stop the control loop, abandon in-flight bot
  // transits, unsubscribe the bus listeners. (The loop is unref'd, but
  // an explicit stop keeps a graceful shutdown clean and deterministic.)
  try {
    livingWorldDirector?.stop();
  } catch (err) {
    logger.warn({ err }, 'livingWorldDirector.stop threw');
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
  process.exit(0);
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
