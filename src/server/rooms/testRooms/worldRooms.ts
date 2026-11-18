/**
 * Engineering + E2E test rooms (part 3 of 3): combat target, linger, Living
 * World, trade, break-in, teleport and TiDi rooms. Moved out of `index.ts`
 * (god-file split); registered only behind `shouldRegisterTestRooms()`.
 */
import type { Server } from 'colyseus';
import { SectorRoom } from '../SectorRoom.js';

/** v4 T1 — the owner the teleport-test room's base belongs to (the E2E joins
 *  as this id). Kept in sync with tests/e2e/teleporter.spec.ts. */
const TELEPORT_TEST_OWNER = 'face0000-0000-4000-8000-000000000002';

/** Registers this group's rooms. Called from `index.ts` inside the
 *  `shouldRegisterTestRooms()` gate; `define` order is the order here. */
export function defineWorldRooms(gameServer: Server): void {
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
  // per-test room isolation, so the room must not persist: every instance
  // shares the one `galaxy-test` sector snapshot, and a new test's room
  // restored the parked hulls (lingeringHulls[]) other tests left behind, an
  // extra stranger's ship in its contacts list (contacts-overview.spec.ts,
  // 2026-11-14). Same rule as `galaxy-wave-test` / the trade test room.
  gameServer
    .define('galaxy-test', SectorRoom, {
      sectorKey: 'galaxy-test',
      testMode: true,
      droneCount: 0,
      asteroidConfig: [],
      maxClients: 8,
      persistSector: false,
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
}
