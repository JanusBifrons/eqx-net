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
import { diagRouter, devStatsHandler, devLimboHandler, devPlayerShipsHandler, devPlayerShipsAbandonHandler, devResetSectorHandler, devResetRosterHandler, devWebrtcCountersHandler } from './routes/diagRouter.js';
import { galaxyRouter } from './routes/galaxyRouter.js';
import { initWorker, persistence, initLimboStore, getLimboStore, initPlayerShipStore, getPersistenceHealth } from './db/PersistenceWorker.js';
import { GALAXY_SECTORS } from '../core/galaxy/galaxy.js';
import { resolveSectorConfig } from './galaxy/GalaxyRegistry.js';
import { LivingWorldDirector, LIVING_WORLD_BOT_COUNT, isLivingWorldDisabled, resolveBotSpoolMs, resolveBotHopMs, type LivingWorldOptions } from './livingworld/LivingWorldDirector.js';
import { setIncomingPlayerSink } from './livingworld/incomingPlayerSink.js';
import { resolveCorsPolicy, corsMiddleware, securityHeadersMiddleware } from './net/httpCors.js';
import { shouldRegisterTestRooms } from './rooms/testRoomGating.js';
import { installProcessGuards } from './orchestration/processGuards.js';

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

  // GET /dev/webrtc-counters?roomId=<colyseus-roomId> — Phase 4 iteration 3
  // swift-otter diagnostic. Returns the room's per-session WebRTC counters
  // (sentViaDc / sentViaWs / degraded / dcThrows / etc) so the Phase 4
  // E2E can localise DC throughput variance.
  app.get('/dev/webrtc-counters', (req, res) => {
    void devWebrtcCountersHandler(req, res);
  });

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
    prebuiltStructures: [
      { kind: 'capital', x: 0, y: 0 },
      // WS-5 (R2.10): leaves can no longer attach DIRECTLY to the Capital
      // (capital-only-connectors). Two Connector relays, offset to clear the
      // Capital's line-of-sight, carry the grid — NE relay → the +x/+y solars,
      // SW relay → the −x miner + −y turret. Capital uses 2 of its 4 slots.
      { kind: 'connector', x: 150, y: 60 },
      { kind: 'connector', x: -100, y: -100 },
      { kind: 'solar', x: 250, y: 0 },
      { kind: 'solar', x: 0, y: 250 },
      { kind: 'miner', x: -350, y: 0 },
      { kind: 'turret', x: 0, y: -350 },
    ],
    scenarioAsteroids: [{ x: -700, y: 0, radius: 30 }],
    scenarioDrones: [{ x: 0, y: -550 }],
    defaultSpawnX: 600,
    defaultSpawnY: 600,
    maxClients: 4,
  })
  .filterBy(['testId']);
// Wave-system E2E (tests/e2e/wave-attack.spec.ts) — a DIRECTOR-MANAGED galaxy
// room (real sectorKey) seeded with a PRE-BUILT, player-owned READY base
// (Capital + Miner + Solar + Turret, owner `wave-tester`). Single eager
// instance (NO filterBy) so the LivingWorldDirector can hold a reference (it's
// added to the director's room map at boot when `EQX_E2E_WAVE=1`). The base is
// ready at boot but the owner-presence gate holds the wave until the test
// client joins AS `wave-tester` — killing the pre-join race. Asteroids + a
// parked drone give the seeded turret + miner something to do. droneCount 0 so
// the only drones that appear are the incoming wave squad.
gameServer.define('galaxy-wave-test', SectorRoom, {
  sectorKey: 'galaxy-wave-test',
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  peacefulDrones: true,
  structureGridPulseMs: 100,
  prebuiltStructures: [
    { kind: 'capital', x: 0, y: 0 },
    // WS-5 (R2.10): capital-only-connectors — two offset Connector relays carry
    // the grid (NE → solars, SW → miner + turret) since leaves can't attach to
    // the Capital directly. Keeps this base READY (powered) for the wave gate.
    { kind: 'connector', x: 150, y: 60 },
    { kind: 'connector', x: -100, y: -100 },
    { kind: 'solar', x: 250, y: 0 },
    { kind: 'solar', x: 0, y: 250 },
    { kind: 'miner', x: -350, y: 0 },
    { kind: 'turret', x: 0, y: -350 },
  ],
  // Fixed sentinel UUID (the server rejects non-UUID playerIds). The wave spec
  // joins AS this id so the seeded base is owned by the present player and the
  // owner-presence gate releases the wave. Kept in sync with
  // tests/e2e/wave-attack.spec.ts WAVE_OWNER_ID.
  prebuiltStructuresOwner: 'face0000-0000-4000-8000-000000000001',
  scenarioAsteroids: [{ x: -700, y: 0, radius: 30 }],
  defaultSpawnX: 0,
  defaultSpawnY: 600,
  maxClients: 4,
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
// lingering-hull / wreck / ship-pool E2E suite (tests/e2e/linger/).
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
    livingWorldDirector = new LivingWorldDirector(galaxyRooms, directorOpts);
    livingWorldDirector.start();
    // Phase-4 P0 — let the per-room TransitOrchestrator + destination rooms feed
    // inbound PLAYERS into the director's IncomingRegistry (the "incoming" banner)
    // without an import cycle. Null when the Living World is disabled.
    setIncomingPlayerSink(livingWorldDirector);
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
    setIncomingPlayerSink(null);
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
