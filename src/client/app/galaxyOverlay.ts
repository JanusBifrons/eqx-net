/**
 * Galaxy-overlay (Map B) bootstrap + per-frame sync helpers.
 *
 * Map B is the additive in-game galaxy overlay that lives as a
 * screen-space sibling of the gameplay viewport on the same Pixi
 * stage (so it doesn't pan/zoom with the world camera). Two
 * construction paths:
 *
 *   - Worker mode: `renderer.worker.ts` constructs the layer inside
 *     the worker (it's pure Pixi v8, no DOM access) and uses a
 *     custom hit-test for taps (Pixi's event subsystem isn't
 *     initialised in worker context). Selection is routed back to
 *     the main thread via `OVERLAY_TAPPED` messages and consumed by
 *     `setOverlayTapHandler`.
 *   - DOM mode: construct the layer here and attach via
 *     `addOverlayContainer`. The native Pixi event system on the
 *     DOM-mode renderer handles `pointertap` on each hex.
 *
 * `installGalaxyOverlay` runs once inside the GameSurface bootstrap
 * useEffect (after `renderer.init` resolves). The sync helpers
 * (`syncGalaxyVisibility` / `syncGalaxyCurrentSector` /
 * `syncGalaxyTransitDocked`) are called by per-state-change
 * useEffects in App.tsx — each routes BOTH paths
 * (`galaxyLayerRef.current` for DOM mode and
 * `WorkerRendererClient.setLayer*` postMessages for worker mode).
 */

import { GalaxyMapLayer } from '../render/galaxy/GalaxyMapLayer';
import type { GalaxyLayerMode } from '../render/galaxy/galaxyLayerDecisions';
import { WorkerRendererClient } from '../render/worker/WorkerRendererClient';
import { useUIStore } from '../state/store';
import { logEvent } from '../debug/ClientLogger';
import type { IRenderer } from '@core/contracts/IRenderer';

export interface InstallGalaxyOverlayOpts {
  renderer: IRenderer;
  useWorker: boolean;
  el: HTMLDivElement;
  onEngageTransit: (key: string) => void;
  /**
   * `overlay` (default) — the in-game additive heads-up map: taps warp
   * to a neighbour and close the overlay. `selector` — the full-screen
   * spawn/warp picker: every sector is tappable, the picker is always
   * shown, and taps route to {@link onSelectorPick} (the spawn flow)
   * instead of engaging a transit.
   */
  mode?: GalaxyLayerMode;
  /** Selector-mode tap handler (spawn picker). Required when `mode === 'selector'`. */
  onSelectorPick?: (sectorKey: string) => void;
}

/**
 * Constructs the galaxy overlay + wires its tap handler. Returns the
 * DOM-mode layer if applicable (the caller stores it in
 * `galaxyLayerRef`); returns null in worker mode (the layer lives
 * inside the worker, addressed via the renderer's setLayer* methods).
 */
export function installGalaxyOverlay(opts: InstallGalaxyOverlayOpts): GalaxyMapLayer | null {
  const { renderer, useWorker, el, onEngageTransit, mode = 'overlay', onSelectorPick } = opts;
  const s0 = useUIStore.getState();
  const selector = mode === 'selector';
  // The selector picker is always on screen; the additive overlay
  // follows the Zustand MAP-button toggle.
  const initialVisible = selector ? true : s0.isGalaxyMapOpen;
  const onTap = selector
    ? (key: string): void => { onSelectorPick?.(key); }
    : (key: string): void => {
        onEngageTransit(key);
        // Auto-close the additive overlay on warp-tap; the user explicitly
        // asked for tap-to-warp to dismiss the map (otherwise it stays
        // visible during SPOOLING and feels stuck).
        useUIStore.getState().setGalaxyMapOpen(false);
      };

  if (useWorker) {
    // The worker already owns its layer; just route taps + push
    // initial state so the overlay knows which sector is "you are
    // here" and whether it's selectable.
    (renderer as WorkerRendererClient).setOverlayTapHandler(onTap);
    (renderer as WorkerRendererClient).setLayerMode(mode);
    (renderer as WorkerRendererClient).setLayerCurrentSector(s0.currentSectorKey);
    (renderer as WorkerRendererClient).setLayerTransitDocked(s0.transitState === 'DOCKED');
    (renderer as WorkerRendererClient).setLayerVisible(initialVisible);
    return null;
  }
  const galaxyLayer = new GalaxyMapLayer({ onSelect: onTap });
  renderer.addOverlayContainer(galaxyLayer);
  galaxyLayer.setMode(mode);
  galaxyLayer.setCurrentSector(s0.currentSectorKey);
  galaxyLayer.setTransitDocked(s0.transitState === 'DOCKED');
  galaxyLayer.resize(el.clientWidth || window.innerWidth, el.clientHeight || window.innerHeight);
  galaxyLayer.setVisible(initialVisible);
  return galaxyLayer;
}

/**
 * Visibility sync — routes both the DOM-mode layer and worker-hosted
 * layer. Emits the `galaxy_map_toggle` diagnostic, which is the E2E
 * hook regression-locked by tests/e2e/galaxy-map-toggle.spec.ts (the
 * worker-hosting fix is exactly "this message now reaches the
 * worker").
 */
export function syncGalaxyVisibility(
  galaxyLayer: GalaxyMapLayer | null,
  renderer: IRenderer | null,
  open: boolean,
): void {
  galaxyLayer?.setVisible(open);
  if (renderer instanceof WorkerRendererClient) {
    renderer.setLayerVisible(open);
  }
  logEvent('galaxy_map_toggle', {
    open,
    worker: renderer instanceof WorkerRendererClient,
  });
}

export function syncGalaxyCurrentSector(
  galaxyLayer: GalaxyMapLayer | null,
  renderer: IRenderer | null,
  currentSectorKey: string | null,
): void {
  galaxyLayer?.setCurrentSector(currentSectorKey);
  if (renderer instanceof WorkerRendererClient) {
    renderer.setLayerCurrentSector(currentSectorKey);
  }
}

export function syncGalaxyTransitDocked(
  galaxyLayer: GalaxyMapLayer | null,
  renderer: IRenderer | null,
  docked: boolean,
): void {
  galaxyLayer?.setTransitDocked(docked);
  if (renderer instanceof WorkerRendererClient) {
    renderer.setLayerTransitDocked(docked);
  }
}

/**
 * Mode sync — routes both the DOM-mode layer and the worker-hosted
 * layer. `overlay` = in-game additive HUD; `selector` = full-screen
 * spawn/warp picker (single-canvas refactor). Mirrors the dual-path
 * shape of the sync helpers above.
 */
export function syncGalaxyMode(
  galaxyLayer: GalaxyMapLayer | null,
  renderer: IRenderer | null,
  mode: GalaxyLayerMode,
): void {
  galaxyLayer?.setMode(mode);
  if (renderer instanceof WorkerRendererClient) {
    renderer.setLayerMode(mode);
  }
}
