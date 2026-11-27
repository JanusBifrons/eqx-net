/**
 * Plan then Build: the live ghost's verdict sees the planned buildings as if
 * placed (`addFootprint`), with the SAME reason the core batch check gives
 * the next batch item (#15).
 */
import { describe, expect, it } from 'vitest';
import { BatchPlacementChecker } from '../../core/structures/batchPlacement.js';
import { PlacementGhostVerdict, type GhostPose } from './placementGhostVerdict.js';

const empty = new Map();

function judge(v: PlacementGhostVerdict, kind: string, x: number, y: number): string | null {
  const pose: GhostPose = { kind, x, y, angle: 0 };
  return v.check(pose, empty, empty, null, null);
}

/** The batch check's reason for the LAST of `items` (the others planned before it). */
function batchReason(items: Array<{ kind: string; x: number; y: number; rot: number }>): string | null {
  const c = new BatchPlacementChecker();
  c.begin(items, null);
  return c.rejection(items.length - 1, [], null);
}

describe('ghost verdict with planned buildings', () => {
  it('red on top of a planned building, with the batch check\'s reason', () => {
    const v = new PlacementGhostVerdict();
    expect(judge(v, 'solar', 0, 0)).toBeNull();
    v.addFootprint('solar', 0, 0, 0, false);
    const r = judge(v, 'solar', 10, 0);
    expect(r).toBe('overlap-structure');
    expect(r).toBe(batchReason([{ kind: 'solar', x: 0, y: 0, rot: 0 }, { kind: 'solar', x: 10, y: 0, rot: 0 }]));
  });

  it('clear away from it; clearAdded forgets the plan; prepare keeps it', () => {
    const v = new PlacementGhostVerdict();
    v.addFootprint('solar', 0, 0, 0, false);
    expect(judge(v, 'solar', 5000, 0)).toBeNull();
    v.prepare(empty, empty);
    expect(v.checkPrepared({ kind: 'solar', x: 0, y: 0, angle: 0 }, null)).toBe('overlap-structure');
    v.clearAdded();
    expect(judge(v, 'solar', 0, 0)).toBeNull();
  });

  it('pooled: re-adding a plan each frame reuses its footprints', () => {
    const v = new PlacementGhostVerdict();
    for (let f = 0; f < 3; f++) {
      v.clearAdded();
      v.addFootprint('solar', 0, 0, 0, false);
      v.addFootprint('battery', 3000, 0, 0, false);
    }
    expect(judge(v, 'battery', 3000, 0)).toBe('overlap-structure');
    expect(judge(v, 'solar', 1500, 900)).toBeNull();
  });
});
