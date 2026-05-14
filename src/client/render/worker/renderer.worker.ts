/**
 * Renderer Web Worker — Phase 3 skeleton.
 *
 * At end of Phase 3 this worker is dead code: it boots, emits READY,
 * logs everything else. Phase 4 absorbs the body of
 * `src/client/render/PixiRenderer.ts` into this file (with the
 * hand-rolled `Camera` class replacing pixi-viewport).
 *
 * Module-top: `DOMAdapter.set(WebWorkerAdapter)` is mandatory BEFORE
 * any other Pixi import is evaluated — Pixi v8 reads the adapter at
 * first `Application` constructor call, so a late `set` lands too
 * late for asset loading and DOM-shimmed APIs.
 *
 * The constraint surface for any future edit here:
 *   - NO imports from `react`, `@mui/*`, `@emotion/*`, `zustand`. The
 *     eslint forbidden-imports list enforces this (see
 *     `eslint.config.js`).
 *   - The wire format is `protocol.ts`. Don't ad-hoc `self.postMessage`.
 *   - Per-frame `MIRROR_UPDATE` is the hottest message — keep its
 *     receive handler allocation-free.
 *
 * See `~/.claude/plans/humble-strolling-coral.md` Phase 3 / 4.
 */

import { DOMAdapter, WebWorkerAdapter } from 'pixi.js';
import type { MainToWorkerMsg, WorkerToMainMsg } from './protocol';

DOMAdapter.set(WebWorkerAdapter);

function post(msg: WorkerToMainMsg): void {
  self.postMessage(msg);
}

self.onmessage = (e: MessageEvent<MainToWorkerMsg>): void => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'BOOT': {
        // Phase 3 skeleton — no Pixi app yet. Phase 4 fills this in.
        post({ type: 'READY' });
        break;
      }

      case 'MIRROR_UPDATE':
      case 'SET_VISIBLE':
      case 'SET_CURRENT_SECTOR':
      case 'SET_TRANSIT_DOCKED':
      case 'RESIZE':
      case 'SET_TICKER_FPS':
      case 'POINTER_EVENT':
      case 'WHEEL_EVENT': {
        // Phase 3 skeleton — accept silently. Phase 4 hooks each
        // variant up to the renderer / camera / overlay.
        break;
      }

      case 'DISPOSE': {
        self.close();
        break;
      }
    }
  } catch (err) {
    post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
  }
};
