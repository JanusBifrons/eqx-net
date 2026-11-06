/**
 * Showcase capture rooms (docs/architecture/showcase-pipeline.md).
 *
 * Staged scenes for the repeatable showcase video. Each exists because no
 * existing engineering room stages that scene. Registered in `index.ts` inside
 * the test-room gate (S6) with `filterBy(['testId'])`; exported here so the
 * integration test boots EXACTLY the options the server registers.
 */
import { SCENARIO, STRUCTURE_SCENARIO_PREBUILT } from './scenarioLayouts.js';

/**
 * The pilot identity base shots join as (anonymous join, seeded `eqxPlayerId`).
 * Owning the prebuilt base makes it "yours": the build preview draws green
 * links to it (cross-owner hubs are skipped by design) and the inspector reads
 * "you" instead of "Unknown". A valid UUID — the client rejects anything else.
 */
import { TIER_LEVEL_CAP, TIER_WEALTH, type BaseProfile } from '../../core/bases/baseProfile.js';
import { growBase } from '../../core/bases/growBase.js';
import { grownExtent } from '../../core/bases/baseSite.js';
import { linkId } from '../../core/bases/transitNetwork.js';

import { getShipKind } from '../../shared-types/shipKinds.js';

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
 * Capital-ship R&D (plan eager-sauteeing-curry): the five capitals parked side
 * by side, nose up, spaced by their beams (so either size mapping fits), with a
 * fighter and a base core for scale. Join with `startHostile=1` and they turn
 * and fire (the broadside shot).
 */
const CAPITAL_IDS = ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship'] as const;
function capitalLineup(): Array<{ kind: string; x: number; y: number; angle: number }> {
  const beamOf = (id: string): number => {
    const hull = (getShipKind(id).shape as { hull?: ReadonlyArray<readonly [number, number]> }).hull ?? [];
    let w = 10;
    for (const [x] of hull) w = Math.max(w, Math.abs(x));
    return 2 * w;
  };
  let gap = 0;
  for (const id of CAPITAL_IDS) gap = Math.max(gap, beamOf(id) * 2.6);
  const n = CAPITAL_IDS.length;
  const poses = CAPITAL_IDS.map((kind, i) => ({ kind: kind as string, x: (i - (n - 1) / 2) * gap, y: 0, angle: 0 }));
  poses.push({ kind: 'fighter', x: -((n - 1) / 2) * gap - gap * 0.8, y: 0, angle: 0 });
  // A parked wing of fighters south of the fleet, for scale (and the far-zoom
  // dots in the capital-pilot shot, round 3 F).
  for (let i = 0; i < 8; i++) poses.push({ kind: 'fighter', x: -1400 + (i % 4) * 260 + (i >= 4 ? 130 : 0), y: -4600 - (i >= 4 ? 220 : 0), angle: 0 });
  return poses;
}
/** Clear of every hull in the line-up (ships sit at y = 0, so their sterns
 *  reach -radius): the pilot and the base must not spawn inside a 10x hull. */
const CAPITAL_CLEAR_Y = -Math.max(...CAPITAL_IDS.map((id) => getShipKind(id).radius));
export const SHOWCASE_CAPITALS_OPTS = {
  testMode: true,
  asteroidConfig: [],
  peacefulDrones: true,
  dronePoses: capitalLineup(),
  prebuiltStructuresOwner: SHOWCASE_PILOT_ID,
  prebuiltStructures: [{ kind: 'capital', x: 2000, y: Math.round(CAPITAL_CLEAR_Y - 2600) }],
  defaultSpawnX: 0,
  defaultSpawnY: Math.round(CAPITAL_CLEAR_Y - 1200),
  maxClients: 4,
  /** Round 3 D: join `?shipKind=battleship` to fly a capital with helm orders. */
  pilotCapitals: true,
};

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
    // Phase V footprints (Capital ±280): four relays round the Capital, a
    // solar on each side relay + a solar and battery north, the two turrets on
    // the south relay, and the shield wall across the southern approach (each
    // pylon taps a side relay; the pair links across the gap).
    { kind: 'capital', x: 0, y: 0 },
    { kind: 'connector', x: 400, y: 0 },
    { kind: 'connector', x: -400, y: 0 },
    { kind: 'connector', x: 0, y: 400 },
    { kind: 'connector', x: 0, y: -400 },
    { kind: 'solar', x: 650, y: 0 },
    { kind: 'solar', x: -650, y: 0 },
    { kind: 'solar', x: -250, y: 470 },
    { kind: 'battery', x: 230, y: 470 },
    { kind: 'shield_pylon', x: -300, y: -560 },
    { kind: 'shield_pylon', x: 300, y: -560 },
    { kind: 'laser_bolt_turret', x: -150, y: -400 },
    { kind: 'missile_turret', x: 170, y: -400 },
  ],
  // P2d — missile turrets spend munitions; stock the Capital.
  prebuiltStorageGoods: { munitions: 50 },
  dronePoses: [
    { kind: 'fighter', x: -350, y: -1000, angle: Math.PI },
    { kind: 'gunship', x: 0, y: -1100, angle: Math.PI },
    { kind: 'interceptor', x: 350, y: -1000, angle: Math.PI },
    { kind: 'fighter', x: -150, y: -1250, angle: Math.PI },
    { kind: 'scout', x: 150, y: -1250, angle: Math.PI },
  ],
  defaultSpawnX: 0,
  defaultSpawnY: -490, // inside the wall, between the turrets
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
    // Phase V footprints — the shared scenario grid (scenarioLayouts.ts).
    ...STRUCTURE_SCENARIO_PREBUILT,
  ],
  scenarioAsteroids: [{ ...SCENARIO.asteroid }],
  scenarioDrones: [{ ...SCENARIO.drone }],
  defaultSpawnX: 900,
  defaultSpawnY: 900,
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

/**
 * The pilot's home base, roster-backed (real sectorKey, outside the galaxy
 * graph) so cargo can be hauled home: join with `initialCargo` far to the
 * south-west, fly past the Miner drilling its asteroid, and unload at the
 * Capital (auto-deposit). Peaceful — no drones.
 */
export const SHOWCASE_HOMESTEAD_OPTS = {
  sectorKey: 'showcase-homestead',
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  peacefulDrones: true,
  structureGridPulseMs: 250,
  prebuiltStructuresOwner: SHOWCASE_PILOT_ID,
  prebuiltStructures: [...STRUCTURE_SCENARIO_PREBUILT],
  scenarioAsteroids: [{ ...SCENARIO.asteroid }],
  defaultSpawnX: -1150,
  defaultSpawnY: -1450,
  maxClients: 4,
} as const;

/**
 * A named elite with a bounty and two escorts, on cue (the EliteDirector only
 * sends them on its own schedule). Roster-backed so the bounty pays into the
 * killer's wallet. Join with `startHostile=1`.
 */
export const SHOWCASE_BOUNTY_OPTS = {
  sectorKey: 'showcase-bounty',
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  dronePoses: [
    { kind: 'heavy', x: 0, y: 650, angle: Math.PI, hullExposed: true, elite: { name: 'Kestrel Vane', healthMul: 0.35 } },
    { kind: 'fighter', x: -260, y: 760, angle: Math.PI, hullExposed: true },
    { kind: 'fighter', x: 260, y: 760, angle: Math.PI, hullExposed: true },
  ],
  defaultSpawnX: 0,
  defaultSpawnY: -150,
  maxClients: 4,
} as const;

/**
 * v4 T1/T2 — a paired teleporter pair that fires when a ship boards. The
 * pilot spawns south of the west pad, flies onto it, is warned, the doors
 * close, and the jump lands it on the east pad. Capacitors kept full.
 */
export const SHOWCASE_TELEPORT_OPTS = {
  sectorKey: 'showcase-teleport',
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  peacefulDrones: true,
  structureGridPulseMs: 100,
  teleportCycleScale: 0.6,
  prebuiltStructures: [
    { kind: 'capital', x: 0, y: 0 },
    { kind: 'connector', x: -600, y: 0 },
    { kind: 'connector', x: 600, y: 0 },
    { kind: 'teleporter', x: -1300, y: 0 },
    { kind: 'teleporter', x: 1300, y: 0 },
  ],
  prebuiltStructuresOwner: 'scenario',
  pairTeleporters: true,
  teleportShipBoards: true,
  teleportFullCharge: true,
  defaultSpawnX: -1300,
  defaultSpawnY: -900,
  maxClients: 4,
} as const;

/** v4 M — a region power's garrison (a fenced gun-base) with its patrol. */
const GARRISON_PROFILE: BaseProfile = {
  tier: 'stronghold',
  role: 'military',
  ownerFaction: 'core',
  wealth: TIER_WEALTH.stronghold[1] * 2,
  levelCap: TIER_LEVEL_CAP.stronghold[1],
  fenced: true,
};
export const GARRISON_EXTENT = grownExtent(growBase(GARRISON_PROFILE, 7, []).placements);
export const SHOWCASE_GARRISON_OPTS = {
  sectorKey: 'showcase-garrison',
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  npcBases: [{ baseId: 'mil', role: 'military', tier: 'stronghold', seed: 7, x: 0, y: 0, side: 'core', profile: GARRISON_PROFILE }],
  defaultSpawnX: 0,
  // South of the patrol's corners (they fly 500 u outside the base), in bounds.
  defaultSpawnY: Math.max(-4800, Math.round(GARRISON_EXTENT.y0 - 900)),
  maxClients: 4,
};

/**
 * v4 H — a transit hub and a trade port it links to, side by side in one
 * room (the link's two ends; galaxy links join two sectors). The pilot spawns
 * on the hub's link pad with credits: it is asked the toll, pays, the doors
 * close, and it lands at the port.
 */
const HUB_LINK = linkId({ sector: 'showcase-hub', baseId: 'hub' }, { sector: 'showcase-hub', baseId: 'port' });
const HUB_PROFILE: BaseProfile = {
  tier: 'settlement', role: 'transit', ownerFaction: 'traders', wealth: 20_000, levelCap: 2, fenced: false, links: [HUB_LINK],
};
const PORT_PROFILE: BaseProfile = {
  tier: 'outpost', role: 'trade', ownerFaction: 'traders', wealth: 6_000, levelCap: 1, fenced: false, links: [HUB_LINK],
};
const HUB_GROWN = growBase(HUB_PROFILE, 11, ['station']);
const PORT_GROWN = growBase(PORT_PROFILE, 12, ['station']);
const HUB_EXT = grownExtent(HUB_GROWN.placements);
const PORT_EXT = grownExtent(PORT_GROWN.placements);
/** Capital positions: the two bases side by side with a 700 u gap. */
export const SHOWCASE_HUB_X = Math.round(-HUB_EXT.x1 - 350);
export const SHOWCASE_PORT_X = Math.round(-PORT_EXT.x0 + 350);
const HUB_PAD = HUB_GROWN.placements.find((p) => p.link === HUB_LINK)!;
const PORT_PAD = PORT_GROWN.placements.find((p) => p.link === HUB_LINK)!;
/** Where the two link pads end up (the shot frames them). */
export const SHOWCASE_HUB_PAD = { x: SHOWCASE_HUB_X + HUB_PAD.x, y: HUB_PAD.y };
export const SHOWCASE_PORT_PAD = { x: SHOWCASE_PORT_X + PORT_PAD.x, y: PORT_PAD.y };
export const SHOWCASE_HUB_OPTS = {
  sectorKey: 'showcase-hub',
  testMode: true,
  droneCount: 0,
  asteroidConfig: [],
  peacefulDrones: true,
  sectorFeatures: ['station'],
  teleportCycleScale: 0.6,
  teleportFullCharge: true,
  npcBases: [
    { baseId: 'hub', role: 'transit', tier: 'settlement', seed: 11, x: SHOWCASE_HUB_X, y: 0, side: 'traders', features: ['station'], profile: HUB_PROFILE },
    { baseId: 'port', role: 'trade', tier: 'outpost', seed: 12, x: SHOWCASE_PORT_X, y: 0, side: 'traders', features: ['station'], profile: PORT_PROFILE },
  ],
  defaultSpawnX: SHOWCASE_HUB_PAD.x,
  defaultSpawnY: SHOWCASE_HUB_PAD.y,
  maxClients: 4,
};

/** Room name → options, registered in `index.ts`. */
export const SHOWCASE_ROOMS = {
  'showcase-ship-gallery': SHOWCASE_SHIP_GALLERY_OPTS,
  'showcase-base': SHOWCASE_BASE_OPTS,
  'showcase-defence': SHOWCASE_DEFENCE_OPTS,
  'showcase-levelup': SHOWCASE_LEVELUP_OPTS,
  'showcase-swarm': SHOWCASE_SWARM_OPTS,
  'showcase-homestead': SHOWCASE_HOMESTEAD_OPTS,
  'showcase-bounty': SHOWCASE_BOUNTY_OPTS,
  'showcase-teleport': SHOWCASE_TELEPORT_OPTS,
  'showcase-garrison': SHOWCASE_GARRISON_OPTS,
  'showcase-hub': SHOWCASE_HUB_OPTS,
  'showcase-capitals': SHOWCASE_CAPITALS_OPTS,
} as const;
