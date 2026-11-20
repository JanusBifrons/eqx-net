import { describe, it, expect } from 'vitest';
import { rigClipTip, startStructureRigClip, worldToRigHost, type RigClipCmd } from './structureRigClip.js';
import { DOCK_CRANE_REACH_TICKS } from '../../core/articulation/rigCatalogue.js';
import type { StructureRecord } from './StructureRegistry.js';

function rec(kind: string): StructureRecord {
  return { id: 's-1', kind } as unknown as StructureRecord;
}

describe('startStructureRigClip (structure-restyle 2d)', () => {
  it('records the clip on the structure and posts RIG_CLIP', () => {
    const r = rec('turret');
    const sent: RigClipCmd[] = [];
    expect(startStructureRigClip(r, 'door-open', 120, (c) => sent.push(c))).toBe(true);
    expect(r.rigClip).toEqual({ clipId: 'door-open', startTick: 120 });
    expect(sent).toEqual([{ type: 'RIG_CLIP', id: 's-1', clipId: 'door-open', startTick: 120 }]);
  });

  it('carries a target, and null clears the clip', () => {
    const r = rec('turret');
    const sent: RigClipCmd[] = [];
    startStructureRigClip(r, 'turret-deploy', 5, (c) => sent.push(c), { x: 3, y: 4 });
    expect(r.rigClip).toEqual({ clipId: 'turret-deploy', startTick: 5, target: { x: 3, y: 4 } });
    expect(sent[0]).toMatchObject({ targetX: 3, targetY: 4 });
    expect(startStructureRigClip(r, null, 9, (c) => sent.push(c))).toBe(true);
    expect(r.rigClip).toBeNull();
    expect(sent[1]).toEqual({ type: 'RIG_CLIP', id: 's-1', clipId: null, startTick: 9 });
  });

  it('refuses an unknown clip or a kind without a rig, changing nothing', () => {
    const sent: RigClipCmd[] = [];
    const r = rec('turret');
    expect(startStructureRigClip(r, 'no-such-clip', 1, (c) => sent.push(c))).toBe(false);
    expect(startStructureRigClip(rec('solar'), 'door-open', 1, (c) => sent.push(c))).toBe(false);
    expect(r.rigClip).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe('rigClipTip / worldToRigHost (structure-restyle 2f sandbox)', () => {
  it('maps a world point into a turned host frame', () => {
    const r = { id: 's', kind: 'freight_dock', x: 100, y: 50, rot: 90 } as unknown as StructureRecord;
    const p = worldToRigHost(r, 100, 150); // 100 north of the centre; turned 90° CCW ⇒ host +x
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(0);
  });

  it('is the target once the reach lands, partway before; an early retract from it starts in place', () => {
    const r = rec('freight_dock');
    startStructureRigClip(r, 'arm-reach', 0, () => {}, { x: 200, y: 460 });
    const done = rigClipTip(r, DOCK_CRANE_REACH_TICKS)!;
    expect(done.x).toBeCloseTo(200, 0);
    expect(done.y).toBeCloseTo(460, 0);
    const mid = rigClipTip(r, DOCK_CRANE_REACH_TICKS / 2)!;
    expect(Math.hypot(mid.x - 200, mid.y - 460)).toBeGreaterThan(20);
    // Abort: arm-retract from the mid-reach tip begins exactly there (no jump).
    startStructureRigClip(r, 'arm-retract', 30, () => {}, mid);
    const start = rigClipTip(r, 30)!;
    expect(start.x).toBeCloseTo(mid.x, 0);
    expect(start.y).toBeCloseTo(mid.y, 0);
    expect(rigClipTip(rec('turret'), 0)).toBeNull();
  });
});
