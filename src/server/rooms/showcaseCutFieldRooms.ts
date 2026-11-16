/**
 * Showcase room for the cut-field terrain shots (macro-terrain.md), kept out
 * of showcaseRooms.ts (god-file ceiling).
 */

/** Cut-field test room (macro-terrain.md): seed `look`'s whole field, no other
 *  rocks or drones; shots set the pose from `slicedFieldLanes`. */
export const CUT_FIELD_LOOK_SEED = 'look';
export const SHOWCASE_CUT_FIELD_OPTS = {
  testMode: true, cutField: { seed: CUT_FIELD_LOOK_SEED }, asteroidConfig: [], droneCount: 0,
  defaultSpawnX: 0, defaultSpawnY: 0, maxClients: 4, pilotCapitals: true,
};
