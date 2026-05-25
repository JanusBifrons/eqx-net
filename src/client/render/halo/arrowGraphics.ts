/**
 * Pixi `Graphics` painting for halo radar arrows. Extracted from the
 * monolithic `HaloRadar.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 7). The orchestrator owns
 * the per-arrow `ArrowEntry` lifecycle; this module is the paint helpers
 * (pure-ish — mutates the passed Graphics, no module-level state).
 */

import { Graphics } from 'pixi.js';

// Entity-tint tokens.
export const ASTEROID_COLOR = 0x886644;
export const DRONE_HOSTILE_COLOR = 0xff3344;
export const DRONE_IDLE_COLOR = 0xf0c040;
export const REMOTE_SHIP_COLOR = 0x00aaff;

// Glow tokens. All arrows get a soft glow under the triangle; hostile
// drones get a brighter, larger menace ring tinted toward red. Phase H —
// glow radii shrunk to match the smaller polygon.
const GLOW_COLOR_HOSTILE = 0xff5566;
const GLOW_RADIUS_HOSTILE = 8;
const GLOW_ALPHA_HOSTILE = 0.35;
const GLOW_RADIUS_DEFAULT = 5;
const GLOW_ALPHA_DEFAULT = 0.15;

// Phase I — arrow fill is genuinely transparent now. 0.70 (Phase G) was
// still close to opaque; 0.50 reads as a translucent overlay marker,
// which was the original brief.
const ARROW_FILL_ALPHA = 0.50;
// Stroke alphas dropped in lockstep so the white border doesn't make
// the (now-transparent) fill look stamped onto a solid card.
const STROKE_ALPHA_DEFAULT = 0.25;
const STROKE_ALPHA_HOSTILE = 0.65;

// Two arrow silhouettes — needle-thin for singleton entities (precise
// direction signal), wider/blunter for wedge representatives (aggregated-
// area signal). Phase H — pushed the singleton further toward "needle"
// because motion + bearing already carry direction, the shape can be
// minimal. After `rotation = -theta` the nose points along the world
// bearing to the POI.
const ARROW_POLY_SINGLETON = [
  { x: 7, y: 0 },
  { x: -3, y: -1.5 },
  { x: -3, y: 1.5 },
];
const ARROW_POLY_GROUPED = [
  { x: 5, y: 0 },
  { x: -3, y: -4 },
  { x: -3, y: 4 },
];

export function paintArrowGfx(g: Graphics, color: number, hostile: boolean, grouped: boolean): void {
  g.clear();
  // Phase G — every arrow gets a soft glow under the triangle. Hostile
  // entries take a larger menace ring tinted red; everything else gets a
  // subtle ring tinted by the arrow's own colour.
  const glowColor = hostile ? GLOW_COLOR_HOSTILE : color;
  const glowRadius = hostile ? GLOW_RADIUS_HOSTILE : GLOW_RADIUS_DEFAULT;
  const glowAlpha = hostile ? GLOW_ALPHA_HOSTILE : GLOW_ALPHA_DEFAULT;
  g.circle(0, 0, glowRadius);
  g.fill({ color: glowColor, alpha: glowAlpha });

  const poly = grouped ? ARROW_POLY_GROUPED : ARROW_POLY_SINGLETON;
  g.poly(poly);
  g.fill({ color, alpha: ARROW_FILL_ALPHA });
  g.poly(poly);
  g.stroke({
    color: 0xffffff,
    width: hostile ? 1.4 : 1,
    alpha: hostile ? STROKE_ALPHA_HOSTILE : STROKE_ALPHA_DEFAULT,
  });
}

export function buildArrowGfx(color: number, hostile: boolean, grouped: boolean): Graphics {
  const g = new Graphics();
  paintArrowGfx(g, color, hostile, grouped);
  return g;
}
