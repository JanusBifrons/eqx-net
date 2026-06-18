/**
 * Pixi `Graphics` painting for the halo radar markers. Extracted from the
 * monolithic `HaloRadar.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 7).
 *
 * Equinox Tweaks Phase 2 (#4) — the ring used to draw a faint translucent
 * triangle for EVERYTHING (the "almost entirely broken arrows" the user meant);
 * it now draws the shared entity VISUAL LANGUAGE glyph per kind
 * (`src/client/render/entityVisuals.ts`: hostile ★ red, neutral ◆ amber, ship ▲
 * green, structure ⬢ blue) so the ring matches the galaxy map and hostile vs
 * neutral is obvious at a glance. The marker sits at the bearing position on the
 * ring (position encodes direction), drawn UPRIGHT — no rotating needle.
 */

import { Graphics } from 'pixi.js';
import {
  ENTITY_VISUALS,
  entityBadgePolygon,
  type EntityKind,
} from '../entityVisuals.js';

/** Marker glyph radius (screen px, before the per-arrow projection scale). A
 *  grouped wedge representative (N entities at one bearing) draws a touch larger
 *  so an aggregated group reads heavier than a single contact. */
const GLYPH_RADIUS = 7;
const GLYPH_RADIUS_GROUPED = 9;

// Glow under the glyph. Hostile (★) gets a brighter, larger red menace ring;
// everything else a subtle ring tinted by its own colour.
const GLOW_COLOR_HOSTILE = 0xff5566;
const GLOW_RADIUS_HOSTILE = 11;
const GLOW_ALPHA_HOSTILE = 0.4;
const GLOW_RADIUS_DEFAULT = 7;
const GLOW_ALPHA_DEFAULT = 0.18;

// The glyph is mostly-opaque so it reads as a solid blip (the old 0.5 fill was
// half the "broken / invisible" complaint); the white stroke crisps the edge.
const GLYPH_FILL_ALPHA = 0.92;
const STROKE_ALPHA = 0.85;

/** Paint a ring marker for `kind` into `g` (clears first). Upright; the ring
 *  position carries the bearing. Hostile gets a stronger glow + stroke. */
export function paintHaloGlyph(g: Graphics, kind: EntityKind, grouped: boolean): void {
  g.clear();
  const v = ENTITY_VISUALS[kind];
  const hostile = kind === 'hostile';

  const glowColor = hostile ? GLOW_COLOR_HOSTILE : v.color;
  const glowRadius = (hostile ? GLOW_RADIUS_HOSTILE : GLOW_RADIUS_DEFAULT) * (grouped ? 1.25 : 1);
  const glowAlpha = hostile ? GLOW_ALPHA_HOSTILE : GLOW_ALPHA_DEFAULT;
  g.circle(0, 0, glowRadius);
  g.fill({ color: glowColor, alpha: glowAlpha });

  const r = grouped ? GLYPH_RADIUS_GROUPED : GLYPH_RADIUS;
  const poly = entityBadgePolygon(v.shape, r);
  g.poly(poly);
  g.fill({ color: v.color, alpha: GLYPH_FILL_ALPHA });
  g.poly(poly);
  g.stroke({ color: 0xffffff, width: hostile ? 1.4 : 1, alpha: STROKE_ALPHA });
}

export function buildHaloGlyph(kind: EntityKind, grouped: boolean): Graphics {
  const g = new Graphics();
  paintHaloGlyph(g, kind, grouped);
  return g;
}

/**
 * Map a swarm entity's pose-core `kind` byte (+ hostility) to the radar's
 * visual-language kind, or `null` when the entity must NOT show on the ring
 * (Equinox Tweaks Phase 2 #4). Pure + unit-locked so the include/exclude policy
 * is explicit:
 *   - 0 asteroid → null (excluded)
 *   - 1 drone    → hostile ? 'hostile' : 'neutral'
 *   - 2 structure→ 'structure'
 *   - 3 scrap    → null (excluded)
 *   - other      → null
 * (Remote PLAYER ships are 'ship' via a separate path; lingering hulls are never
 * iterated, so both are handled outside this helper.)
 */
export function haloContactKind(swarmKind: number, hostile: boolean): EntityKind | null {
  switch (swarmKind) {
    case 1:
      return hostile ? 'hostile' : 'neutral';
    case 2:
      return 'structure';
    default:
      return null;
  }
}
