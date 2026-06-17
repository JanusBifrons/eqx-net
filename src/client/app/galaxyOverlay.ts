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
import { isTouchDevice } from '../input/TouchInput';
import { useUIStore } from '../state/store';
import { logEvent } from '../debug/ClientLogger';
import type { IRenderer } from '@core/contracts/IRenderer';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import type { SectorPresence } from '../../shared-types/galaxyPresence.js';

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
  /**
   * Selector-mode BLUR/deselect — a confirmed tap that hit no hex (empty space).
   * The host closes the SectorInfoDrawer (Equinox Phase 9: "making a selection
   * which isn't a sector should deselect"). Routed through the SAME tap channel
   * as {@link onSelectorPick} on both render paths (DOM `onDeselect`; worker
   * `OVERLAY_TAPPED` with `sectorKey: null`).
   */
  onSelectorDeselect?: () => void;
  /**
   * Idle (landing-screen) context — the selector picker IS the whole screen, so
   * it's force-visible. When false (in-game), even a `selector`-mode map follows
   * the `isGalaxyMapOpen` toggle so it installs HIDDEN and never auto-opens over
   * the game (Equinox Phase 8 Bug 2: the in-game warp map uses `selector` mode
   * and so was wrongly force-visible, "reappearing" over the game after a spawn).
   */
  idle?: boolean;
}

/**
 * Constructs the galaxy overlay + wires its tap handler. Returns the
 * DOM-mode layer if applicable (the caller stores it in
 * `galaxyLayerRef`); returns null in worker mode (the layer lives
 * inside the worker, addressed via the renderer's setLayer* methods).
 */
export function installGalaxyOverlay(opts: InstallGalaxyOverlayOpts): GalaxyMapLayer | null {
  const { renderer, useWorker, el, onEngageTransit, mode = 'overlay', onSelectorPick, onSelectorDeselect, idle = false } = opts;
  const s0 = useUIStore.getState();
  const selector = mode === 'selector';
  // Force-visible ONLY on the landing screen (idle), where the picker IS the
  // whole screen. In-game, even a selector-mode map follows the MAP-button
  // toggle so it installs hidden and never auto-opens over the game (Bug 2).
  const initialVisible = idle ? true : s0.isGalaxyMapOpen;
  // `key === null` = an empty-space tap (blur). Selector → deselect; overlay
  // HUD → no-op (Equinox Phase 9).
  const onTap = selector
    ? (key: string | null): void => {
        if (key === null) onSelectorDeselect?.();
        else onSelectorPick?.(key);
      }
    : (key: string | null): void => {
        if (key === null) return;
        onEngageTransit(key);
        // Auto-close the additive overlay on warp-tap; the user explicitly
        // asked for tap-to-warp to dismiss the map (otherwise it stays
        // visible during SPOOLING and feels stuck).
        useUIStore.getState().setGalaxyMapOpen(false);
      };

  // Living Galaxy Phase 6 — desktop hover affordance on the spawn/warp picker:
  // the worker (or DOM layer) emits a DEDUPED hover (only when the sector under
  // the pointer changes), and we set the canvas cursor + the React tooltip
  // anchor here. Selector-only — the in-game overlay is not a hover surface.
  const onHover = selector
    ? (ev: { sectorKey: string | null; screenX: number; screenY: number; selectable: boolean }): void => {
        el.style.cursor = ev.selectable ? 'pointer' : 'default';
        useUIStore.getState().setGalaxyHover(
          ev.sectorKey ? { sectorKey: ev.sectorKey, left: ev.screenX, top: ev.screenY } : null,
        );
      }
    : undefined;

  // DEV/E2E hook: the hovered sector key (main-side, set by `onHover` above —
  // works for BOTH render paths since it reads the Zustand mirror). Guarded so
  // the module is import-safe in the node unit-test env (no `window`).
  if (typeof window !== 'undefined') {
    (window as unknown as { __eqxGalaxyHoveredSector?: () => string | null })
      .__eqxGalaxyHoveredSector = () => useUIStore.getState().galaxyHover?.sectorKey ?? null;
    // DEV/E2E hook (Equinox Phase 9) — inject a `/galaxy/snapshot` slice so a spec
    // can drive the recent-combat hex glyph + the drawer's counts/recent-activity
    // deterministically (a real recentCombat needs a kill in that sector). The
    // ~4 s poll overwrites it, so callers screenshot/assert promptly. Cosmetic,
    // display-only state — mirrors the existing `__eqxGalaxyPick` hook.
    (window as unknown as { __eqxSetGalaxyStats?: (s: SectorLiveState[]) => void })
      .__eqxSetGalaxyStats = (s: SectorLiveState[]) => useUIStore.getState().setGalaxyStats(s);
  }

  if (useWorker) {
    // The worker already owns its layer; just route taps + push
    // initial state so the overlay knows which sector is "you are
    // here" and whether it's selectable.
    (renderer as WorkerRendererClient).setOverlayTapHandler(onTap);
    (renderer as WorkerRendererClient).setGalaxyHoverHandler(onHover ?? null);
    (renderer as WorkerRendererClient).setLayerMode(mode);
    (renderer as WorkerRendererClient).setLayerCurrentSector(s0.currentSectorKey);
    (renderer as WorkerRendererClient).setLayerTransitDocked(s0.transitState === 'DOCKED');
    (renderer as WorkerRendererClient).setLayerVisible(initialVisible);
    return null;
  }
  const galaxyLayer = new GalaxyMapLayer({
    isTouch: isTouchDevice(),
    onSelect: (key) => onTap(key),
    onDeselect: () => onTap(null),
    onHover,
  });
  // DEV/E2E hook: expose the REAL drawn pan/zoom transform (clusterRoot), so
  // a spec can assert pan/zoom actually moved the rendered map rather than
  // recomputing from inputs (the `data-beam-from` tautology lesson). Main-
  // thread (DOM) path only; the worker hosts its own layer.
  (window as unknown as { __eqxGalaxyTransform?: () => { x: number; y: number; scale: number } })
    .__eqxGalaxyTransform = () => galaxyLayer.getDebugTransform();
  // DEV/E2E hook (Living Galaxy P4a): the REAL drawn per-territory shrink scale
  // (factionId → clusterRoot sub-container scale.x), so a spec can assert the
  // hovered contiguous territory shrinks as one unit. Main-thread (DOM) path only.
  (window as unknown as { __eqxGalaxyTerritoryScale?: () => Record<string, number> })
    .__eqxGalaxyTerritoryScale = () => galaxyLayer.getDebugTerritoryScales();
  // DEV/E2E hook (Equinox Phase 9) — inject per-sector OWNED presence (ships +
  // structures) so a spec/probe can render the ▲/⬢ count badges deterministically
  // (the real data needs a logged-in player with ships/structures). Main-thread
  // (DOM) path only; mirrors `__eqxSetGalaxyStats` for the global ★/◆ counts.
  (window as unknown as { __eqxSetGalaxyPresence?: (p: SectorPresence[]) => void })
    .__eqxSetGalaxyPresence = (p: SectorPresence[]) => galaxyLayer.setPlayerPresence(p);
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

/**
 * Live per-sector stats sync (Phase 4b) — routes BOTH the DOM-mode layer and the
 * worker-hosted layer. Stats are polled by `useGalaxyStats` (GET /galaxy/snapshot)
 * and pushed through here whenever the store slice changes.
 */
export function syncGalaxyStats(
  galaxyLayer: GalaxyMapLayer | null,
  renderer: IRenderer | null,
  stats: SectorLiveState[],
): void {
  galaxyLayer?.setGalaxyStats(stats);
  if (renderer instanceof WorkerRendererClient) {
    renderer.setLayerGalaxyStats(stats);
  }
}

/**
 * Per-player presence sync (Equinox Phase 7) — routes BOTH the DOM-mode layer
 * and the worker-hosted layer, mirroring {@link syncGalaxyStats}. `presence` is
 * the MERGED per-sector view (the logged-in player's ships + owned structures),
 * built in App.tsx from the roster + GET /galaxy/presence.
 */
export function syncGalaxyPresence(
  galaxyLayer: GalaxyMapLayer | null,
  renderer: IRenderer | null,
  presence: SectorPresence[],
): void {
  galaxyLayer?.setPlayerPresence(presence);
  if (renderer instanceof WorkerRendererClient) {
    renderer.setLayerPlayerPresence(presence);
  }
}
