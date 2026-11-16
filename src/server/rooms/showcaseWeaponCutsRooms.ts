/**
 * Showcase rooms for the weapon-cuts shots (showcase/shots/weaponCuts.ts),
 * kept out of showcaseRooms.ts (god-file ceiling). Built from the capitals
 * combat base the caller passes, so this file never imports showcaseRooms.ts.
 */

/** A bystander that holds its spot and never fights: a straight scripted
 *  "path" to its own pose (`ScriptedPathBehaviour`, no combat brain), so test
 *  aggro can't send it after the pilot and it stays where the scene put it. */
function holdStation(kind: string, x: number, y: number): { kind: string; x: number; y: number; angle: number; path: { toX: number; toY: number; speed: number; loop: boolean } } {
  return { kind, x, y, angle: 0, path: { toX: x, toY: y, speed: 0, loop: false } };
}

/** The weapon-cuts room options on top of `base` (SHOWCASE_CAPITALS_COMBAT_OPTS). */
export function weaponCutsRoomOpts<T extends object>(base: T) {
  /** Weapon cuts (capital-destruction.md "Kill cuts"): a lance battlecruiser
   *  (heavy beams in its main turrets) at the origin, nose +y, alone. The pilot
   *  joins in the hull the shot wants: `beam-slice` a heavy cruiser 8,000 u off
   *  its starboard beam (the default spawn), `beam-vaporise-subcap` a missile
   *  frigate further out (its own `spawnX`). */
  const beamSlice = {
    ...base,
    dronePoses: [{ kind: 'battlecruiser-lance', x: 0, y: 0, angle: 0 }],
    prebuiltStructures: [],
    defaultSpawnX: 8000,
    defaultSpawnY: 0,
  };

  /** Weapon cuts: a rail battleship at the origin, nose +y, the pilot (join
   *  `shipKind=heavy-cruiser`) about 7,000 u off its starboard beam, and a light cruiser
   *  holding station 3,000 u further out on the same line, so a slug that kills
   *  the pilot flies on into it. */
  const railChannel = {
    ...base,
    dronePoses: [
      { kind: 'battleship-rail', x: 0, y: 0, angle: 0 },
      holdStation('light-cruiser', 10_000, 0),
    ],
    prebuiltStructures: [],
    defaultSpawnX: 7000,
    defaultSpawnY: 0,
  };
  return { beamSlice, railChannel };
}
