/**
 * Memory (2026-11-07): each atlas page existed twice, its packing canvas (64 MB
 * at 4096 px) beside the GPU texture. A page is released once it is SEALED (a
 * newer page exists, so it is never written again) AND its texture is on the
 * GPU; the page still being filled is never released, and a page that hasn't
 * uploaded yet keeps its canvas (it would otherwise upload a 1x1 image).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Atlas } from '../../src/client/render/art/atlas';
import type { Frame } from '../../src/client/render/art/shade';

class FakeCanvas {
  constructor(public width: number, public height: number) {}
  getContext(): { putImageData(): void } { return { putImageData: () => {} }; }
}
class FakeImageData { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} }

beforeAll(() => {
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('ImageData', FakeImageData);
});
afterAll(() => vi.unstubAllGlobals());

const frame = (w: number, h: number): Frame => ({ w, h, data: new Uint8Array(w * h * 4) }) as unknown as Frame;
/** Mark a page's texture as uploaded, as Pixi does on its first draw. */
const upload = (a: Atlas, i: number): void => {
  const src = (a as unknown as { pages: Array<{ tex: { source: { _gpuData: Record<number, unknown> } } }> }).pages[i]!.tex.source;
  src._gpuData = { 1: {} };
};
const canvasSize = (a: Atlas, i: number): number => (a as unknown as { pages: Array<{ canvas: FakeCanvas }> }).pages[i]!.canvas.width;

describe('atlas page canvas release', () => {
  it('frees a sealed page once uploaded, never the page being filled', () => {
    const a = new Atlas(false, { pageSize: 256 });
    const out: never[] = [];
    a.add(frame(200, 200), out, 0); // page 0
    a.commit();
    upload(a, 0);
    a.tidy();
    expect(canvasSize(a, 0)).toBe(256); // not sealed yet: still being filled
    a.add(frame(200, 200), out, 1); // no room: page 1, page 0 sealed
    a.commit();
    expect(a.pageCount).toBe(2);
    expect(canvasSize(a, 0)).toBe(1); // sealed + uploaded: released
    expect(canvasSize(a, 1)).toBe(256);
    expect(a.releasedBytes).toBe(256 * 256 * 4);
  });

  it('keeps a sealed page that has not reached the GPU yet, and frees it later', () => {
    const a = new Atlas(false, { pageSize: 256 });
    const out: never[] = [];
    a.add(frame(200, 200), out, 0);
    a.add(frame(200, 200), out, 1); // page 0 sealed before any upload
    a.commit();
    expect(canvasSize(a, 0)).toBe(256); // not uploaded: keep the pixels
    upload(a, 0);
    a.tidy(); // the art service calls this every tick
    expect(canvasSize(a, 0)).toBe(1);
  });
});
