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
import type { MainToWorkerMsg, WorkerToMainMsg } from './protocol';

function post(msg: WorkerToMainMsg): void {
  self.postMessage(msg);
}

let renderer: PixiRenderer | null = null;

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
        renderer.resize(msg.width, msg.height);
        break;
      }

      case 'SET_TICKER_FPS': {
        if (!renderer) return;
        renderer.setTickerMaxFPS(msg.fps);
        break;
      }

      case 'SET_VISIBLE':
      case 'SET_CURRENT_SECTOR':
      case 'SET_TRANSIT_DOCKED': {
        // GalaxyMapLayer overlay state — the overlay itself isn't yet
        // hosted worker-side. PixiRenderer's `addOverlayContainer` was
        // the original wire; revisiting in a follow-up commit once
        // App.tsx's overlay-construction is decoupled. Messages
        // accepted and discarded so the main thread can post without
        // error.
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
    }
  } catch (err) {
    post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
  }
};
