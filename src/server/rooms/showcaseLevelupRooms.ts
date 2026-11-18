/** Showcase rooms for the level-up and loot (open a pod) shots (split out of `showcaseRooms.ts`). */

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
 * The "open a pod" loot shot: levelup with four peaceful, hull-exposed
 * heavies in auto-fire reach. Each death's coin flip is a fresh roll, so one
 * kill leaves a pod only about half the time; four kills almost always do.
 */
export const SHOWCASE_LOOT_OPTS = {
  ...SHOWCASE_LEVELUP_OPTS,
  sectorKey: 'showcase-loot',
  dronePoses: [
    { kind: 'heavy', x: 0, y: 140, angle: 0, hullExposed: true },
    { kind: 'heavy', x: -150, y: 90, angle: 0, hullExposed: true },
    { kind: 'heavy', x: 150, y: 90, angle: 0, hullExposed: true },
    { kind: 'heavy', x: 0, y: -220, angle: 0, hullExposed: true },
  ],
} as const;
