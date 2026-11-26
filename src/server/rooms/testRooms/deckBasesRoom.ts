/**
 * `?room=deck-bases` (base platforms slice 27): stills of NPC deck bases grown
 * by the real generator. Two bases of the same tier, role, seed and faction,
 * side by side on one deck: a SPARSE one (open space; west, on the origin
 * plate) and a DENSE one (as in an asteroid-field clearing; east). Owned by
 * Traders bases (`npc:traders:<baseId>`): neutral to players, so no fight
 * starts on spawn (the engage rules never open on a neutral).
 *
 * Both origins are plate centres (the seeder snaps a deck base's origin to
 * one). The dense base sits on the first plate east, near y = 0, that keeps
 * `DECK_BASES_GAP` clear of the sparse base's whole deck (every plate's 7
 * hexes, `deckExtent`). The pilot spawns in the gap between them. For a still
 * of each, use `spawnX/spawnY` at `DECK_BASES_SPARSE_AT` / `DECK_BASES_DENSE_AT`
 * (each base's origin plate centre; see the slice-27 report for numbers).
 */
import { deckExtent, type BaseExtent } from '../../../core/bases/baseSite.js';
import { plateCentreWorldInto } from '../../../core/hex/plates.js';
import { growNpcBase, type NpcBaseSpec } from '../../bases/NpcBaseSubsystem.js';

/** The compared base: a refinery settlement (Traders, on a minerals sector). */
const BASE: Omit<NpcBaseSpec, 'baseId' | 'x' | 'y'> = { role: 'refinery', tier: 'settlement', seed: 7, side: 'traders', features: ['minerals'] };
/** Clear space between the two bases' decks. */
export const DECK_BASES_GAP = 1500;

export const DECK_BASES_SPARSE_EXT: BaseExtent = deckExtent(growNpcBase({ ...BASE, baseId: 'sparse', x: 0, y: 0 }, true, false).placements);
export const DECK_BASES_DENSE_EXT: BaseExtent = deckExtent(growNpcBase({ ...BASE, baseId: 'dense', x: 0, y: 0 }, true, true).placements);

/** Sparse base origin: the origin plate's centre (0, 0). */
export const DECK_BASES_SPARSE_AT = plateCentreWorldInto(0, 0, { x: 0, y: 0 });
/** Dense base origin: the nearest plate centre east (|y| within one plate
 *  row's drift) whose deck clears the sparse one's by `DECK_BASES_GAP`. */
export const DECK_BASES_DENSE_AT = ((): { x: number; y: number } => {
  const p = { x: 0, y: 0 };
  let best: { x: number; y: number } | null = null;
  for (let i = 1; i <= 24; i++) {
    for (let j = -8; j <= 8; j++) {
      plateCentreWorldInto(i, j, p);
      if (Math.abs(p.y) > 1200 || p.x + DECK_BASES_DENSE_EXT.x0 < DECK_BASES_SPARSE_AT.x + DECK_BASES_SPARSE_EXT.x1 + DECK_BASES_GAP) continue;
      if (best === null || p.x < best.x) best = { x: p.x, y: p.y };
    }
  }
  return best!;
})();

export const DECK_BASES_SPECS: readonly NpcBaseSpec[] = [
  { ...BASE, baseId: 'sparse', x: DECK_BASES_SPARSE_AT.x, y: DECK_BASES_SPARSE_AT.y },
  { ...BASE, baseId: 'dense', x: DECK_BASES_DENSE_AT.x, y: DECK_BASES_DENSE_AT.y, dense: true },
];

export const DECK_BASES_OPTS = {
  sectorKey: 'deck-bases',
  persistSector: false,
  testMode: true,
  deck: true,
  asteroidConfig: [],
  droneCount: 0,
  peacefulDrones: true,
  npcBases: DECK_BASES_SPECS.map((s) => ({ ...s })),
  // Mid-gap between the two decks, level with the sparse origin.
  defaultSpawnX: Math.round((DECK_BASES_SPARSE_AT.x + DECK_BASES_SPARSE_EXT.x1 + DECK_BASES_DENSE_AT.x + DECK_BASES_DENSE_EXT.x0) / 2),
  defaultSpawnY: 0,
  maxClients: 4,
};
