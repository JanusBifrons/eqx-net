/**
 * Scrap groups for a composite ship (scrap-on-death feature, Phase 2a).
 *
 * A scrap GROUP is one ship COMPONENT — a silhouette `ShipPart` plus its
 * detail parts — the unit that becomes ONE scrap piece when the ship dies.
 * This is the SCRAP FOUNDATION: it precomputes, per ship-kind, the centroid /
 * collider / recentred sub-shapes for each component so a later sub-phase can
 * spawn + render scrap with zero geometry work at runtime. NO spawning, NO
 * rendering, NO wire emission lives here — this module is pure geometry.
 *
 * Group membership (prefix rule): a silhouette is a part with
 * `canScrap === true`; its details are the parts whose `role` starts with the
 * silhouette's `role` followed by a dash (e.g. silhouette `wing-l` owns
 * `wing-l-strip`, `wing-l-ring`, `wing-l-ring-inner`). The `role + '-'` prefix
 * is unambiguous for the Havok roles — `rear-wing-l` does NOT capture `wing-l`
 * (and vice-versa) because the prefix includes the trailing dash, and a
 * silhouette never prefix-matches another silhouette's full role.
 *
 * Coordinate convention: everything here is Pixi-up and PRE-shape-scale —
 * exactly the local coords the `ShipPart.points` carry. The overall
 * `shape.scale` is applied by CONSUMERS (read via `shipShapeScale(kind)`), so
 * `shipScrapGroups` returns pre-scale local coords (mirrors `shipHullDecomp`'s
 * pre-scale handling at the catalogue boundary).
 *
 * Precomputed ONCE at module load into a frozen per-kind `Map` (mirrors how
 * `shipHullDecomp` precomputes the convex decomposition per kind) — zero
 * per-tick / per-death allocation (invariant #14). A POLYGON kind yields a
 * frozen empty array (only composites have salvageable components).
 */

import {
  SHIP_KINDS,
  type ShipKind,
  type ShipKindId,
  type ShipPart,
} from '../../shared-types/shipKinds.js';
import { convexHull } from '../../shared-types/shipKinds/composite/equinoxTransform.js';

/** A 2-number tuple, Pixi-up local coords (pre-shape-scale). */
type Point = readonly [number, number];

/** One sub-shape of a scrap piece (a silhouette OR one of its details),
 *  recentred so the group's centroid is the local origin. */
export interface ScrapPart {
  /** Polygon points, recentred on the group centroid. */
  readonly points: ReadonlyArray<Point>;
  /** Fill colour (24-bit RGB). */
  readonly color: number;
  /** Optional outline colour (24-bit RGB). */
  readonly stroke?: number;
  /** Optional outline width in entity-local units. */
  readonly strokeWidth?: number;
}

/** One scrap group = one ship component (a silhouette + its details). Becomes
 *  a single scrap piece on death. */
export interface ScrapGroup {
  /** Arithmetic mean of the SILHOUETTE part's points (Pixi-up, pre-scale). The
   *  scrap piece's spawn position relative to the dying ship's origin. */
  readonly centroid: readonly [number, number];
  /** Convex-hull collider polygon, recentred on the group centroid (so the
   *  scrap body's collider is centred on its own origin). */
  readonly collider: ReadonlyArray<Point>;
  /** The recentred sub-shapes (silhouette first, then details) for rendering
   *  the scrap piece around its origin. */
  readonly parts: ReadonlyArray<ScrapPart>;
}

/** Arithmetic mean of a point set. */
function centroidOf(points: ReadonlyArray<Point>): readonly [number, number] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  const n = points.length;
  return [cx / n, cy / n];
}

/** Recentre a point set by subtracting the centroid. */
function recentre(
  points: ReadonlyArray<Point>,
  cx: number,
  cy: number,
): ReadonlyArray<Point> {
  return points.map(([x, y]) => [x - cx, y - cy] as Point);
}

/** A part is a silhouette (its own scrap group) iff it can be scrapped. */
function isSilhouette(part: ShipPart): boolean {
  return part.canScrap === true;
}

/** Build the scrap groups for one ship kind. Polygon kinds get an empty array
 *  (no salvageable components); composites get one group per silhouette part
 *  in catalogue order. */
function buildForKind(kind: ShipKind): readonly ScrapGroup[] {
  if (kind.shape.kind !== 'composite') {
    return Object.freeze([] as ScrapGroup[]);
  }
  const parts = kind.shape.parts;
  const groups: ScrapGroup[] = [];

  for (const silhouette of parts) {
    if (!isSilhouette(silhouette)) continue;
    const role = silhouette.role;
    // A silhouette must carry a role for prefix matching; defensively skip an
    // unrolled scrappable part rather than capture every detail.
    if (role === undefined) continue;

    const prefix = `${role}-`;
    // The silhouette's own points define the group centroid (pre-scale).
    const [cx, cy] = centroidOf(silhouette.points);

    // Collider = convex hull of the recentred silhouette points.
    const collider = Object.freeze(
      convexHull(recentre(silhouette.points, cx, cy)) as Point[],
    ) as ReadonlyArray<Point>;

    // Parts = [silhouette, ...details], each recentred on the group centroid.
    const scrapParts: ScrapPart[] = [];
    const pushPart = (p: ShipPart): void => {
      scrapParts.push(
        Object.freeze({
          points: Object.freeze(recentre(p.points, cx, cy)),
          color: p.color,
          ...(p.stroke !== undefined ? { stroke: p.stroke } : {}),
          ...(p.strokeWidth !== undefined ? { strokeWidth: p.strokeWidth } : {}),
        }) as ScrapPart,
      );
    };
    pushPart(silhouette);
    for (const detail of parts) {
      if (detail === silhouette) continue;
      if (detail.role !== undefined && detail.role.startsWith(prefix)) {
        pushPart(detail);
      }
    }

    groups.push(
      Object.freeze({
        centroid: [cx, cy] as const,
        collider,
        parts: Object.freeze(scrapParts) as ReadonlyArray<ScrapPart>,
      }) as ScrapGroup,
    );
  }

  return Object.freeze(groups) as readonly ScrapGroup[];
}

/** Frozen per-kind scrap groups, built once at module load on the frozen
 *  catalogue; key = `ShipKindId`. */
const SHIP_KIND_SCRAP_GROUPS: ReadonlyMap<ShipKindId, readonly ScrapGroup[]> =
  (() => {
    const m = new Map<ShipKindId, readonly ScrapGroup[]>();
    for (const kind of Object.values(SHIP_KINDS)) {
      m.set(kind.id, buildForKind(kind));
    }
    return m;
  })();

const EMPTY_GROUPS: readonly ScrapGroup[] = Object.freeze([] as ScrapGroup[]);

/**
 * Scrap groups for a (possibly unknown) ship kind id. A polygon kind — or an
 * unknown id — returns a frozen empty array (no salvageable components); a
 * composite kind returns one `ScrapGroup` per silhouette part, in catalogue
 * order, in PRE-shape-scale local coords.
 */
export function shipScrapGroups(
  kindId: string | null | undefined,
): readonly ScrapGroup[] {
  if (kindId == null) return EMPTY_GROUPS;
  return SHIP_KIND_SCRAP_GROUPS.get(kindId as ShipKindId) ?? EMPTY_GROUPS;
}
