import 'dotenv/config';
import { definePerfRooms } from './rooms/perfRooms.js';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import path from 'node:path';
import { createServer } from 'node:http';
import { pino } from 'pino';
import { SectorRoom } from './rooms/SectorRoom.js';
import { galaxySectorsToBoot } from './rooms/galaxyBoot.js';
import { SHOWCASE_ROOMS } from './rooms/showcaseRooms.js';
import { defineEngineeringRooms } from './rooms/testRooms/engineeringRooms.js';
import { defineScenarioRooms } from './rooms/testRooms/scenarioRooms.js';
import { defineWorldRooms } from './rooms/testRooms/worldRooms.js';
import { installGcMonitor } from './debug/GcMonitor.js';
import { authRouter } from './routes/authRouter.js';
import { createDevRouter } from './routes/devRouter.js';
import { galaxyRouter } from './routes/galaxyRouter.js';
import { economyRouter, setEconomyRouteProvider } from './routes/economyRouter.js';
import { EconomyStore, hydrateEconomyStore } from './economy/EconomyStore.js';
import { TradeDirector } from './economy/TradeDirector.js';
import { getTradeSink, setTradeSink } from './economy/tradeSink.js';
import { pushNotifier } from './push/PushNotifier.js';
import { pushRouter } from './routes/pushRouter.js';
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
import { DirectorPersistence, type DirectorStatePayload } from './livingworld/DirectorPersistence.js';
import { db } from './db/Database.js';
import { resolveCorsPolicy, corsMiddleware, securityHeadersMiddleware } from './net/httpCors.js';
import { shouldRegisterTestRooms } from './rooms/testRoomGating.js';
import { installProcessGuards } from './orchestration/processGuards.js';
import { getTeleportBroker } from './teleport/TeleportBroker.js';

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
    convoyDirector: () => convoyDirector,
    livingWorldDirector: () => livingWorldDirector,
    robotDirector: () => robotDirector,
    eventDirector: () => eventDirector,
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
      // Living World P3 — robot territory + nexus + every side's sector control.
      // Built first so its meter rides the director's state row (restored in start()).
      const territory = new RobotTerritory(galaxyRooms, () => robotDirector?.activeBotCountsBySector() ?? EMPTY_COUNTS);
      robotDirector = new LivingWorldDirector(galaxyRooms, {
        ...directorOpts,
        ...ROBOT_DIRECTOR_OPTIONS,
        directorPersistence: robotPersistence,
        hooks: {
          respawnAnchor: () => territory.respawnAnchor(),
          onTick: (now) => territory.tick(now),
          saveSectorControl: () => territory.saveControl(),
          restoreSectorControl: (entries) => territory.restoreControl(entries),
        },
      });
      robotDirector.start();
      // v4 T3 — teleporters carry robot bots across sectors.
      const rdMover = robotDirector;
      getTeleportBroker().addBotMover((id, from, to, x, y) => rdMover.teleportBot(id, from, to, x, y));
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
        // The control meter's holder for every side (null = neutral).
        sectorOwner: (key) => (robotTerritory ? robotTerritory.sectorOwner(key) : undefined),
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
