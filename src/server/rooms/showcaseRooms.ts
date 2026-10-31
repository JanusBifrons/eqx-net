/**
 * Showcase capture rooms (docs/architecture/showcase-pipeline.md).
 *
 * Staged scenes for the repeatable showcase video. Each exists because no
 * existing engineering room stages that scene. Registered in `index.ts` inside
 * the test-room gate (S6) with `filterBy(['testId'])`; exported here so the
 * integration test boots EXACTLY the options the server registers.
 */

/**
 * The pilot identity base shots join as (anonymous join, seeded `eqxPlayerId`).
 * Owning the prebuilt base makes it "yours": the build preview draws green
 * links to it (cross-owner hubs are skipped by design) and the inspector reads
 * "you" instead of "Unknown". A valid UUID — the client rejects anything else.
 */
export const SHOWCASE_PILOT_ID = '5ca5e000-0000-4000-8000-000000000001';

/** The six player ship kinds parked peacefully in a line-up. */
export const SHOWCASE_SHIP_GALLERY_OPTS = {
  testMode: true,
  asteroidConfig: [],
  peacefulDrones: true,
  dronePoses: [
    { kind: 'scout', x: -750, y: 350, angle: 0 },
    { kind: 'fighter', x: -450, y: 350, angle: 0 },
    { kind: 'interceptor', x: -150, y: 350, angle: 0 },
    { kind: 'heavy', x: 150, y: 350, angle: 0 },
    { kind: 'gunship', x: 450, y: 350, angle: 0 },
    { kind: 'missile-frigate', x: 750, y: 350, angle: 0 },
  ],
  defaultSpawnX: 0,
  defaultSpawnY: -150,
  maxClients: 4,
} as const;

/**
 * A powered base with a shield-pylon WALL, battery, bolt + missile turrets and
 * a drone pack beyond the wall (join with `startHostile=1`). The spawn sits
 * BEHIND the wall, so drone fire lands on the wall. Layout honours the grid
 * rules: the Capital links only to Connectors (300 u range, ≤ 4 links) and
 * leaves sit on distinct lines of sight.
 */
export const SHOWCASE_DEFENCE_OPTS = {
  testMode: true,
  asteroidConfig: [],
  structureGridPulseMs: 100,
  prebuiltStructuresOwner: SHOWCASE_PILOT_ID,
  prebuiltStructures: [
    { kind: 'capital', x: 0, y: 0 },
    { kind: 'connector', x: 140, y: -140 },
    { kind: 'connector', x: -140, y: -140 },
    { kind: 'connector', x: 0, y: 190 },
    { kind: 'solar', x: 310, y: 40 },
    { kind: 'solar', x: -310, y: 40 },
    { kind: 'solar', x: -210, y: 330 },
    { kind: 'battery', x: 210, y: 330 },
    { kind: 'shield_pylon', x: -270, y: -400 },
    { kind: 'shield_pylon', x: 270, y: -400 },
    { kind: 'laser_bolt_turret', x: -110, y: -290 },
    { kind: 'missile_turret', x: 110, y: -290 },
  ],
  dronePoses: [
    { kind: 'fighter', x: -350, y: -1000, angle: Math.PI },
    { kind: 'gunship', x: 0, y: -1100, angle: Math.PI },
    { kind: 'interceptor', x: 350, y: -1000, angle: Math.PI },
    { kind: 'fighter', x: -150, y: -1250, angle: Math.PI },
    { kind: 'scout', x: 150, y: -1250, angle: Math.PI },
  ],
  defaultSpawnX: 0,
  defaultSpawnY: -230,
  maxClients: 4,
} as const;

/**
 * A small powered base OWNED by the showcase pilot: Capital, two connector
 * relays, two solars, a miner on an asteroid and a turret facing a parked
 * drone (the `structure-scenario-test` layout). Room to the north-east for the
 * build shot to place into.
 */
export const SHOWCASE_BASE_OPTS = {
  testMode: true,
  asteroidConfig: [],
  peacefulDrones: true,
  structureGridPulseMs: 250,
  prebuiltStructuresOwner: SHOWCASE_PILOT_ID,
  prebuiltStructures: [
    { kind: 'capital', x: 0, y: 0 },
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
} as const;

/**
 * Roster-backed (real sectorKey, NOT in the galaxy graph, so the director never
 * routes bots here) with one hull-exposed target. Join with `initialXp` just
 * under the threshold + `startHostile=1`: one kill levels the ship up.
 */
export const SHOWCASE_LEVELUP_OPTS = {
  sectorKey: 'showcase-levelup',
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  peacefulDrones: true,
  // Within the interceptor's 250 u auto-fire range of the spawn.
  dronePoses: [{ kind: 'heavy', x: 0, y: 140, angle: 0, hullExposed: true }],
  defaultSpawnX: 0,
  defaultSpawnY: -60,
  maxClients: 4,
} as const;

/**
 * A dense field for the scale shot: 500 bodies (60 % asteroids, the rest
 * peaceful drones) packed into a 2500 u radius — inside one client's interest
 * window, so it reads as dense on screen. (`swarm-tidi`'s 4000 are spread over
 * 32 000 u, so they look sparse and cost ~5 fps to film on a laptop.)
 */
export const SHOWCASE_SWARM_OPTS = {
  testMode: true,
  swarmCount: 500,
  swarmRatio: 0.6,
  swarmRadius: 2500,
  peacefulDrones: true,
  defaultSpawnX: 0,
  defaultSpawnY: 0,
  maxClients: 4,
} as const;

/** Room name → options, registered in `index.ts`. */
export const SHOWCASE_ROOMS = {
  'showcase-ship-gallery': SHOWCASE_SHIP_GALLERY_OPTS,
  'showcase-base': SHOWCASE_BASE_OPTS,
  'showcase-defence': SHOWCASE_DEFENCE_OPTS,
  'showcase-levelup': SHOWCASE_LEVELUP_OPTS,
  'showcase-swarm': SHOWCASE_SWARM_OPTS,
} as const;
