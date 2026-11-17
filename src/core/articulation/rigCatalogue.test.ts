import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { STRUCTURE_KINDS_LIST } from '../../shared-types/structureKinds.js';
import { buildRig, rigPartIndex, JOINT_HINGE, type Rig } from './rig.js';
import { createRigPose, evaluateRig, type PlayingClip } from './evaluate.js';
import { twoBoneIkSolve } from './ikAdapter.js';
import {
  DOCK_BAY_HALF_H, DOCK_BAY_HALF_W, DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y, DOCK_CRANE_REACH_TICKS,
  DOOR_TURRET_MOUNT, DOOR_TURRET_SLIDE_TRAVEL, FREIGHT_DOCK_HALF_H, FREIGHT_DOCK_HALF_W,
  RIG_DEFS, rigById, rigForStructureKind,
} from './rigCatalogue.js';

const play = (clipId: string, startTick: number, target?: { x: number; y: number }): PlayingClip =>
  target ? { clipId, startTick, target } : { clipId, startTick };

describe('rig catalogue (structure-restyle 2b+)', () => {
  it('every catalogue rig builds, is cached, and every part has an outline', () => {
    for (const def of RIG_DEFS) {
      expect(() => buildRig(def)).not.toThrow();
      const rig = rigById(def.id)!;
      expect(rig.id).toBe(def.id);
      expect(rigById(def.id)).toBe(rig);
      for (const p of rig.parts) expect(p.outline?.length ?? 0).toBeGreaterThanOrEqual(6);
    }
    expect(rigById('nope')).toBeNull();
  });

  it('freight_dock footprint matches the numbers the crane is sized from', () => {
    const dock = STRUCTURE_KINDS_LIST.find((k) => k.id === 'freight_dock')!;
    expect(dock.footprint).toEqual({ w: 2 * FREIGHT_DOCK_HALF_W, h: 2 * FREIGHT_DOCK_HALF_H });
  });

  it('authored clip values sit within joint limits and clips never leave them', () => {
    for (const def of RIG_DEFS) {
      const rig = rigById(def.id)!;
      const pose = createRigPose(rig);
      for (const clip of rig.clips) {
        for (const tr of clip.tracks) {
          for (let k = 0; k < tr.values.length; k++) {
            expect(tr.values[k]!).toBeGreaterThanOrEqual(rig.min[tr.part]!);
            expect(tr.values[k]!).toBeLessThanOrEqual(rig.max[tr.part]!);
          }
        }
        for (let tick = 0; tick <= clip.endTick + 10; tick += 2.5) {
          evaluateRig(rig, play(clip.id, 0, { x: 40, y: -10 }), tick, pose, twoBoneIkSolve);
          for (let i = 0; i < rig.partCount; i++) {
            expect(pose.value[i]!).toBeGreaterThanOrEqual(rig.min[i]!);
            expect(pose.value[i]!).toBeLessThanOrEqual(rig.max[i]!);
          }
        }
      }
    }
  });

  it('maps kinds by id: freight_dock and turret; null for unrelated kinds', () => {
    expect(rigForStructureKind('freight_dock')!.id).toBe('dock-crane');
    expect(rigForStructureKind('turret')!.id).toBe('sandbox-door-turret');
    for (const id of ['solar_array', 'missile_turret', 'cargo_bay', 'constructor', 'toString', '']) {
      expect(rigForStructureKind(id)).toBeNull();
    }
    const known = new Set(STRUCTURE_KINDS_LIST.map((k) => k.id as string));
    expect(known.has('freight_dock') && known.has('turret')).toBe(true);
  });
});

describe('dock-crane', () => {
  const rig = rigForStructureKind('freight_dock')!;
  const clamp = rigPartIndex(rig, 'clamp');
  const pose = createRigPose(rig);
  const reachTo = (x: number, y: number): { reached: boolean; err: number } => {
    evaluateRig(rig, play('arm-reach', 0, { x, y }), DOCK_CRANE_REACH_TICKS, pose, twoBoneIkSolve);
    return { reached: pose.ikReached, err: Math.hypot(pose.x[clamp]! - x, pose.y[clamp]! - y) };
  };

  it('has the layers render needs: an under lip, over arm', () => {
    const layer = (id: string): string => rig.parts[rigPartIndex(rig, id)]!.layer;
    expect(layer('lip')).toBe('under');
    for (const id of ['plinth', 'boom', 'jib', 'clamp']) expect(layer(id)).toBe('over');
    expect(rig.jointType[rigPartIndex(rig, 'lip')]).toBe(JOINT_HINGE);
  });

  it('reaches the bay centre and the bay edges (±40 % of the dock width)', () => {
    for (const [x, y] of [[0, 0], [DOCK_BAY_HALF_W, 0], [-DOCK_BAY_HALF_W, 0],
      [DOCK_BAY_HALF_W, DOCK_BAY_HALF_H], [-DOCK_BAY_HALF_W, DOCK_BAY_HALF_H],
      [DOCK_BAY_HALF_W, -DOCK_BAY_HALF_H], [-DOCK_BAY_HALF_W, -DOCK_BAY_HALF_H]] as const) {
      const r = reachTo(x, y);
      expect(r.reached, `(${x}, ${y})`).toBe(true);
      expect(r.err).toBeLessThan(1e-6);
    }
  });

  it('property: every point of the bay is reached', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -DOCK_BAY_HALF_W, max: DOCK_BAY_HALF_W, noNaN: true }),
        fc.double({ min: -DOCK_BAY_HALF_H, max: DOCK_BAY_HALF_H, noNaN: true }),
        (x, y) => { const r = reachTo(x, y); return r.reached && r.err < 1e-6; },
      ),
      { numRuns: 300 },
    );
  });

  it('reports not-reached well outside the dock', () => {
    for (const [x, y] of [[600, 0], [-600, 0], [0, 500], [0, -500]] as const) {
      expect(reachTo(x, y).reached, `(${x}, ${y})`).toBe(false);
    }
  });

  it('rest is stowed along the dock edge, inside the footprint', () => {
    evaluateRig(rig, null, 0, pose);
    for (let i = 0; i < rig.partCount; i++) {
      expect(Math.abs(pose.x[i]!)).toBeLessThanOrEqual(FREIGHT_DOCK_HALF_W);
      expect(Math.abs(pose.y[i]!)).toBeLessThanOrEqual(FREIGHT_DOCK_HALF_H);
    }
    const boom = rigPartIndex(rig, 'boom');
    expect(pose.x[boom]).toBeCloseTo(DOCK_CRANE_PIVOT_X, 9);
    expect(pose.y[boom]).toBeCloseTo(DOCK_CRANE_PIVOT_Y, 9);
    expect(Math.cos(pose.angle[boom]!)).toBeCloseTo(1, 9); // boom lies along the edge (+x)
    expect(pose.y[clamp]! - DOCK_CRANE_PIVOT_Y).toBeLessThan(25); // jib folded back: 140·sin 3.0 ≈ 20 in from the pivot
  });

  it('arm-hold sits on the target; arm-retract returns to rest', () => {
    const target = { x: 120, y: 20 };
    evaluateRig(rig, play('arm-hold', 0, target), 5, pose, twoBoneIkSolve);
    expect(Math.hypot(pose.x[clamp]! - target.x, pose.y[clamp]! - target.y)).toBeLessThan(1e-6);
    evaluateRig(rig, play('arm-retract', 0, target), 0, pose, twoBoneIkSolve);
    expect(Math.hypot(pose.x[clamp]! - target.x, pose.y[clamp]! - target.y)).toBeLessThan(1e-6);
    evaluateRig(rig, play('arm-retract', 0, target), DOCK_CRANE_REACH_TICKS, pose, twoBoneIkSolve);
    for (let i = 0; i < rig.partCount; i++) expect(pose.value[i]).toBe(rig.rest[i]);
  });
});

describe('sandbox-door-turret', () => {
  const rig: Rig = rigForStructureKind('turret')!;
  const pose = createRigPose(rig);
  const P = (id: string): number => rigPartIndex(rig, id);

  it('all parts are plane-layer physical; the mount rides the turret slide', () => {
    for (const p of rig.parts) {
      expect(p.layer).toBe('plane');
      expect(p.kind).toBe('physical');
    }
    expect(P(DOOR_TURRET_MOUNT.partId)).toBeGreaterThanOrEqual(0);
    const turret = STRUCTURE_KINDS_LIST.find((k) => k.id === 'turret')!;
    expect(turret.mounts?.some((m) => m.id === DOOR_TURRET_MOUNT.mountId)).toBe(true);
  });

  it('door-open slides the leaves apart; turret-deploy opens and raises; turret-retract closes over it', () => {
    evaluateRig(rig, play('door-open', 0), 100, pose);
    expect(pose.x[P('door-left')]!).toBeLessThan(-40);
    expect(pose.x[P('door-right')]!).toBeGreaterThan(40);
    evaluateRig(rig, play('door-close', 0), 100, pose);
    expect(pose.x[P('door-left')]).toBeCloseTo(-15, 9);

    evaluateRig(rig, play('turret-deploy', 0), 100, pose);
    expect(pose.y[P('turret-slide')]).toBeCloseTo(DOOR_TURRET_SLIDE_TRAVEL, 9);
    expect(pose.x[P('door-right')]!).toBeGreaterThan(40);

    evaluateRig(rig, play('turret-retract', 0), 45, pose);
    expect(pose.y[P('turret-slide')]).toBeCloseTo(0, 9);
    expect(pose.x[P('door-right')]!).toBeGreaterThan(40); // still open as it sinks
    evaluateRig(rig, play('turret-retract', 0), 100, pose);
    expect(pose.x[P('door-right')]).toBeCloseTo(15, 9);
  });
});
