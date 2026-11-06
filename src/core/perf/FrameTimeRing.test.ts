import { describe, it, expect } from 'vitest';
import { FrameTimeRing } from './FrameTimeRing.js';

describe('FrameTimeRing', () => {
  it('summarises percentiles, max and hitches', () => {
    const r = new FrameTimeRing(1000);
    for (let i = 0; i < 98; i++) r.push(16);
    r.push(40);
    r.push(120);
    expect(r.summary()).toEqual({ frames: 100, p50: 16, p95: 16, p99: 120, max: 120, hitches: 2 });
  });

  it('keeps only the newest frames when full', () => {
    const r = new FrameTimeRing(4);
    for (const x of [100, 100, 1, 2, 3, 4]) r.push(x);
    expect(r.summary()).toMatchObject({ frames: 4, max: 4, hitches: 0 });
  });

  it('reset empties it', () => {
    const r = new FrameTimeRing(4);
    r.push(50);
    r.reset();
    expect(r.summary().frames).toBe(0);
  });
});
