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
import { syncGalaxyMode, installGalaxyOverlay } from './galaxyOverlay';
import { WorkerRendererClient } from '../render/worker/WorkerRendererClient';
import { useUIStore } from '../state/store';
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

/**
 * Locks the selector-vs-overlay tap routing of `installGalaxyOverlay`
 * (single-canvas refactor, Step 3). Exercised on the worker path (the
 * desktop default) so we don't construct a real Pixi layer:
 *   - selector mode → always visible, taps route to onSelectorPick (the
 *     spawn picker), never engage a transit.
 *   - overlay mode (default) → taps engage a transit + close the map.
 */
function fakeWorker(): {
  w: WorkerRendererClient;
  getTap: () => ((key: string) => void) | null;
  calls: { mode: ReturnType<typeof vi.fn>; visible: ReturnType<typeof vi.fn> };
} {
  const w = Object.create(WorkerRendererClient.prototype) as WorkerRendererClient;
  let tap: ((key: string) => void) | null = null;
  const calls = { mode: vi.fn(), visible: vi.fn() };
  Object.assign(w as unknown as Record<string, unknown>, {
    setOverlayTapHandler: (h: (key: string) => void) => { tap = h; },
    setLayerMode: calls.mode,
    setLayerVisible: calls.visible,
    setLayerCurrentSector: vi.fn(),
    setLayerTransitDocked: vi.fn(),
  });
  return { w, getTap: () => tap, calls };
}

describe('installGalaxyOverlay (worker path)', () => {
  it('selector mode: always visible, taps route to onSelectorPick (not transit)', () => {
    const { w, getTap, calls } = fakeWorker();
    const onEngageTransit = vi.fn();
    const onSelectorPick = vi.fn();
    const ret = installGalaxyOverlay({
      renderer: w, useWorker: true, el: {} as HTMLDivElement,
      onEngageTransit, mode: 'selector', onSelectorPick,
    });
    expect(ret).toBeNull(); // worker hosts its own layer
    expect(calls.mode).toHaveBeenCalledWith('selector');
    expect(calls.visible).toHaveBeenCalledWith(true);
    getTap()?.('orion-belt');
    expect(onSelectorPick).toHaveBeenCalledWith('orion-belt');
    expect(onEngageTransit).not.toHaveBeenCalled();
  });

  it('overlay mode (default): taps engage a transit + close the map', () => {
    useUIStore.getState().setGalaxyMapOpen(true);
    const { w, getTap, calls } = fakeWorker();
    const onEngageTransit = vi.fn();
    installGalaxyOverlay({
      renderer: w, useWorker: true, el: {} as HTMLDivElement, onEngageTransit,
    });
    expect(calls.mode).toHaveBeenCalledWith('overlay');
    getTap()?.('orion-belt');
    expect(onEngageTransit).toHaveBeenCalledWith('orion-belt');
    expect(useUIStore.getState().isGalaxyMapOpen).toBe(false);
  });
});
