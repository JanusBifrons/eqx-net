/**
 * Showcase rooms for the weapon-cuts shots (showcase/shots/weaponCuts.ts),
 * kept out of showcaseRooms.ts (god-file ceiling). Built from the capitals
 * combat base the caller passes, so this file never imports showcaseRooms.ts.
 */

/** A bystander that holds its spot and never fights: a straight scripted
 *  "path" to its own pose (`ScriptedPathBehaviour`, no combat brain), so test
 *  aggro can't send it after the pilot and it stays where the scene put it. */
function holdStation(kind: string, x: number, y: number, angle = 0): { kind: string; x: number; y: number; angle: number; path: { toX: number; toY: number; speed: number; loop: boolean } } {
  return { kind, x, y, angle, path: { toX: x, toY: y, speed: 0, loop: false } };
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
  /** Weapon cuts, collateral (`beam-collateral-subcap`): your lance
   *  battlecruiser (a scene `fleet` hull owned by the pilot, AI-flown, Hunt +
   *  Aggressive) at the origin, nose north, and the enemy's lance
   *  battlecruiser due north, nose south (`hostile`: marked hostile to the
   *  pilot on join, so it fights back). The two close head on, so the line
   *  between them stays put. The enemy's missile frigate holds station on
   *  that line, ahead of the enemy capital. Nobody locks or aims at it; your
   *  capital's heavy beams, laid on the enemy capital, burn through it on the
   *  way. The capitals start past the 5" secondaries' reach, so only the
   *  heavy beams can fire at first. The pilot's own ship parks far west, out
   *  of both capitals' reach, and the shot spectates. Roster-backed (a real
   *  `sectorKey` outside the galaxy graph) because the `fleet` step needs a
   *  roster. */
  const beamCollateral = {
    ...base,
    sectorKey: 'showcase-beam-collateral',
    dronePoses: [
      { kind: 'battlecruiser-lance', x: 0, y: BEAM_COLLATERAL.enemyY, angle: Math.PI, hostile: true },
      // Broadside to the line (nose west), so it fills the beams' path.
      holdStation('missile-frigate', 0, BEAM_COLLATERAL.frigateY, Math.PI / 2),
    ],
    prebuiltStructures: [],
    sceneScript: [
      // Your capital joins BEAM_COLLATERAL.mineAtMs after the pilot is ready,
      // so the ship art has baked before the fight opens (the shot waits for it).
      { atMs: BEAM_COLLATERAL.mineAtMs, action: 'fleet', tag: 'mine', kind: 'battlecruiser-lance', count: 1, x: 0, y: 0, mode: 'hunt', stance: 'aggressive' },
    ],
    defaultSpawnX: BEAM_COLLATERAL.pilotX,
    defaultSpawnY: BEAM_COLLATERAL.pilotY,
  };
  return { beamSlice, railChannel, beamCollateral };
}

/** Where the collateral room puts things (game units). */
export const BEAM_COLLATERAL = {
  /** The enemy capital, due north of yours: past the 5" secondaries' reach
   *  (16.6 km), inside the heavy beams' (20 km). */
  enemyY: 19_500,
  /** The enemy's frigate, on the line between them, 5 km ahead of the enemy
   *  capital: clear of its bow (~1.4 km ahead of its centre) after the enemy
   *  has closed ~2 km by the time your beams open fire. */
  frigateY: 14_500,
  /** The pilot's own ship, due south behind yours, out of the enemy's reach
   *  (25.5 km). On the line, so the enemy capital, hostile to the pilot,
   *  drifts toward it along the line and not off it. */
  pilotX: 0,
  pilotY: -6_000,
  /** Game ms after the pilot's ready when your capital arrives (a 10x hull's
   *  art bakes in ~15 s). */
  mineAtMs: 20_000,
} as const;
