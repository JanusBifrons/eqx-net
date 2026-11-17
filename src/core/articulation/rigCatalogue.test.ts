import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { STRUCTURE_KINDS_LIST, structureOutline } from '../../shared-types/structureKinds.js';
import { buildRig, rigPartIndex, JOINT_HINGE, type Rig } from './rig.js';
import { createRigPose, evaluateRig, type PlayingClip } from './evaluate.js';
import { twoBoneIkSolve } from './ikAdapter.js';
import {
  DOCK_BAY_CX, DOCK_BAY_CY, DOCK_BAY_HALF_H, DOCK_BAY_HALF_W, DOCK_CRANE_BOOM, DOCK_CRANE_JIB, DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y, DOCK_CRANE_REACH_TICKS,
  DOCK_DEPOSIT_RANGE, DOOR_TURRET_MOUNT, DOOR_TURRET_SLIDE_TRAVEL, FREIGHT_DOCK_HALF_H, FREIGHT_DOCK_HALF_W,
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
    // Ladder A medium (600–1,200 longest side), the size the owner picked.
    expect(dock.footprint.w).toBe(1000);
    expect(dock.radius).toBeGreaterThanOrEqual(Math.hypot(FREIGHT_DOCK_HALF_W, FREIGHT_DOCK_HALF_H));
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

  const bx0 = DOCK_BAY_CX - DOCK_BAY_HALF_W, bx1 = DOCK_BAY_CX + DOCK_BAY_HALF_W;
  const by0 = DOCK_BAY_CY - DOCK_BAY_HALF_H, by1 = DOCK_BAY_CY + DOCK_BAY_HALF_H;

  it('the bay lies entirely outside the dock footprint, beyond its open (+y) edge', () => {
    expect(by0).toBeGreaterThan(FREIGHT_DOCK_HALF_H);
    for (const style of ['c', undefined]) {
      const outline = structureOutline('freight_dock', style);
      expect(outline.length).toBeGreaterThanOrEqual(3);
      // The bay is a box wholly above the outline's highest point: a separating line.
      const topY = Math.max(...outline.map((p) => p.y));
      expect(topY, `style ${style ?? 'default'}`).toBeLessThan(by0);
    }
  });

  it('the lip apron covers the bay floor, outside the building', () => {
    const lip = rigPartIndex(rig, 'lip');
    const part = rig.parts[lip]!;
    expect(part.kind).toBe('cosmetic');
    evaluateRig(rig, null, 0, pose);
    const ox = pose.x[lip]!, oy = pose.y[lip]!;
    const xs: number[] = [], ys: number[] = [];
    const o = part.outline!;
    for (let i = 0; i < o.length; i += 2) { xs.push(ox + o[i]!); ys.push(oy + o[i + 1]!); }
    expect(Math.min(...xs)).toBeLessThanOrEqual(bx0);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(bx1);
    expect(Math.min(...ys)).toBeLessThanOrEqual(by0);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(by1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(FREIGHT_DOCK_HALF_H); // starts at the open edge
  });

  it('reaches the bay centre, edge midpoints and all four corners', () => {
    for (const [x, y] of [[DOCK_BAY_CX, DOCK_BAY_CY],
      [bx0, DOCK_BAY_CY], [bx1, DOCK_BAY_CY], [DOCK_BAY_CX, by0], [DOCK_BAY_CX, by1],
      [bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]] as const) {
      const r = reachTo(x, y);
      expect(r.reached, `(${x}, ${y})`).toBe(true);
      expect(r.err).toBeLessThan(1e-6);
    }
  });

  it('reaches the bay with margin: far corners inside max reach, near edge outside min reach', () => {
    const far = Math.hypot(bx1 - DOCK_CRANE_PIVOT_X, by1 - DOCK_CRANE_PIVOT_Y);
    expect(DOCK_CRANE_BOOM + DOCK_CRANE_JIB - far).toBeGreaterThan(30);
    const minReach = Math.sqrt(DOCK_CRANE_BOOM ** 2 + DOCK_CRANE_JIB ** 2 + 2 * DOCK_CRANE_BOOM * DOCK_CRANE_JIB * Math.cos(3.0));
    expect(by0 - DOCK_CRANE_PIVOT_Y - minReach).toBeGreaterThan(5);
  });

  it('property: every point of the bay is reached', () => {
    fc.assert(
      fc.property(
        fc.double({ min: bx0, max: bx1, noNaN: true }),
        fc.double({ min: by0, max: by1, noNaN: true }),
        (x, y) => { const r = reachTo(x, y); return r.reached && r.err < 1e-6; },
      ),
      { numRuns: 300 },
    );
  });

  it('the pad fits three trader-haulers side by side (nose-in, 80 wide, 136 long)', () => {
    // Drawn hauler size (shipExtent('trader-hauler') = 68 half-length; ~80 wide).
    expect(2 * DOCK_BAY_HALF_W).toBeGreaterThanOrEqual(3 * 80 + 4 * 60);
    expect(2 * DOCK_BAY_HALF_H).toBeGreaterThanOrEqual(136 + 2 * 60);
    expect(2 * DOCK_BAY_HALF_W).toBeGreaterThanOrEqual(850); // ~900 × 500, the owner's pick
    expect(2 * DOCK_BAY_HALF_H).toBeGreaterThanOrEqual(480);
  });

  it('the deposit circle covers the whole landing apron', () => {
    const lip = rig.parts[rigPartIndex(rig, 'lip')]!;
    const o = lip.outline!;
    for (let k = 0; k < o.length; k += 2) {
      expect(Math.hypot(lip.anchorX + o[k]!, lip.anchorY + o[k + 1]!)).toBeLessThanOrEqual(DOCK_DEPOSIT_RANGE);
    }
  });

  it('reports not-reached well outside the bay', () => {
    for (const [x, y] of [[1300, 0], [-1300, 0], [0, 1100], [0, -1100], [1000, 800], [-1000, 800]] as const) {
      expect(reachTo(x, y).reached, `(${x}, ${y})`).toBe(false);
    }
  });

  it('rest is stowed along the open edge, inside the footprint plus the plinth', () => {
    evaluateRig(rig, null, 0, pose);
    for (const id of ['plinth', 'boom', 'jib', 'clamp']) {
      const i = rigPartIndex(rig, id);
      expect(Math.abs(pose.x[i]!), id).toBeLessThanOrEqual(FREIGHT_DOCK_HALF_W);
      expect(Math.abs(pose.y[i]!), id).toBeLessThanOrEqual(FREIGHT_DOCK_HALF_H);
      // Every outline vertex, too (the plinth's base hugs the edge).
      const o = rig.parts[i]!.outline!;
      const c = Math.cos(pose.angle[i]!), sn = Math.sin(pose.angle[i]!);
      for (let k = 0; k < o.length; k += 2) {
        const vx = pose.x[i]! + o[k]! * c - o[k + 1]! * sn;
        const vy = pose.y[i]! + o[k]! * sn + o[k + 1]! * c;
        expect(Math.abs(vx), `${id} x`).toBeLessThanOrEqual(FREIGHT_DOCK_HALF_W);
        expect(vy, `${id} y`).toBeLessThanOrEqual(FREIGHT_DOCK_HALF_H);
      }
    }
    const boom = rigPartIndex(rig, 'boom');
    expect(pose.x[boom]).toBeCloseTo(DOCK_CRANE_PIVOT_X, 9);
    expect(pose.y[boom]).toBeCloseTo(DOCK_CRANE_PIVOT_Y, 9);
    expect(Math.cos(pose.angle[boom]!)).toBeCloseTo(-1, 9); // boom lies along the edge (-x)
    // jib folded back into the dock: 2·390·cos 1.5 ≈ 55 below the pivot
    expect(pose.y[clamp]!).toBeLessThan(DOCK_CRANE_PIVOT_Y);
    expect(DOCK_CRANE_PIVOT_Y - pose.y[clamp]!).toBeLessThan(60);
  });

  it('arm-hold sits on the target; arm-retract returns to rest', () => {
    const target = { x: 120, y: DOCK_BAY_CY };
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
