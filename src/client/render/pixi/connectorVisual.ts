/**
 * Pure visual-params for a grid connection segment (speed-dial-resource-
 * structures plan, Phase 3). Ported from eqx-peri's `ConnectionRenderer` visual
 * model: an idle muted-blue line that brightens (alpha/width pulse + glow) when
 * it carried flow this pulse, fading over `FLASH_DURATION_MS`. eqx-peri uses no
 * travelling-dash, so neither do we.
 *
 * Zone-pure (no Pixi import) so the maths is unit-testable; the Graphics drawing
 * lives in `ConnectorRenderer.ts`.
 */
import { FLASH_DURATION_MS } from '../../../core/structures/structureGridConstants.js';

/** Idle (non-flowing) line tint — muted blue. */
export const CONNECTOR_IDLE_COLOR = 0x4488aa;
/** Mineral-flow tint (the single Phase-3 flow material). */
export const CONNECTOR_MINERAL_COLOR = 0xee8844;
/** Power-flow tint (reserved — power is aggregated, not flashed, in Phase 3). */
export const CONNECTOR_POWER_COLOR = 0x44ddff;

export interface ConnectorVisual {
  color: number;
  alpha: number;
  width: number;
  /** Glow overlay alpha (0 ⇒ no glow). */
  glowAlpha: number;
  /** Glow overlay width. */
  glowWidth: number;
}

/**
 * Visual params for a connection given its flash window. `scale` is the
 * viewport zoom (line widths are kept ≥ 1 device px by dividing by scale).
 */
export function connectorVisualParams(
  flashUntilMs: number,
  nowMs: number,
  scale: number,
): ConnectorVisual {
  const safeScale = scale > 0 ? scale : 1;
  if (nowMs >= flashUntilMs) {
    return {
      color: CONNECTOR_IDLE_COLOR,
      alpha: 0.3,
      width: Math.max(1 / safeScale, 1),
      glowAlpha: 0,
      glowWidth: 0,
    };
  }
  // flashProgress 0 (just flashed) → 1 (about to go idle).
  const flashProgress = Math.min(1, Math.max(0, 1 - (flashUntilMs - nowMs) / FLASH_DURATION_MS));
  const width = Math.max(1 / safeScale, 2.5);
  return {
    color: CONNECTOR_MINERAL_COLOR,
    alpha: 0.9 - flashProgress * 0.5,
    width,
    glowAlpha: (1 - flashProgress) * 0.3,
    glowWidth: width * 3,
  };
}
