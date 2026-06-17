/**
 * Entity VISUAL LANGUAGE — the single source of truth for how each entity TYPE is
 * shown across the whole UI (galaxy-map count badges, the sector drawer, and any
 * future surface). One taxonomy: a SHAPE + COLOUR + LABEL per kind, plus pure
 * geometry so Pixi (`g.poly`) and SVG (`<polygon>`) draw the IDENTICAL badge.
 *
 * Render-agnostic + worker-safe: NO React / DOM / Pixi imports here, so the
 * worker-hosted `GalaxyMapLayer` and the React `EntityBadge` can both import it.
 * When a new entity type needs an icon, add it HERE and every surface inherits it.
 */

export type EntityKind = 'hostile' | 'neutral' | 'ship' | 'structure';
export type EntityShape = 'star' | 'diamond' | 'triangle' | 'hexagon';

export interface EntityVisual {
  readonly kind: EntityKind;
  readonly shape: EntityShape;
  /** 0xRRGGBB — for Pixi fills. */
  readonly color: number;
  /** CSS hex — for SVG / DOM. */
  readonly cssColor: string;
  /** Singular noun, e.g. 'hostile'. */
  readonly singular: string;
  /** Plural noun, e.g. 'hostiles'. */
  readonly plural: string;
  /**
   * The knockout NUMBER's y, as a FRACTION of the badge radius, so it reads
   * CENTRED in the shape. Positive = down. Two things fold in: (1) a small
   * baseline nudge — text ink sits slightly high — and (2) the shape's optical
   * centre: symmetric shapes (diamond/hexagon) want only the baseline nudge
   * (~0.1), but a star and especially an up-triangle carry their visual mass LOW
   * (wide base), so the number must drop further toward the centroid to look
   * centred. Tuned via the standalone SVG offset sweep (diag probe). Used as-is by
   * both the SVG badge and the Pixi map badge.
   */
  readonly numCenterYFrac: number;
}

/** Backdrop colour the knockout number is drawn in (so it reads as CUT OUT of the
 *  solid badge). Matches the galaxy map's opaque backdrop. */
export const ENTITY_BADGE_KNOCKOUT = 0x05070d;
export const ENTITY_BADGE_KNOCKOUT_CSS = '#05070d';

export const ENTITY_VISUALS: Record<EntityKind, EntityVisual> = {
  hostile: {
    kind: 'hostile', shape: 'star', color: 0xff6b6b, cssColor: '#ff6b6b',
    singular: 'hostile', plural: 'hostiles', numCenterYFrac: 0.18,
  },
  neutral: {
    kind: 'neutral', shape: 'diamond', color: 0xffd479, cssColor: '#ffd479',
    singular: 'neutral drone', plural: 'neutral drones', numCenterYFrac: 0.1,
  },
  ship: {
    kind: 'ship', shape: 'triangle', color: 0x6bff9b, cssColor: '#6bff9b',
    singular: 'ship', plural: 'ships', numCenterYFrac: 0.3,
  },
  structure: {
    kind: 'structure', shape: 'hexagon', color: 0x9ab4dd, cssColor: '#9ab4dd',
    singular: 'structure', plural: 'structures', numCenterYFrac: 0.1,
  },
};

/** Display order for a multi-kind readout (galaxy badge row + drawer breakdown). */
export const ENTITY_KIND_ORDER: readonly EntityKind[] = ['hostile', 'neutral', 'ship', 'structure'];

/** Conditional plural label, e.g. `entityLabel('ship', 1)` → 'ship', `(…, 2)` → 'ships'. */
export function entityLabel(kind: EntityKind, count: number): string {
  const v = ENTITY_VISUALS[kind];
  return count === 1 ? v.singular : v.plural;
}

/**
 * Filled-badge polygon for `shape`, with its bounding box CENTRED at (0,0) and
 * extent `r`. Returns a flat `number[]` (x0,y0,x1,y1,…): feed straight to Pixi
 * `g.poly(pts)`, or pair up for an SVG `<polygon points>`. Bbox-centring (not
 * centroid) is deliberate — a number at (0,0) then reads as centred.
 */
export function entityBadgePolygon(shape: EntityShape, r: number): number[] {
  switch (shape) {
    case 'diamond':
      return [0, -r, r, 0, 0, r, -r, 0];
    case 'triangle':
      return [0, -r, r * 0.95, r, -r * 0.95, r]; // apex up; bbox [-r, r]
    case 'hexagon': {
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        pts.push(Math.cos(a) * r, Math.sin(a) * r);
      }
      return pts;
    }
    case 'star': {
      // 5-point star shifted down so its bbox is vertically centred at (0,0).
      const pts: number[] = [];
      const yShift = r * 0.095;
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 === 0 ? r : r * 0.45;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        pts.push(Math.cos(a) * rr, Math.sin(a) * rr + yShift);
      }
      return pts;
    }
  }
}
