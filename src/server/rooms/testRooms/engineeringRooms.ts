/**
 * Engineering + E2E test rooms (part 1 of 3): the base test sectors, combat,
 * collision, structure and gate rooms. Moved out of `index.ts` (god-file split);
 * registered only behind `shouldRegisterTestRooms()` (plan squishy-canyon, S6).
 */
import type { Server } from 'colyseus';
import { SectorRoom } from '../SectorRoom.js';
import { GATE_TEST_PREBUILT, SCENARIO, STRUCTURE_SCENARIO_PREBUILT } from '../scenarioLayouts.js';

/** Registers this group's rooms. Called from `index.ts` inside the
 *  `shouldRegisterTestRooms()` gate; `define` order is the order here. */
export function defineEngineeringRooms(gameServer: Server): void {
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
  // Capital destruction S2b — a peaceful battleship 2.5 km north of the spawn,
  // with capital wrecks on. A spec sends `test_kill_capitals` and checks the
  // client draws the wreck pieces. filterBy(testId) isolates parallel specs.
  gameServer
    .define('wreck-test', SectorRoom, {
      testMode: true,
      asteroidConfig: [],
      peacefulDrones: true,
      capitalWrecks: true, // a capital pilot may cut up the wreck
      dronePoses: [{ kind: 'battleship', x: 0, y: 2500, angle: 0 }],
      defaultSpawnX: 0,
      defaultSpawnY: -1500,
      maxClients: 4,
    })
    .filterBy(['testId']);
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
  // Cut field `?room=cut-field-test`: 700 u off a rock (vertex -30120, 26501), facing it at `?initialAngle=2.972` (cut-field-collision.spec).
  gameServer.define('cut-field-test', SectorRoom, {
    testMode: true, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0,
    defaultSpawnX: -30_002, defaultSpawnY: 27_191, maxClients: 4,
  }).filterBy(['testId']);
  // Wreck field `?room=wreck-field-test` (wreck fields 3b): an old battlefield streamed in by chunk around the spawn, inside the 'look' rock field.
  gameServer.define('wreck-field-test', SectorRoom, {
    testMode: true, cutField: { seed: 'look' }, wreckField: { seed: 'look', x: 60_000, y: 0, sides: ['ashen-league', 'vel-concord'] },
    asteroidConfig: [], droneCount: 0, defaultSpawnX: 60_000, defaultSpawnY: 0, maxClients: 4,
  }).filterBy(['testId']);
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
}
