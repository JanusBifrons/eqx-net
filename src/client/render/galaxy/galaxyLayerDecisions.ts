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
