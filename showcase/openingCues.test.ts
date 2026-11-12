import { describe, it, expect } from 'vitest';
import { openingCues } from './recorder.js';
import type { CameraCue } from '../src/core/contracts/cameraScript.js';

// Review 2026-11-12 (capital-broadside): the shot's camera was applied only
// after the screencast started, so the take opened on the spectator's default
// view for a few frames before the framed shot snapped in. The opening cues
// are applied before capture; they must land at once.
describe('openingCues', () => {
  const frame: CameraCue = { atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'all', padding: 0.2 } };
  const later: CameraCue = { atMs: 6000, smoothMs: 2500, shot: { kind: 'frame', group: 'drones', padding: 0.1 } };

  it('keeps only the cues at the start of the take', () => {
    expect(openingCues([frame, later])).toEqual([frame]);
  });

  it('lands an eased opening cue at once (no glide on frame 0)', () => {
    expect(openingCues([{ ...frame, smoothMs: 1500 }])[0]!.smoothMs).toBe(0);
  });

  it('no camera script: nothing to apply', () => {
    expect(openingCues(undefined)).toEqual([]);
  });
});
