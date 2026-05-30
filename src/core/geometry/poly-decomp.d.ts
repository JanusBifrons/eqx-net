/**
 * Type shim for the `poly-decomp` NPM package (MIT, ~3 KB, port of Mark
 * Bayazit's convex decomposition algorithm). The package ships a single
 * CommonJS file with no bundled `.d.ts` (last released 2019, still depended
 * on by p2.js, no maintained `@types/poly-decomp` exists).
 *
 * Only the functions we actually call are declared here. If a future
 * consumer needs `isSimple` / `removeDuplicatePoints`, add the signature
 * before importing — `noImplicitAny` will refuse silently-untyped calls.
 *
 * Vertex tuples are `[number, number]` (NOT `Vec2`) because the
 * underlying algorithm operates on indexed arrays directly. Conversion
 * to / from our `Vec2` happens at the call site in `shipHullDecomp.ts`.
 */
declare module 'poly-decomp' {
  type Point = [number, number];
  type Polygon = Point[];

  /** Bayazit's quick convex decomposition. Deterministic for fixed input.
   *  Input must be a simple polygon (no self-intersection) wound CCW
   *  (call `makeCCW` first). Returns an array of convex sub-polygons that
   *  exactly tile the original. */
  export function quickDecomp(polygon: Polygon): Polygon[];

  /** Hertel-Mehlhorn decomposition. Slower but emits fewer pieces in
   *  some cases. Same input contract as `quickDecomp`. */
  export function decomp(polygon: Polygon): Polygon[];

  /** Re-orients the polygon to CCW in-place. Mutates `polygon`. */
  export function makeCCW(polygon: Polygon): void;

  /** Removes vertices whose adjacent edges are collinear within
   *  `thresholdAngle` (radians). Mutates `polygon`; returns the number of
   *  vertices removed. */
  export function removeCollinearPoints(polygon: Polygon, thresholdAngle?: number): number;

  /** Checks whether a polygon has no self-intersections. Read-only. */
  export function isSimple(polygon: Polygon): boolean;

  /** Removes consecutive duplicate vertices in-place. Mutates `polygon`;
   *  returns the number removed. */
  export function removeDuplicatePoints(polygon: Polygon, precision?: number): number;
}
