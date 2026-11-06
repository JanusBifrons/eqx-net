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

/**
 * Sector space scale (capital-ship R&D round 3, 2026-11-05: "dramatically
 * increase sector sizes and everything now needs spreading out to allow room
 * for capitals to operate"). Multiplies the playable half extent AND every
 * world-placement distance (asteroid fields, base sites, gates, elite, event
 * and roam radii); ship-bound numbers (weapon ranges, flocking, pickup) do not
 * change. Read once, the same way on every side: env `EQX_SECTOR_SCALE`
 * (Node), `globalThis.__EQX_SECTOR_SCALE__` (page, from `?sectorScale=`).
 */
// 1 on main until the solar-system sectors land (plan prancy-squishing-donut
// Phase 4): the 4x spreading seams ship as a knob, today's sectors unchanged.
export const DEFAULT_SECTOR_SPACE_SCALE = 1;
function readSectorScale(): number {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> }; __EQX_SECTOR_SCALE__?: unknown };
  const raw = g.process?.env?.['EQX_SECTOR_SCALE'] ?? g.__EQX_SECTOR_SCALE__;
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 1 && n <= 16 ? n : DEFAULT_SECTOR_SPACE_SCALE;
}
export const SECTOR_SPACE_SCALE: number = readSectorScale();

/** The 1x half extent the world layouts were authored at. */
export const SECTOR_BASE_HALF_EXTENT = 5000;
export const SECTOR_PLAYABLE_HALF_EXTENT = SECTOR_BASE_HALF_EXTENT * SECTOR_SPACE_SCALE;

/** A world-placement distance authored at 1x sector space, at the current scale. */
export function sectorSpace(d: number): number {
  return d * SECTOR_SPACE_SCALE;
}

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
