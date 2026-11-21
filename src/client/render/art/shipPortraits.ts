/**
 * Join flow stage 3 — baked ship pictures for ship cards (the Hangar).
 *
 * `pnpm ships:portraits` renders each hull in the art lab's `portrait` scene
 * (machined art) and writes `public/ships/<kind>.webp`, committed so a phone's
 * first paint needs no bake. Cards show the picture; the vector outline
 * (`shipShapeSvg`) stays where a vector is needed (map markers).
 */
import { PLAYABLE_SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';
import { buildRecipeFor } from '../../../shared-types/recipes.js';
import type { ShipKindId } from '../../../shared-types/shipKinds.js';
import { STRUCTURE_KINDS_LIST, isBuildableStructureKind } from '../../../shared-types/structureKinds.js';

/** Every hull a pilot can fly (engineering-only test hulls excluded). */
export const PORTRAIT_KINDS: readonly string[] = PLAYABLE_SHIP_KINDS_LIST
  .filter((k) => !k.engineeringOnly)
  .map((k) => k.id);

const HAS = new Set(PORTRAIT_KINDS);

/** One camera zoom for every warship capital (no Shipyard recipe: launched
 *  with credits), so they read to scale (a Battleship bigger than a
 *  Destroyer): set so the largest fits the 900 px picture crop with a margin.
 *  A Shipyard-built capital (the Barge) is fitted on its own instead. */
export const CAPITAL_PORTRAIT_ZOOM = 0.17;
/** Capitals are long: they lie corner to corner (radians, Pixi rotation). */
export const CAPITAL_PORTRAIT_ROT = -Math.PI / 4;

/** How the art lab frames a hull's picture (`portrait` scene params):
 *  capitals at the shared zoom (`cz`), laid corner to corner (`rot`), turrets
 *  drawn, no engine glow; other hulls each fitted to the picture (`zm` scales
 *  the fit) at the lab's default pose, engines lit. */
export interface PortraitFraming { zm: number; cz?: number; rot?: number; th: number; turrets: boolean }

export function portraitFraming(kind: string): PortraitFraming {
  const k = PLAYABLE_SHIP_KINDS_LIST.find((s) => s.id === kind);
  if (!k || sizeClassOf(k) !== 'capital') return { zm: 1, th: 0.6, turrets: false };
  return buildRecipeFor(kind as ShipKindId) === null
    ? { zm: 1, cz: CAPITAL_PORTRAIT_ZOOM, rot: CAPITAL_PORTRAIT_ROT, th: 0, turrets: true }
    : { zm: 1, rot: CAPITAL_PORTRAIT_ROT, th: 0, turrets: true };
}

/** The art lab query for `kind`'s picture. */
export function portraitQuery(kind: string): string {
  const f = portraitFraming(kind);
  return `style=machined&scene=portrait&kind=${kind}&zm=${f.zm}&th=${f.th}${f.cz !== undefined ? `&cz=${f.cz}` : ''}${f.rot !== undefined ? `&rot=${f.rot.toFixed(4)}` : ''}${f.turrets ? '&turrets=1' : ''}`;
}

/** The baked picture's URL for `kind`, or null when there is none. */
export function shipPortraitUrl(kind: string): string | null {
  return HAS.has(kind) ? `/ships/${kind}.webp` : null;
}

/** Build menu P1 — every structure a player can build (the build categories,
 *  `buildCategories.tsx`, cover exactly these: locked by its test), each baked
 *  by the same `pnpm ships:portraits` run into `public/structures/<kind>.webp`. */
export const STRUCTURE_PORTRAIT_KINDS: readonly string[] = STRUCTURE_KINDS_LIST
  .map((k) => k.id)
  .filter((id) => isBuildableStructureKind(id));

const HAS_STRUCT = new Set(STRUCTURE_PORTRAIT_KINDS);

/** The art lab query for structure `kind`'s picture (framed by its own footprint). */
export function structurePortraitQuery(kind: string): string {
  return `style=machined&scene=portrait&struct=${kind}`;
}

/** The baked structure picture's URL for `kind`, or null when there is none. */
export function structurePortraitUrl(kind: string): string | null {
  return HAS_STRUCT.has(kind) ? `/structures/${kind}.webp` : null;
}
