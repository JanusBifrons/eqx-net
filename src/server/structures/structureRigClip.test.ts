import { describe, it, expect } from 'vitest';
import { startStructureRigClip, type RigClipCmd } from './structureRigClip.js';
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
