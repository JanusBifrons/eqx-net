/**
 * Showcase smoothness gate (showcase/smoothness.ts). Locks that the clips the
 * user rejected as "choppy as hell" (25-37 fps, 50-140 ms hitches — they all
 * passed the old >= 20 fps gate) now FAIL, and that a genuinely smooth 60 fps
 * take passes.
 */
import { describe, it, expect } from 'vitest';
import { smoothnessProblems, smoothScore } from '../../showcase/smoothness.js';

describe('showcase smoothness gate', () => {
  it('rejects the takes that passed the old gate but were visibly choppy', () => {
    // Real numbers from the rejected reel's manifest.
    expect(smoothnessProblems({ frames: 400, deliveredFps: 33.6, gapMaxMs: 140 }, 60)).not.toEqual([]);
    expect(smoothnessProblems({ frames: 300, deliveredFps: 26.7, gapMaxMs: 75 }, 60)).not.toEqual([]);
  });

  it('rejects a high average with a long hitch', () => {
    expect(smoothnessProblems({ frames: 700, deliveredFps: 58, gapMaxMs: 433 }, 60)).toEqual([
      'a 433 ms hitch (max 100)',
    ]);
  });

  it('accepts a smooth 60 fps take', () => {
    expect(smoothnessProblems({ frames: 700, deliveredFps: 59.4, gapMaxMs: 34 }, 60)).toEqual([]);
  });

  it('ranks a steady take above a hitchy one with the same average', () => {
    expect(smoothScore({ frames: 600, deliveredFps: 56, gapMaxMs: 40 })).toBeGreaterThan(
      smoothScore({ frames: 600, deliveredFps: 56, gapMaxMs: 400 }),
    );
  });
});
