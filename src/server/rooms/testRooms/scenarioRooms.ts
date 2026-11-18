/**
 * Engineering + E2E test rooms (part 2 of 3): radar sandbox, structure scale,
 * NPC bases, the wave test and the collision probes. Moved out of `index.ts`
 * (god-file split); registered only behind `shouldRegisterTestRooms()`.
 */
import type { Server } from 'colyseus';
import { SectorRoom } from '../SectorRoom.js';
import { SCENARIO, STRUCTURE_SCENARIO_PREBUILT } from '../scenarioLayouts.js';

/** Registers this group's rooms. Called from `index.ts` inside the
 *  `shouldRegisterTestRooms()` gate; `define` order is the order here. */
export function defineScenarioRooms(gameServer: Server): void {
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
}
