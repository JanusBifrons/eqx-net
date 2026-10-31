/**
 * Pixi `Graphics` painting for radar icons + the contact → category mapping.
 *
 * Plan sparkling-wondering-rose (Wave 2): icons are painted ONCE at a fixed
 * base diameter (`GLYPH_BASE_DIAMETER`) in the category's configured shape +
 * colour; the per-frame distance-derived size and opacity are applied through
 * the Graphics' `scale` + `alpha`, so a glyph is only repainted when its shape,
 * colour or glow changes (bounded cost — never per frame). Upright: the icon's
 * POSITION on the edge track carries the bearing.
 */

import { Graphics } from 'pixi.js';
import { entityBadgePolygon } from '../entityVisuals.js';
import type { RadarCategory, RadarShape } from '../../../shared-types/settings/radar.js';

/** Diameter (CSS px) the glyph is painted at; `scale = sizePx / BASE`. */
export const GLYPH_BASE_DIAMETER = 12;
const GLYPH_BASE_RADIUS = GLYPH_BASE_DIAMETER / 2;

/** Grouped wedge representatives (N contacts at one bearing) draw this much
 *  larger so an aggregate reads heavier than a single contact. */
export const GROUPED_SIZE_MUL = 1.25;

const GLOW_COLOR_HOSTILE = 0xff5566;
const GLOW_ALPHA = 0.28;
const OUTLINE_COLOR = 0x05070d; // dark outline: contrast on bright backgrounds
const OUTLINE_ALPHA = 0.7;
const OUTLINE_WIDTH = 1.4; // at base size; ≥ ~0.7 px at the smallest icon

/** Paint a radar icon (clears first). */
export function paintRadarGlyph(g: Graphics, shape: RadarShape, color: number, glow: boolean): void {
  g.clear();
  if (glow) {
    g.circle(0, 0, GLYPH_BASE_RADIUS * 1.6);
    g.fill({ color: GLOW_COLOR_HOSTILE, alpha: GLOW_ALPHA });
  }
  const r = GLYPH_BASE_RADIUS;
  if (shape === 'circle') {
    g.circle(0, 0, r);
  } else if (shape === 'square') {
    const s = r * 0.85;
    g.rect(-s, -s, 2 * s, 2 * s);
  } else {
    g.poly(entityBadgePolygon(shape, r));
  }
  g.fill({ color, alpha: 1 });
  if (shape === 'circle') g.circle(0, 0, r);
  else if (shape === 'square') { const s = r * 0.85; g.rect(-s, -s, 2 * s, 2 * s); }
  else g.poly(entityBadgePolygon(shape, r));
  g.stroke({ color: OUTLINE_COLOR, width: OUTLINE_WIDTH, alpha: OUTLINE_ALPHA });
}

export function buildRadarGlyph(shape: RadarShape, color: number, glow: boolean): Graphics {
  const g = new Graphics();
  paintRadarGlyph(g, shape, color, glow);
  return g;
}

/**
 * Map a swarm entity's pose-core `kind` byte (+ hostility to the local player)
 * to its radar category. Pure + unit-locked. Whether the category is SHOWN is a
 * per-player preference (`RadarPrefs.categories[cat].enabled`), not this map.
 *   - 0 asteroid → 'asteroid'
 *   - 1 drone    → hostile ? 'hostile' : 'neutral'
 *   - 2 structure→ 'structure'
 *   - 3 scrap    → 'scrap'
 *   - other      → null (unknown kinds never show)
 * Remote player ships are 'player' and lingering hulls 'lingering' via their own
 * mirror maps.
 */
export function radarCategoryForSwarm(swarmKind: number, hostile: boolean): RadarCategory | null {
  switch (swarmKind) {
    case 0:
      return 'asteroid';
    case 1:
      return hostile ? 'hostile' : 'neutral';
    case 2:
      return 'structure';
    case 3:
      return 'scrap';
    default:
      return null;
  }
}
