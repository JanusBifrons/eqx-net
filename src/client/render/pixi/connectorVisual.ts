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

/** Preview-line tints for the placement connection preview (Item C). Green ⇒
 *  the ghost WOULD connect here on placement; dim red ⇒ in range but the line
 *  of sight is blocked (asteroid / structure on the segment). Out-of-range
 *  segments are not drawn at all (skipped), so they need no colour. */
export const PREVIEW_OK_COLOR = 0x66ff88;
export const PREVIEW_BLOCKED_COLOR = 0xcc4444;

/** A placement-preview segment's outcome, mirroring `canConnect`'s result
 *  partition collapsed to what the preview draws. */
export type PreviewLineKind = 'ok' | 'blocked' | 'skip';

/**
 * Pure visual params for ONE placement-preview segment (ghost → existing
 * structure). Mirrors `connectorVisualParams` (scale-aware line width) but keyed
 * off the `canConnect` outcome rather than a flash window:
 *   - `ok`      → solid green (would connect)
 *   - `blocked` → dim/dashed-feel red (in range, LOS blocked)
 *   - `skip`    → alpha 0 (caller should not draw — out of range / ineligible)
 */
export function previewLineVisualParams(kind: PreviewLineKind, scale: number): ConnectorVisual {
  const safeScale = scale > 0 ? scale : 1;
  if (kind === 'ok') {
    const width = Math.max(1 / safeScale, 2);
    return {
      color: PREVIEW_OK_COLOR,
      alpha: 0.85,
      width,
      glowAlpha: 0.25,
      glowWidth: width * 3,
    };
  }
  if (kind === 'blocked') {
    return {
      color: PREVIEW_BLOCKED_COLOR,
      alpha: 0.4,
      width: Math.max(1 / safeScale, 1),
      glowAlpha: 0,
      glowWidth: 0,
    };
  }
  // skip — not drawn.
  return { color: PREVIEW_OK_COLOR, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 };
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
