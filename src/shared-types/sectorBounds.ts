/**
 * Sector playable bounds — used by both the client (input clamp on blur +
 * toast warning) and the server (defense-in-depth clamp inside
 * TransitOrchestrator.commitTransit). The two MUST agree, hence this
 * shared module.
 *
 * Today there is only a single half-extent shared by every sector —
 * GalaxySector in src/core/galaxy/galaxy.ts has no per-sector bounds.
 * If per-sector bounds become necessary later, widen the helper to take
 * a sector key and look up overrides; the constant remains the default.
 */

export const SECTOR_PLAYABLE_HALF_EXTENT = 5000;

export interface ClampResult {
  x: number;
  y: number;
  clamped: boolean;
}

export function clampToSectorBounds(x: number, y: number): ClampResult {
  const lim = SECTOR_PLAYABLE_HALF_EXTENT;
  const cx = Math.max(-lim, Math.min(lim, x));
  const cy = Math.max(-lim, Math.min(lim, y));
  return { x: cx, y: cy, clamped: cx !== x || cy !== y };
}
