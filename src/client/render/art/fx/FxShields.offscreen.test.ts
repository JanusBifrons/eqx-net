/**
 * Perf lock (#13, count-based): `FxFences.end` re-laid out every fence every
 * frame, on screen or not (~301 ms / 8 s on Sol Prime's big base, phone, 6x
 * CPU). An off-screen fence is now hidden once and skipped; one that scrolls
 * back into view draws exactly what it would have drawn all along.
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxFences } from './FxShields.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: Array.from({ length: 12 }, () => Texture.WHITE), w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}

/** Pixi-space view rects. */
const ON_SCREEN = new Float64Array([-10_000, -10_000, 10_000, 10_000]);
const OFF_SCREEN = new Float64Array([50_000, 50_000, 51_000, 51_000]);

const N = 20, K = 10;

function frame(f: FxFences, n: number, view: Float64Array): void {
  const now = 1000 + n * 16;
  f.viewBounds = view;
  f.begin();
  // A mix of up, down (sparking) and open-gate fences.
  for (let w = 0; w < N; w++) f.wall(w, 0, w * 60, 400, w * 60, w % 3 !== 0, w % 6 === 3, now);
  f.end(now);
}

describe('FxFences — off-screen fences are not animated', () => {
  it(`${N} off-screen fences over ${K} frames: none laid out, none drawn`, () => {
    const f = new FxFences(fakeArt());
    let laidOut = 0;
    for (let k = 0; k < K; k++) { frame(f, k, OFF_SCREEN); laidOut += f.laidOut; }
    expect(f.count()).toBe(N);
    expect(laidOut).toBe(0); // was N × K = 200
    expect(f.container.children.filter((c) => c.visible).length).toBe(0);
  });

  it(`${N} on-screen fences over ${K} frames: every fence laid out every frame`, () => {
    const f = new FxFences(fakeArt());
    let laidOut = 0;
    for (let k = 0; k < K; k++) { frame(f, k, ON_SCREEN); laidOut += f.laidOut; }
    expect(laidOut).toBe(N * K);
  });

  it('a fence that scrolls back into view draws exactly as if it had never left', () => {
    const snap = (f: FxFences): string => f.container.children
      .map((c) => [c.visible, c.x, c.y, c.rotation, c.alpha, c.tint, c.scale.x, c.scale.y].join(',')).join('|');
    const always = new FxFences(fakeArt());
    const away = new FxFences(fakeArt());
    for (let k = 0; k < 40; k++) {
      // A hit lands while `away` is off screen; its ripple is still running on return.
      if (k === 18) { always.hitAt(200, -60, 1000 + k * 16); away.hitAt(200, -60, 1000 + k * 16); }
      frame(always, k, ON_SCREEN);
      frame(away, k, k < 20 ? OFF_SCREEN : ON_SCREEN);
    }
    expect(snap(away)).toBe(snap(always));
  });
});
