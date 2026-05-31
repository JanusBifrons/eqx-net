/**
 * Renderer Web Worker — Phase 4 final form.
 *
 * Hosts a `PixiRenderer` instance inside a Web Worker via
 * `OffscreenCanvas`. PixiRenderer is canvas-context-agnostic since the
 * 2026-05-14 refactor (commit `03ec09c`): it accepts either an
 * HTMLElement container (main-thread) or a `{ canvas, width, height,
 * dpr }` bag (worker). Same renderer code-path, same sub-managers,
 * same Camera. **No duplication.**
 *
 * Module-top: `DOMAdapter.set(WebWorkerAdapter)` is mandatory BEFORE
 * any other Pixi import is evaluated — Pixi v8 reads the adapter at
 * first `Application` constructor call.
 *
 * Forbidden imports inside this directory (CI-enforced): `react`,
 * `react-dom`, `@mui/*`, `@emotion/*`, `zustand`. The worker has no
 * DOM. State crosses the boundary via the protocol; main thread reads
 * Zustand and posts the resulting messages.
 *
 * See plan `~/.claude/plans/humble-strolling-coral.md`.
 */

import { DOMAdapter, WebWorkerAdapter } from 'pixi.js';

DOMAdapter.set(WebWorkerAdapter);

// Import PixiRenderer AFTER DOMAdapter.set so Pixi v8 picks the
// worker adapter at module-load.
import { PixiRenderer } from '../PixiRenderer';
import { GalaxyMapLayer } from '../galaxy/GalaxyMapLayer';
import type { MainToWorkerMsg, WorkerToMainMsg } from './protocol';

function post(msg: WorkerToMainMsg): void {
  self.postMessage(msg);
}

let renderer: PixiRenderer | null = null;
let galaxyLayer: GalaxyMapLayer | null = null;

/**
 * F1 (warp-spool perf — `docs/HANDOFF-warp-spool-perf-followup.md`).
 * Default OFF: production posts ZERO extra IPC. Flipped by the main
 * thread's `SET_DIAG_MARKERS` message (sent once at
 * `WorkerRendererClient.init` from `isDiagEnabled()` — `?diag=1` OR
 * `navigator.webdriver`). The cheap `performance.now()` brackets that
 * produce the numbers run unconditionally in `PixiRenderer` /
 * `BackgroundGrid` (sub-µs, uniform); only the `postMessage` below is
 * gated, so the markers-off path is the true production cost.
 */
let diagMarkersEnabled = false;

self.onmessage = async (e: MessageEvent<MainToWorkerMsg>): Promise<void> => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'BOOT': {
        renderer = new PixiRenderer();
        await renderer.init({
          canvas: msg.canvas,
          width: msg.width,
          height: msg.height,
          dpr: msg.dpr,
        });
        // Construct the in-game galaxy-map overlay worker-side. Its
        // hex `pointertap` listeners don't fire here (no Pixi event
        // system in worker context), so we drive selection via a
        // custom hit-test wired through `renderer.setOnTap`.
        galaxyLayer = new GalaxyMapLayer({ onSelect: () => { /* unused — see hitTest path */ } });
        galaxyLayer.resize(msg.width, msg.height);
        renderer.addGalaxyOverlay(galaxyLayer, (sx, sy) => {
          if (!galaxyLayer) return;
          const sectorKey = galaxyLayer.hitTest(sx, sy);
          if (sectorKey !== null) {
            post({ type: 'OVERLAY_TAPPED', sectorKey });
          }
        });
        post({ type: 'READY' });
        break;
      }

      case 'MIRROR_UPDATE': {
        if (!renderer) return;
        renderer.update(msg.mirror);
        // PixiRenderer's update() populates `feedback` at its tail.
        // Marshal the current snapshot back to the main thread —
        // structured-clone copies the Map by value so the main side
        // owns its own instance.
        const fb = renderer.getFeedback();
        post({
          type: 'FEEDBACK',
          feedback: {
            mountCounts: new Map(fb.mountCounts),
            haloArrowCount: fb.haloArrowCount,
            damageNumberActiveCount: fb.damageNumberActiveCount,
            wreckSpriteCount: fb.wreckSpriteCount,
            firstFrameRendered: fb.firstFrameRendered,
          },
        });
        // F1 — per-frame sub-cost markers. GATED: only post when
        // diagnostics are enabled, so production pays zero extra IPC
        // (the `performance.now()` brackets in PixiRenderer always run
        // — sub-µs — but this postMessage is the only real cost). Copy
        // the struct by value so the main side owns its own snapshot.
        if (diagMarkersEnabled) {
          const m = renderer.getFrameMarkers();
          post({ type: 'FRAME_MARKERS', markers: { ...m } });
        }
        break;
      }

      case 'POINTER_EVENT': {
        if (!renderer) return;
        renderer.forwardPointerEvent(msg.native);
        break;
      }

      case 'WHEEL_EVENT': {
        if (!renderer) return;
        renderer.forwardWheelEvent(msg.native.deltaY, msg.native.offsetX, msg.native.offsetY);
        break;
      }

      case 'RESIZE': {
        if (!renderer) return;
        renderer.resize(msg.width, msg.height, msg.dpr);
        galaxyLayer?.resize(msg.width, msg.height);
        break;
      }

      case 'SET_TICKER_FPS': {
        if (!renderer) return;
        renderer.setTickerMaxFPS(msg.fps);
        break;
      }

      case 'SET_WARP_MODE': {
        if (!renderer) return;
        renderer.setWarpMode(msg.active);
        break;
      }

      case 'SET_WARP_PARAMS': {
        if (!renderer) return;
        renderer.setWarpParams(msg.params);
        break;
      }

      case 'SET_WARP_CENTER': {
        if (!renderer) return;
        renderer.setWarpCenter(msg.center);
        break;
      }

      case 'SET_CAMERA_CENTER': {
        if (!renderer) return;
        renderer.setCameraCenter(msg.worldX, msg.worldY);
        break;
      }

      case 'TRIGGER_WARP_IN': {
        if (!renderer) return;
        renderer.triggerWarpIn(msg.center);
        break;
      }

      case 'SET_LOAD_CURTAIN': {
        if (!renderer) return;
        renderer.setLoadCurtain(msg.active);
        break;
      }

      case 'SET_VISIBLE': {
        galaxyLayer?.setVisible(msg.visible);
        break;
      }
      case 'SET_CURRENT_SECTOR': {
        galaxyLayer?.setCurrentSector(msg.sectorKey);
        break;
      }
      case 'SET_TRANSIT_DOCKED': {
        galaxyLayer?.setTransitDocked(msg.docked);
        break;
      }

      case 'SET_DIAG_MARKERS': {
        // F1 — flip per-frame marker emission. No renderer dependency
        // (the brackets run regardless); this only toggles the gated
        // `FRAME_MARKERS` post in the MIRROR_UPDATE handler.
        diagMarkersEnabled = msg.enabled;
        break;
      }

      case 'TRIGGER_EFFECT':
      case 'SET_EFFECT_QUALITY':
      case 'SET_EFFECT_PARAMS': {
        // Effects subsystem (plan `wiggly-puppy` M2-M9): TRIGGER_EFFECT
        // is delivered via mirror.pendingEffectTriggers (renderer drain
        // path), NOT via direct postMessage in production — sandbox-only.
        // SET_EFFECT_QUALITY / SET_EFFECT_PARAMS are sandbox-only.
        // M11 (sandbox extension) wires these directly to the worker's
        // EffectsService instance. M2 stub kept here so a pre-M11
        // worker against a post-M11 main thread doesn't throw.
        break;
      }

      case 'RESET_EFFECTS_HANDOFF': {
        renderer?.resetEffectsForSectorHandoff();
        break;
      }

      case 'DISPOSE': {
        if (renderer) {
          try {
            renderer.dispose();
          } catch {
            // Best effort — worker is about to close.
          }
          renderer = null;
        }
        self.close();
        break;
      }

      default: {
        // Default-branch warn (plan `wiggly-puppy` M2): a deployed worker
        // from before a new message variant lands will silently no-op
        // unknown types. Logging it gives partial-rollout + Vite HMR mid-
        // session visibility. The TS exhaustiveness check (compile-time)
        // remains the primary guard; this is the runtime safety net.
        // eslint-disable-next-line no-console
        console.warn('[renderer-worker] unknown msg.type', (msg as { type?: string }).type);
        break;
      }
    }
  } catch (err) {
    post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
  }
};
