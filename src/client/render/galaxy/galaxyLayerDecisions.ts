import { isNeighbour } from '@core/galaxy/galaxy';

/**
 * Pure decision helpers for {@link GalaxyMapLayer} (Phase A3 idiom — the
 * branching lives here, unit-tested; the Pixi calls stay in the layer).
 *
 * The single galaxy layer plays two roles on the ONE shared canvas
 * (single-canvas refactor, 2026-06-05):
 *
 *  - `overlay`  — the in-game additive Map-B heads-up overlay. Highly
 *                 transparent, screen-space, only the **docked
 *                 neighbours** of the current sector are tappable.
 *  - `selector` — the spawn / warp picker (Map-A's former role). Full
 *                 screen, **every** sector tappable.
 */
export type GalaxyLayerMode = 'overlay' | 'selector';

/**
 * Is `sectorKey` a tappable destination given the current mode/state?
 *
 * - `selector`: every sector is pickable (the spawn/warp picker). A
 *   limbo restriction (single resumable sector) is layered on at the
 *   call site in a later step, not here.
 * - `overlay`: only the current sector's neighbours, and only while
 *   docked (you can't engage a new transit mid-warp).
 */
export function isSectorSelectable(args: {
  mode: GalaxyLayerMode;
  docked: boolean;
  currentSectorKey: string | null;
  sectorKey: string;
}): boolean {
  if (args.mode === 'selector') return true;
  if (!args.docked) return false;
  if (!args.currentSectorKey) return false;
  return isNeighbour(args.currentSectorKey, args.sectorKey);
}

/**
 * Fraction of the smaller viewport dimension the hex cluster fills.
 * The overlay is a small additive HUD (keeps gameplay visible around
 * it); the selector is a full-screen picker.
 */
export function clusterFitFraction(mode: GalaxyLayerMode): number {
  return mode === 'selector' ? 0.85 : 0.6;
}

/** The tuned per-territory hover-shrink target (eqx-peri's proven 6% shrink). */
export const HOVER_SHRINK_SCALE = 0.94;

/**
 * Phase 3 (#1) — the per-territory hover-shrink target scale.
 *
 * The contiguous-territory hover-shrink "breathes" a region toward its centroid
 * when it's the active (pointer-hovered / current-sector) territory. The active
 * territory eases toward {@link HOVER_SHRINK_SCALE}; every other eases back to
 * 1.0.
 *
 * BUT when the whole galaxy is a SINGLE territory (the default — every sector
 * NEUTRAL, no capture mechanics yet), shrinking the sole territory shrinks the
 * ENTIRE map under the pointer. There's nothing to contrast it against, so it
 * reads as a janky global flinch on every hover (the bug report). The gate:
 * only shrink when there are 2+ territories to differentiate. With one (or
 * zero) territory the target is 1.0 — no shrink. Pure; unit-locked.
 *
 * POSITIONAL SCALAR args (no object literal) — this is called per-territory
 * per-frame from `GalaxyMapLayer.tick` (registered on `Ticker.shared`), so an
 * object-literal arg allocated in the hot loop (invariant #14). The caller
 * passes scalars: `hoverShrinkTargetScale(i === active, territoryCount)`.
 */
export function hoverShrinkTargetScale(isActive: boolean, territoryCount: number): number {
  if (territoryCount <= 1) return 1;
  return isActive ? HOVER_SHRINK_SCALE : 1;
}

/**
 * Equinox Phase 7 (Item 1) — is `sectorKey` a WARPABLE destination from the
 * player's current sector? True only for a DOCKED player's direct galaxy-graph
 * NEIGHBOUR. Drives the in-game full-page map's "warpable" neighbour highlight +
 * the popover's "Warp here" CTA gating. The server re-validates adjacency on the
 * wire (`engage_transit`), so this is UI-only. Distinct from
 * {@link isSectorSelectable}: in the unified map EVERY sector is tappable for its
 * info popover (omnipotent view), but only neighbours are warp targets.
 */
export function isSectorWarpable(args: {
  docked: boolean;
  currentSectorKey: string | null;
  sectorKey: string;
}): boolean {
  if (!args.docked) return false;
  if (!args.currentSectorKey) return false;
  if (args.sectorKey === args.currentSectorKey) return false;
  return isNeighbour(args.currentSectorKey, args.sectorKey);
}
