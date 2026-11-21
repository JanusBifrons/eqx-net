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

/** A structure picture's camera: `zm` scales the footprint fit; `cx`/`cy`
 *  move the camera centre (`?ox=`/`?oy=`; the lab's own `?cx=` is world units), in screen px at `zm` 1 (lab y-down), so the
 *  bake can reframe from pixels without knowing the world zoom. */
export interface StructureFrame { zm: number; cx: number; cy: number }

/** The art lab query for structure `kind`'s picture, guns drawn as the game
 *  does. `bare` keeps the camera but drops the structure (the background,
 *  for measuring what the structure drew). */
export function structurePortraitQuery(kind: string, frame: StructureFrame = { zm: 1, cx: 0, cy: 0 }, bare = false): string {
  return `style=machined&scene=portrait&struct=${kind}&turrets=1&zm=${+frame.zm.toFixed(4)}&ox=${+frame.cx.toFixed(2)}&oy=${+frame.cy.toFixed(2)}${bare ? '&bare=1' : ''}`;
}

/** Fraction of the picture left empty on each side of the drawn bounds. */
export const STRUCTURE_PORTRAIT_PAD = 0.06;

/**
 * Reframe from a measured render: `box` is the drawn bounds (canvas px) of a
 * render at `at`, on a `view`-sized canvas whose centre is the camera centre.
 * Returns the frame that centres the box and fits its longer side into the
 * `crop`-px square, with an even `pad` each side.
 */
export function reframeStructure(
  at: StructureFrame, box: { x0: number; y0: number; x1: number; y1: number },
  view: { w: number; h: number }, crop: number, pad = STRUCTURE_PORTRAIT_PAD,
): StructureFrame {
  const side = Math.max(box.x1 - box.x0, box.y1 - box.y0, 1);
  const dx = (box.x0 + box.x1) / 2 - view.w / 2, dy = (box.y0 + box.y1) / 2 - view.h / 2;
  return { zm: (at.zm * crop * (1 - 2 * pad)) / side, cx: at.cx + dx / at.zm, cy: at.cy + dy / at.zm };
}

/** The baked structure picture's URL for `kind`, or null when there is none. */
export function structurePortraitUrl(kind: string): string | null {
  return HAS_STRUCT.has(kind) ? `/structures/${kind}.webp` : null;
}
