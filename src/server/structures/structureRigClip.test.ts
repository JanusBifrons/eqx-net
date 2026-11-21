import { describe, it, expect } from 'vitest';
import { rigClipTip, startStructureRigClip, worldToRigHost, type RigClipCmd } from './structureRigClip.js';
import { DOCK_CRANE_REACH_TICKS } from '../../core/articulation/rigCatalogue.js';
import type { StructureRecord } from './StructureRegistry.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';

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

  it('solid doors slice 3: a scrub is recorded and posted; a plain start carries none', () => {
    const r = rec('turret');
    const sent: RigClipCmd[] = [];
    startStructureRigClip(r, 'door-open', 50, (c) => sent.push(c), undefined, undefined, { from: 12, rate: -0.5 });
    expect(r.rigClip).toEqual({ clipId: 'door-open', startTick: 50, from: 12, rate: -0.5 });
    expect(sent[0]).toEqual({ type: 'RIG_CLIP', id: 's-1', clipId: 'door-open', startTick: 50, from: 12, rate: -0.5 });
    startStructureRigClip(r, 'door-open', 60, (c) => sent.push(c));
    expect(r.rigClip).toEqual({ clipId: 'door-open', startTick: 60 });
    expect('from' in sent[1]! || 'rate' in sent[1]!).toBe(false);
  });

  it('solid doors slice 3: the posted scrub poses the worker world at the scrubbed time', async () => {
    // The worker's RIG_CLIP case hands every field to PhysicsWorld.setRigClip
    // (worker.ts); do the same with the posted command.
    const apply = (w: PhysicsWorld, c: RigClipCmd): void =>
      w.setRigClip(c.id, c.clipId, c.startTick, c.targetX, c.targetY, c.from, c.rate);
    const make = async (): Promise<PhysicsWorld> => {
      const w = await PhysicsWorld.create();
      w.spawnObstacle('s-1', 0, 0, 5, 1000);
      w.lockBody('s-1');
      w.attachRig('s-1', rigForStructureKind('turret')!);
      return w;
    };
    const step = (w: PhysicsWorld, from: number, to: number): void => {
      for (let t = from; t < to; t++) { w.stepRigs(t + 1); w.tick(1 / 60); }
    };
    // Scrubbed: frozen at clip time 4. Reference: a plain clip started 4
    // ticks earlier reaches clip time 4 at the same tick.
    const scrubbed = await make();
    const plain = await make();
    startStructureRigClip(rec('turret'), 'door-open', 20, (c) => apply(scrubbed, c), undefined, undefined, { from: 4, rate: 0 });
    startStructureRigClip(rec('turret'), 'door-open', 16, (c) => apply(plain, c));
    step(scrubbed, 0, 20);
    step(plain, 0, 20);
    const want = plain.rigPartPose('s-1', 'door-left')!.x;
    expect(want).toBeLessThan(-12); // moving: off the rest pose
    expect(scrubbed.rigPartPose('s-1', 'door-left')!.x).toBeCloseTo(want, 6);
    // Frozen: 30 ticks later it has not moved; the plain clip has.
    step(scrubbed, 20, 50);
    step(plain, 20, 50);
    expect(scrubbed.rigPartPose('s-1', 'door-left')!.x).toBeCloseTo(want, 6);
    expect(plain.rigPartPose('s-1', 'door-left')!.x).not.toBeCloseTo(want, 3);
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
