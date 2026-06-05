/**
 * Locks the dual-path routing of `syncGalaxyMode` (single-canvas
 * refactor, Step 2). The galaxy layer is hosted two ways — directly on
 * the DOM-mode renderer's stage, and inside the worker addressed via
 * postMessage. A mode change must reach BOTH:
 *   - DOM mode: call `layer.setMode(mode)`.
 *   - Worker mode: post `setLayerMode(mode)` to the worker (the
 *     DOM-layer ref is null in this path).
 * A regression here is "the spawn picker renders in overlay (neighbours-
 * only) mode on one of the two render paths."
 */
import { describe, it, expect, vi } from 'vitest';
import { syncGalaxyMode } from './galaxyOverlay';
import { WorkerRendererClient } from '../render/worker/WorkerRendererClient';
import type { GalaxyMapLayer } from '../render/galaxy/GalaxyMapLayer';
import type { IRenderer } from '@core/contracts/IRenderer';

function fakeLayer(): { layer: GalaxyMapLayer; setMode: ReturnType<typeof vi.fn> } {
  const setMode = vi.fn();
  return { layer: { setMode } as unknown as GalaxyMapLayer, setMode };
}

describe('syncGalaxyMode', () => {
  it('DOM mode: drives the layer directly, no worker post', () => {
    const { layer, setMode } = fakeLayer();
    // A non-WorkerRendererClient renderer (DOM/main-thread path).
    const renderer = {} as IRenderer;
    syncGalaxyMode(layer, renderer, 'selector');
    expect(setMode).toHaveBeenCalledWith('selector');
  });

  it('worker mode: posts setLayerMode; the DOM-layer ref is null', () => {
    // The worker hosts its own layer, so the DOM-mode ref is null.
    const worker = Object.create(WorkerRendererClient.prototype) as WorkerRendererClient;
    const setLayerMode = vi.fn();
    (worker as unknown as { setLayerMode: typeof setLayerMode }).setLayerMode = setLayerMode;
    syncGalaxyMode(null, worker, 'selector');
    expect(setLayerMode).toHaveBeenCalledWith('selector');
  });

  it('no-ops safely when both layer and renderer are absent', () => {
    expect(() => syncGalaxyMode(null, null, 'overlay')).not.toThrow();
  });
});
