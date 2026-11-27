/**
 * Pure structure-placement legality (Phase-4 C2).
 *
 * A new structure's footprint may not overlap an existing structure OR an
 * obstacle (asteroid). Pre-Phase-4 the server only tested existing STRUCTURES,
 * so a Capital dropped on a rock LANDED ("places on an asteroid"). This module
 * is the SINGLE source of that rule — the server consults it on `place_structure`
 * and the client can consult it for the placement ghost — so both agree.
 *
 * Zone-pure (no I/O, reads only the catalogue radius). **Alloc-free** — the
 * reason is a string-literal union (interned, never a fresh object) and the
 * iterables are caller-owned, so it's safe to call from the per-frame ghost
 * preview (invariant #14). `null` means legal.
 */
import {
  getStructureKind,
  isConnectorKind,
  isStructureKindId,
  isStructureQuarterTurn,
  normaliseStructureQuarterTurn,
  normaliseStructureRotation,
  orientedBoxesOverlap,
  orientedBoxOverlapsCircle,
  structureHalfExtentsInto,
  structureLocalToWorld,
  structureRotationCosSinInto,
} from '../../shared-types/structureKinds.js';
import { pixelToAxialInto, type AxialHex } from '../hex/hex.js';
import { DECK_HEX_SIZE, plateOfHexInto, type PlateIndex } from '../hex/plates.js';
import { plateCentreAtWorldInto } from '../hex/plateSet.js';
import type { GridObstacle } from './Grid.js';
import { plateOverlapsObstacle } from './plateClearance.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from './deckLinks.js';
import { isOnDeckCorner, isOnDeckEdgeMid } from '../hex/deckCorners.js';
import { connectorOnRoadHex, DECK_ROAD_KIND } from './deckGateRoad.js';

/** A circular footprint to test against (a placed structure or the ghost). */
export interface PlacementFootprint {
  x: number;
  y: number;
  radius: number;
  /** Footprint half extents (phase V). ABSENT ⇒ a square of `radius`. */
  halfW?: number;
  halfH?: number;
  /** Its kind and rotation (degrees). Present ⇒ its kind's `keepClear` box
   *  (a dock's landing pad) is reserved too. ABSENT ⇒ the footprint only. */
  kind?: string;
  rot?: number;
  /** Placed mirrored (left-right flip, build mirror). ABSENT ⇒ not. */
  mirror?: boolean;
}

/** Why a placement is illegal. `null` (from {@link placementRejection}) = legal. */
export type PlacementRejection = 'overlap-structure' | 'overlap-obstacle' | 'overlap-pad' | 'off-deck' | 'plate-blocked';

/** The one plate query the deck rule needs (`PlateSet` on the server and the
 *  client mirror; `OwnerPlateList` in the renderer). */
export interface DeckPlateQuery {
  /** Is world point (x, y) on one of `owner`'s plates? */
  plateAtWorld(owner: string, x: number, y: number): boolean;
}

/** Deck context for {@link placementRejection} (base platforms, room flag
 *  `deck` on): whose deck the structure must stand on. Absent = no deck rule
 *  (system placements: NPC seeding, restore, scenarios). */
export interface PlacementDeck {
  plates: DeckPlateQuery;
  owner: string;
}

/** Plain player-facing text for each rejection. */
export const PLACEMENT_REJECTION_TEXT: Readonly<Record<PlacementRejection, string>> = Object.freeze({
  'overlap-structure': 'Too close to another structure',
  // Wreck pieces block placement too (wreck fields 7), so say both.
  'overlap-obstacle': 'Blocked by an asteroid or wreck',
  'overlap-pad': "Keep the landing pad clear",
  'off-deck': 'Off your deck',
  'plate-blocked': 'Plate area not clear',
});

/** The notice a player gets when the server refuses a placement, e.g.
 *  "Can't build here: blocked by an asteroid or wreck". Built once per
 *  reason (no per-call string work). */
const PLACEMENT_REJECTION_NOTICE: Readonly<Record<PlacementRejection, string>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(PLACEMENT_REJECTION_TEXT) as PlacementRejection[]).map((r) => {
      const t = PLACEMENT_REJECTION_TEXT[r];
      return [r, `Can't build here: ${t.charAt(0).toLowerCase()}${t.slice(1)}`];
    }),
  ) as Record<PlacementRejection, string>,
);

/** The player-facing refusal notice for a placement rejection. */
export function placementRejectionNotice(r: PlacementRejection): string {
  return PLACEMENT_REJECTION_NOTICE[r];
}

/** A kind's `keepClear` area in world space (see {@link keepClearBox}). */
export interface KeepClearBox {
  readonly x: number;
  readonly y: number;
  /** Axis-aligned half extents at the NEAREST quarter turn (the box base
   *  growth and cable routing read). */
  readonly hw: number;
  readonly hh: number;
  /** The real (oriented) box: LOCAL half extents turned by (`cos`, `sin`).
   *  At a quarter turn this is the axis-aligned box (`cos` 1, `sin` 0). */
  readonly lhw: number;
  readonly lhh: number;
  readonly cos: number;
  readonly sin: number;
}

/** Scratch for {@link keepClearBox} (alloc-free: the ghost preview calls this per frame). */
const padBox = { x: 0, y: 0, hw: 0, hh: 0, lhw: 0, lhh: 0, cos: 1, sin: 0 };
const padTurn = { cos: 1, sin: 0 };

/** The world box of a kind's `keepClear` area (a dock's landing pad) for a
 *  structure at (x, y) turned `rotDeg` (30° steps, game space y-up, CCW), or
 *  `null` when the kind reserves nothing. `mirror` flips the pad's local
 *  offset first (build mirror, `structureLocalToWorld`). Returns shared
 *  scratch: read it before the next call. */
export function keepClearBox(kindId: string | undefined, x: number, y: number, rotDeg: number | undefined, mirror?: boolean): KeepClearBox | null {
  if (kindId === undefined || !isStructureKindId(kindId)) return null;
  const kc = getStructureKind(kindId).keepClear;
  if (kc === undefined) return null;
  const r = normaliseStructureRotation(rotDeg);
  // Quarter turns stay exact (0 / ±1); a 30° step turns the pad's offset by
  // its real angle.
  structureRotationCosSinInto(r, padTurn);
  structureLocalToWorld(kc.cx, kc.cy, x, y, padTurn.cos, padTurn.sin, mirror, padBox);
  const swap = normaliseStructureQuarterTurn(r) % 180 !== 0;
  padBox.hw = (swap ? kc.h : kc.w) / 2;
  padBox.hh = (swap ? kc.w : kc.h) / 2;
  if (r % 90 === 0) {
    padBox.lhw = padBox.hw;
    padBox.lhh = padBox.hh;
    padBox.cos = 1;
    padBox.sin = 0;
  } else {
    // The pad box is symmetric, so the mirror flip moves only its offset.
    padBox.lhw = kc.w / 2;
    padBox.lhh = kc.h / 2;
    padBox.cos = padTurn.cos;
    padBox.sin = padTurn.sin;
  }
  return padBox;
}

/** Two axis-aligned boxes (structure footprints at quarter turns)
 *  overlap when they intersect on BOTH axes. Touching edges are legal. */
function boxesOverlap(ax: number, ay: number, ahw: number, ahh: number, bx: number, by: number, bhw: number, bhh: number): boolean {
  return Math.abs(ax - bx) < ahw + bhw && Math.abs(ay - by) < ahh + bhh;
}

/** A box vs a circle (an asteroid): the circle's centre is closer than its
 *  radius to the box's nearest point. */
function boxOverlapsCircle(bx: number, by: number, hw: number, hh: number, cx: number, cy: number, r: number): boolean {
  const dx = Math.max(Math.abs(cx - bx) - hw, 0);
  const dy = Math.max(Math.abs(cy - by) - hh, 0);
  return dx * dx + dy * dy < r * r;
}

/** Does the axis-aligned box (bx, by, ±hw, ±hh) overlap a convex polygon
 *  given relative to (ox, oy) and turned by (cos, sin)? Separating-axis test
 *  on the box's two axes and every polygon edge normal; touching is legal (as
 *  for boxes). A non-convex outline tests as at least its convex hull (its
 *  projections are the hull's), so it can only refuse more, never less.
 *  Allocation-free. */
function boxOverlapsPolygon(
  bx: number, by: number, hw: number, hh: number,
  poly: ReadonlyArray<{ readonly x: number; readonly y: number }>, ox: number, oy: number, cos: number, sin: number,
): boolean {
  const n = poly.length;
  if (n < 3) return false;
  // Box axes: the polygon's world extent along x and y.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = poly[i]!;
    const wx = ox + v.x * cos - v.y * sin, wy = oy + v.x * sin + v.y * cos;
    x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
  }
  if (x0 >= bx + hw || x1 <= bx - hw || y0 >= by + hh || y1 <= by - hh) return false;
  // Polygon edge normals (world frame; unnormalised: both intervals scale alike).
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[i + 1 < n ? i + 1 : 0]!;
    const lx = b.x - a.x, ly = b.y - a.y;
    const ax = -(lx * sin + ly * cos), ay = lx * cos - ly * sin;
    let p0 = Infinity, p1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const v = poly[k]!;
      const d = (ox + v.x * cos - v.y * sin) * ax + (oy + v.x * sin + v.y * cos) * ay;
      p0 = Math.min(p0, d); p1 = Math.max(p1, d);
    }
    const c = bx * ax + by * ay, r = hw * Math.abs(ax) + hh * Math.abs(ay);
    if (p0 >= c + r || p1 <= c - r) return false;
  }
  return true;
}

/** A box vs an obstacle: its bounding circle (broad phase), then, when it
 *  carries `parts`, the parts themselves (narrow phase, macro terrain C5b). */
function boxOverlapsObstacle(bx: number, by: number, hw: number, hh: number, o: GridObstacle): boolean {
  if (!boxOverlapsCircle(bx, by, hw, hh, o.x, o.y, o.radius)) return false;
  const parts = o.parts;
  if (parts === undefined) return true;
  const a = o.angle ?? 0, cos = Math.cos(a), sin = Math.sin(a);
  for (let p = 0; p < parts.length; p++) {
    if (boxOverlapsPolygon(bx, by, hw, hh, parts[p]!, o.x, o.y, cos, sin)) return true;
  }
  return false;
}

/** {@link boxOverlapsObstacle} for an ORIENTED box (local half extents turned
 *  by `bcos`, `bsin`): the obstacle is taken into the box's frame (its
 *  centre turned back, its parts turned by the angle difference), then it is
 *  the axis-aligned test. Allocation-free. */
function orientedBoxOverlapsObstacle(bx: number, by: number, hw: number, hh: number, bcos: number, bsin: number, o: GridObstacle): boolean {
  if (!orientedBoxOverlapsCircle(bx, by, hw, hh, bcos, bsin, o.x, o.y, o.radius)) return false;
  const parts = o.parts;
  if (parts === undefined) return true;
  const ox = o.x - bx, oy = o.y - by;
  const lx = ox * bcos + oy * bsin, ly = -ox * bsin + oy * bcos;
  const a = o.angle ?? 0, ocos = Math.cos(a), osin = Math.sin(a);
  // Turn by (a − b): cos(a−b), sin(a−b).
  const cos = ocos * bcos + osin * bsin, sin = osin * bcos - ocos * bsin;
  for (let p = 0; p < parts.length; p++) {
    if (boxOverlapsPolygon(0, 0, hw, hh, parts[p]!, lx, ly, cos, sin)) return true;
  }
  return false;
}

const DECK_PLATE: PlateIndex = { i: 0, j: 0 };
/** Scratch for {@link placementRejection} (alloc-free, #14). */
const myExt = { hw: 0, hh: 0 };
const myLocal = { hw: 0, hh: 0 };
const myTurn = { cos: 1, sin: 0 };
const theirTurn = { cos: 1, sin: 0 };
const DECK_HEX: AxialHex = { q: 0, r: 0 };
const DECK_OF: PlateIndex = { i: 0, j: 0 };

/** {@link deckStanding} results. */
const ON_DECK = 0, NEW_PLATE = 1, OFF_DECK = 2;

/** Where a `kindId` centre at (x, y) stands against `deck.owner`'s deck:
 *  ON_DECK, NEW_PLATE (a connector exactly on the centre of a plate that is
 *  not theirs, anywhere: a Deck plate may start a deck in open space; that
 *  plate is left in DECK_PLATE) or OFF_DECK. */
function deckStanding(kindId: string, x: number, y: number, deck: PlacementDeck): number {
  if (deck.plates.plateAtWorld(deck.owner, x, y) || fenceTouchesDeck(kindId, x, y, deck)) return ON_DECK;
  if (!isConnectorKind(kindId) || !plateCentreAtWorldInto(x, y, DECK_PLATE)) return OFF_DECK;
  return NEW_PLATE;
}

/** Unit steps, 30° apart, from a seam point into the hexes round it. */
const SEAM_NUDGE_COS = Array.from({ length: 12 }, (_, k) => Math.cos((k * Math.PI) / 6));
const SEAM_NUDGE_SIN = Array.from({ length: 12 }, (_, k) => Math.sin((k * Math.PI) / 6));
/** How far a seam point steps into each hex round it: inside every hex that
 *  touches the point (any other hex is at least half an edge away). */
const SEAM_NUDGE = DECK_HEX_SIZE / 4;

/**
 * Base platforms slice 26: a fence post on a hex CORNER, or a fence gate on a
 * hex EDGE midpoint, stands on the deck when ANY hex it touches is on one of
 * the owner's plates. The point sits on a seam, so the hex rounding gives it
 * may be the off-deck one: without this, about a third of the corners and
 * half the edges round a deck's OUTER boundary were refused `'off-deck'` (a
 * player could not fence their own deck's edge). Allocation-free.
 */
function fenceTouchesDeck(kindId: string, x: number, y: number, deck: PlacementDeck): boolean {
  const onSeam = kindId === DECK_FENCE_POST_KIND ? isOnDeckCorner(x, y) : kindId === DECK_FENCE_GATE_KIND && isOnDeckEdgeMid(x, y);
  if (!onSeam) return false;
  for (let k = 0; k < SEAM_NUDGE_COS.length; k++) {
    if (deck.plates.plateAtWorld(deck.owner, x + SEAM_NUDGE * SEAM_NUDGE_COS[k]!, y + SEAM_NUDGE * SEAM_NUDGE_SIN[k]!)) return true;
  }
  return false;
}

/** Is world point (x, y) on plate DECK_PLATE? */
function onLaidPlate(x: number, y: number): boolean {
  pixelToAxialInto(x, y, DECK_HEX_SIZE, DECK_HEX);
  plateOfHexInto(DECK_HEX.q, DECK_HEX.r, DECK_OF);
  return DECK_OF.i === DECK_PLATE.i && DECK_OF.j === DECK_PLATE.j;
}

/**
 * Base platforms: may a `kindId` centre at (x, y) stand on `deck.owner`'s
 * deck? Yes when (x, y) is on one of their plates; also for a connector-kind
 * structure exactly on the centre of any plate (that connector lays a NEW
 * plate, anywhere clear: a deck may start in open space). Occupancy is the
 * overlap check's job.
 * Allocation-free.
 */
export function onOwnDeck(kindId: string, x: number, y: number, deck: PlacementDeck): boolean {
  return deckStanding(kindId, x, y, deck) !== OFF_DECK;
}

/**
 * The reason a `kindId` footprint at (x, y) cannot be placed, or `null` when it
 * is legal. A kind's `keepClear` box (a dock's landing pad) counts as
 * reserved: the new footprint may not overlap an existing entry's pad (entries
 * that carry `kind`), nor may the new kind's pad overlap an existing
 * footprint (`overlap-pad`). Links are not structures, so they may cross a
 * pad. Tests the sum-of-radii overlap against every `structures` entry and
 * every `obstacles` entry (asteroids: bounding circle, then the convex `parts`
 * when the obstacle has them). `obstacles` omitted/empty ⇒ structures-only
 * (byte-identical to the legacy server check). `deck` given (the room's
 * deck flag is on and this is a player's placement) ⇒ the centre must also be
 * on the owner's deck ({@link onOwnDeck}), else `off-deck`. A connector
 * that lays a NEW plate needs the whole plate clear (owner ruling, no rock
 * clearing): no obstacle touching any of its 7 hexes and no structure
 * centred on it, else `plate-blocked`. Roads are optional: a shield gate
 * needs no road beside its seam (owner ruling). A road and a connector never share a hex (`connectorOnRoadHex`: the road paves
 * its whole hex, past its footprint box), else `overlap-structure`.
 */
export function placementRejection(
  kindId: string,
  x: number,
  y: number,
  structures: Iterable<PlacementFootprint>,
  obstacles?: readonly GridObstacle[] | null,
  rotDeg: number = 0,
  mirror?: boolean,
  deck?: PlacementDeck | null,
): PlacementRejection | null {
  // A quarter turn keeps the exact axis-aligned rules (byte-identical); a
  // 30° step tests the real turned box (base platforms 16).
  structureHalfExtentsInto(kindId, rotDeg, myExt);
  const hw = myExt.hw, hh = myExt.hh;
  const turned = !isStructureQuarterTurn(rotDeg);
  let mhw = hw, mhh = hh, mcos = 1, msin = 0;
  if (turned) {
    structureHalfExtentsInto(kindId, 0, myLocal);
    structureRotationCosSinInto(rotDeg, myTurn);
    mhw = myLocal.hw; mhh = myLocal.hh; mcos = myTurn.cos; msin = myTurn.sin;
  }
  const standing = deck ? deckStanding(kindId, x, y, deck) : ON_DECK;
  let plateBlocked = false;
  for (const s of structures) {
    const shw = s.halfW ?? s.radius, shh = s.halfH ?? s.radius;
    const theirTurned = s.rot !== undefined && !isStructureQuarterTurn(s.rot);
    let thw = shw, thh = shh, tcos = 1, tsin = 0;
    if (theirTurned) {
      // `halfW`/`halfH` are the nearest-quarter box: swap back to local.
      const swap = normaliseStructureQuarterTurn(s.rot) % 180 !== 0;
      thw = swap ? shh : shw;
      thh = swap ? shw : shh;
      structureRotationCosSinInto(s.rot, theirTurn);
      tcos = theirTurn.cos; tsin = theirTurn.sin;
    }
    if (roadMeetsConnector(kindId, x, y, hw, hh, s, shw, shh)) return 'overlap-structure';
    if (turned || theirTurned) {
      if (orientedBoxesOverlap(s.x, s.y, thw, thh, tcos, tsin, x, y, mhw, mhh, mcos, msin)) return 'overlap-structure';
    } else if (boxesOverlap(s.x, s.y, shw, shh, x, y, hw, hh)) return 'overlap-structure';
    const theirs = keepClearBox(s.kind, s.x, s.y, s.rot, s.mirror);
    if (theirs !== null) {
      if (turned || theirs.sin !== 0) {
        if (orientedBoxesOverlap(theirs.x, theirs.y, theirs.lhw, theirs.lhh, theirs.cos, theirs.sin, x, y, mhw, mhh, mcos, msin)) return 'overlap-pad';
      } else if (boxesOverlap(theirs.x, theirs.y, theirs.hw, theirs.hh, x, y, hw, hh)) return 'overlap-pad';
    }
    const mine = keepClearBox(kindId, x, y, rotDeg, mirror);
    if (mine !== null) {
      if (theirTurned || mine.sin !== 0) {
        if (orientedBoxesOverlap(mine.x, mine.y, mine.lhw, mine.lhh, mine.cos, mine.sin, s.x, s.y, thw, thh, tcos, tsin)) return 'overlap-pad';
      } else if (boxesOverlap(mine.x, mine.y, mine.hw, mine.hh, s.x, s.y, shw, shh)) return 'overlap-pad';
    }
    if (standing === NEW_PLATE && !plateBlocked && onLaidPlate(s.x, s.y)) plateBlocked = true;
  }
  if (obstacles) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]!;
      if (turned ? orientedBoxOverlapsObstacle(x, y, mhw, mhh, mcos, msin, o) : boxOverlapsObstacle(x, y, hw, hh, o)) return 'overlap-obstacle';
      if (standing === NEW_PLATE && !plateBlocked && plateOverlapsObstacle(DECK_PLATE.i, DECK_PLATE.j, o)) plateBlocked = true;
    }
  }
  if (standing === OFF_DECK) return 'off-deck';
  if (plateBlocked) return 'plate-blocked';
  return null;
}

/** Convenience boolean wrapper over {@link placementRejection}. */
export function canPlaceStructureAt(
  kindId: string,
  x: number,
  y: number,
  structures: Iterable<PlacementFootprint>,
  obstacles?: readonly GridObstacle[] | null,
  rotDeg: number = 0,
  mirror?: boolean,
  deck?: PlacementDeck | null,
): boolean {
  return placementRejection(kindId, x, y, structures, obstacles, rotDeg, mirror, deck) === null;
}

/** A road on one side and a connector on the other, the connector reaching
 *  into the road's hex (`connectorOnRoadHex`). `hw`/`hh`: the new
 *  footprint's nearest-quarter half extents; `shw`/`shh`: `s`'s. */
function roadMeetsConnector(kindId: string, x: number, y: number, hw: number, hh: number, s: PlacementFootprint, shw: number, shh: number): boolean {
  if (kindId === DECK_ROAD_KIND) return isConnectorKind(s.kind) && connectorOnRoadHex(s.x, s.y, shw, shh, x, y);
  return s.kind === DECK_ROAD_KIND && isConnectorKind(kindId) && connectorOnRoadHex(x, y, hw, hh, s.x, s.y);
}
