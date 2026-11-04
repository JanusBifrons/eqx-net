/**
 * Invariant #14: the effects per-frame helpers allocate nothing.
 * Run via `pnpm test:gc` (needs `--expose-gc`).
 */
import { describe, it, expect } from 'vitest';
import { backdropXf, emberTint, envelope, flipFrame, ShieldContacts, ShieldHits, TrailRing, zoomWindow } from './fxMath.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

describe('effects maths heap-delta', () => {
  it('1 000 000 frames of updates grow the heap < 200 KB', () => {
    const xf = { scale: 0, x: 0, y: 0 };
    const hits = new ShieldHits();
    const trail = new TrailRing(24);
    const contacts = new ShieldContacts();
    let acc = 0;
    const step = (i: number): void => {
      const t = i * 0.001;
      backdropXf(t, -t, 0.2 + (i % 100) * 0.03, 0.05, 0.2, 1280, 720, xf);
      acc += flipFrame(t % 1.2, 1, 16) + envelope(t % 1, 0.05, 1) + zoomWindow(xf.scale, 0.2, 0.4, 2, 3) + emberTint((i % 100) / 100);
      if (i % 7 === 0) hits.add(t, t);
      acc += hits.activity(t, 0.5);
      trail.push(t, -t);
      acc += trail.readX(i % 24);
      contacts.begin();
      for (let b = 0; b < (i % 6); b++) contacts.offer(b, b * 1.3 + t, 1);
      contacts.end(1 / 60);
      acc += contacts.intensity(i % 4);
    };
    for (let i = 0; i < 10_000; i++) step(i);
    const before = postGcHeap();
    for (let i = 0; i < 1_000_000; i++) step(i);
    const grew = postGcHeap() - before;
    expect(acc).not.toBe(0);
    expect(grew).toBeLessThan(200 * 1024);
  });
});
