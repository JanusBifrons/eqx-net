/**
 * The public input/output contract of fractureHull.ts: the `FractureInput`
 * and its cuts, the seeded `FracturePlan`, the `FracturePiece` output, the
 * edge-kind type and the piece-count limits. Types and constants only, so
 * every fracture module can import them without an import cycle;
 * fractureHull.ts re-exports the public names.
 */
import type { Vec2 } from '../swarm/asteroidShape.js';

/** One of the `EDGE_*` kinds (fractureRings.ts). */
export type FractureEdgeKind = number;

/** Hard ceiling on pieces (the S2 wire carries the piece index in a u8). */
export const FRACTURE_MAX_PIECES = 64;
/** Fewest pieces a (non-snap) damage-driven fracture aims for. */
export const MIN_TARGET = 3;

export interface FractureCut {
  readonly a: Vec2;
  readonly b: Vec2;
}

export interface FractureInput {
  /** Hull outline in local coordinates, either winding; concave allowed. */
  readonly hull: ReadonlyArray<readonly [number, number]>;
  /** u32 seed (the server picks it; every client regenerates from it). */
  readonly seed: number;
  /** Where the killing blow landed, in the hull's local frame. Since v3 it
   *  is projected onto the hull outline (`projectToOutline`) before use, so
   *  a point inside the hull or out at the shield radius lands on the edge. */
  readonly killPoint: Vec2;
  /** Optional section boundaries; each is the infinite line through a→b.
   *  Section cuts are straight (bulkheads); only Voronoi cuts are jagged. */
  readonly sectionCuts?: ReadonlyArray<FractureCut>;
  /** Cap on real fragments (clamped to 1..FRACTURE_MAX_PIECES). In
   *  fixed-count mode (none of the three damage inputs below given) it is
   *  also the target count. */
  readonly maxPieces: number;
  /** Hull size in local units. Default: the farthest outline vertex from the
   *  local origin (the ship's centre). Bigger hulls break into more pieces. */
  readonly hullRadius?: number;
  /** The killing blow's damage over the ship's max hull HP, 0..1+. */
  readonly killBlowDamage?: number;
  /** Damage over the last few seconds, normalised (1 ≈ max hull HP in that
   *  window), 0..1+. A slow grind is near 0. */
  readonly recentDamageRate?: number;
  /** Chance (0..1) of a clean snap in two along the primary line instead of
   *  a shatter. Default `FRACTURE_SNAP_CHANCE`. */
  readonly snapChance?: number;
  /** v7 fan cracks from the kill point (default true). The sub-capital
   *  destruction profile turns them off: a small hull breaks along the
   *  primary crack and at most one zone crack. */
  readonly fanCracks?: boolean;
  /** The rare v7 far crack (default true; off for sub-capitals). */
  readonly farCrack?: boolean;
  /** Every piece must pass the v7 chunky guard (`FAN_MIN_WIDTH_BEAMS` wide,
   *  at most `FAN_MAX_ASPECT` long for its width), or the optional cracks are
   *  dropped one by one, like an over-cap result (default false; on for
   *  sub-capitals). The primary crack is kept, but a small concave hull
   *  needs it SOUND: where the line through the kill point would cut more
   *  than two pieces (a fighter's wingtips) or leave one under
   *  `SOUND_MIN_SHARE` of the hull, it moves toward the hull's centroid
   *  (`SOUND_SHIFTS`), and failing that runs square across the keel through
   *  the centroid. `fracturePlan` reports the unmoved line. The beam-scaled
   *  zone cracks (a capital's impact zone is a beam wide; a fighter is
   *  barely longer than its beam) are replaced by at most ONE extra crack
   *  (`extraChunkChance`) across the longer side, sized to that side. */
  readonly chunkyPieces?: boolean;
  /** With `chunkyPieces`: the chance of the one extra crack at violence 0;
   *  it rises by half of the rest at full violence. Default 0. */
  readonly extraChunkChance?: number;
  /** With `chunkyPieces`: the least piece width, in beams (default
   *  `FAN_MIN_WIDTH_BEAMS`, 0.45). The aspect guard is v7's `FAN_MAX_ASPECT`. */
  readonly chunkyMinWidthBeams?: number;
  /** With `chunkyPieces`: the least share of the hull each side of the
   *  sound primary crack must hold (default `SOUND_MIN_SHARE`, 0.15).
   *  Sub-capitals raise it so no piece is nearly the whole hull. */
  readonly soundMinShare?: number;
  /** With `chunkyPieces` (rocks): a cut kill moves like the sound primary
   *  (across a long piece), unburned: no strip. */
  readonly sweepCuts?: boolean;
  /** Structures: in place of the zone cracks, target − 1 straight cracks
   *  through the kill point (`radialCracks`), so a squarish hull shatters
   *  into wedges from the hit; the primary line stands only as a kill cut.
   *  Absent: the v7 layout (every ship and rock, unchanged). */
  readonly radialCracks?: boolean;
  /** Jagged cut edges: most midpoint-subdivision levels per edge and the
   *  displacement per level as a fraction of the sub-segment (defaults
   *  `JAG_MAX_DEPTH` 4, `JAG_ROUGHNESS` 0.22). Sub-capitals use a shorter,
   *  gentler jag, so a piece stays a handful of convex parts and a crack
   *  across a small hull doesn't swing a piece's share of the area. */
  readonly jag?: { readonly depth: number; readonly roughness: number };
  /** v9: the killing weapon's cut (absent = the normal break-up). The line
   *  runs through the kill point along (dirX, dirY) in the hull's frame (any
   *  length but zero; a zero direction means no cut). `slice`: that line is
   *  the primary crack, dead straight (v10: with a `width` over 0, the strip
   *  that wide is erased, like a channel; v13: through the kill point as given). `channel`: the strip `width` wide
   *  centred on it is erased. The secondary cracks and the piece count are
   *  the same as without a cut. */
  readonly cut?: FractureKillCut;
  /** v11: on a cut kill every piece under this share of the hull burns away
   *  (the strip's sliver erase, a crack that would leave one is dropped, a
   *  last pass after the jag); none left = vaporised. Absent: v10. */
  readonly cutBurnMinShare?: number;
  /** v12 multi-cut (owner 2026-11-15, "one cut per beam"): further straight
   *  `EDGE_CUT` lines from the other beams that burned the hull, each
   *  through its own point along its own direction; only with a `cut`. Each
   *  splits every part it crosses after the main cut's strip (a `width` over
   *  0 erases its strip through the channel code, with the same sliver
   *  erase); like the main cut they are never dropped for the piece cap,
   *  and the burn-away share applies to what is left after all of them. At
   *  most `FRACTURE_MAX_EXTRA_CUTS`. Absent: v11. */
  readonly extraCuts?: ReadonlyArray<FractureExtraCut>;
}

/** v12: one further cut line (`FractureInput.extraCuts`), hull frame: the
 *  infinite line through (x, y) along (dirX, dirY) (any length but zero);
 *  `width` over 0 erases a strip that wide centred on it. */
export interface FractureExtraCut {
  readonly x: number;
  readonly y: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly width: number;
}

/** A kill cut in the hull's frame (`FractureInput.cut`). `width`: a
 *  channel's strip; a slice with a width over 0 (v10, the heavy beam) erases
 *  a strip that wide too, with the slice's sliver slide and its `slice` kind
 *  (the client's violet tint); 0 is v9's zero-width slice line. */
export interface FractureKillCut {
  readonly kind: 'slice' | 'channel';
  readonly dirX: number;
  readonly dirY: number;
  readonly width: number;
}

/** The seeded decisions taken before any geometry (exposed for S2 and tests). */
export interface FracturePlan {
  /** True: the hull snaps cleanly in two along the primary line. */
  readonly snap: boolean;
  /** Piece count aimed for (≤ the cap; 2 when snapping). */
  readonly targetPieces: number;
  /** The primary break line: through `point` (the kill point, on the hull
   *  outline) along unit `dir`, roughly across the keel (through the hull's
   *  middle for a hit on a bow or stern tip). Null when the cap is 1. With
   *  a v9 `cut` it is the cut's line: along the shot, through the kill point
   *  (or slid toward the centroid off a sliver, for a slice). */
  readonly primary: { readonly point: Vec2; readonly dir: Vec2 } | null;
  /** The kill point the fracture uses: the input projected onto the hull
   *  outline (v3). For a side hit the primary line runs through it; for a
   *  bow or stern tip hit the line crosses the hull aft of it (v4). */
  readonly killPoint: Vec2;
}

export interface FracturePiece {
  /** CCW outline (positive shoelace area), quantised, in the hull's frame. */
  readonly outline: Vec2[];
  /** `cutEdges[i]` is the `EDGE_*` kind of edge outline[i] → outline[i+1]:
   *  `EDGE_HULL` (0, falsy) for the original hull, else a new cut that glows
   *  molten in S3 (`EDGE_CUT`: a weapon's kill cut, tinted by the weapon). */
  readonly cutEdges: FractureEdgeKind[];
  /** Convex CCW parts tiling the outline (one Rapier collider each). */
  readonly convexParts: Vec2[][];
  readonly area: number;
  readonly centroid: Vec2;
}
