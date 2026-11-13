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

  it('summary(last) covers only the newest frames (a soak recent window)', () => {
    const r = new FrameTimeRing(8);
    for (let i = 0; i < 6; i++) r.push(100);
    for (let i = 0; i < 4; i++) r.push(10); // wraps: ring holds 100,100,100,100,10,10,10,10
    expect(r.summary(4)).toEqual({ frames: 4, p50: 10, p95: 10, p99: 10, max: 10, hitches: 0 });
    expect(r.summary(100).frames).toBe(8);
    expect(r.summary().max).toBe(100);
  });
});
