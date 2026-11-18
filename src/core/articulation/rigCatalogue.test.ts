import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CAPITAL, STRUCTURE_KINDS_LIST, getStructureKind, structureOutline } from '../../shared-types/structureKinds.js';
import { buildRig, liftProgress, rigPartIndex, JOINT_HINGE, JOINT_LIFT, type Rig } from './rig.js';
import { createRigPose, evaluateRig, rigDeployed, type PlayingClip } from './evaluate.js';
import { twoBoneIkSolve } from './ikAdapter.js';
import {
  DOCK_BAY_CX, DOCK_BAY_CY, DOCK_BAY_HALF_H, DOCK_BAY_HALF_W, DOCK_CRANE_BOOM, DOCK_CRANE_JIB, DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y, DOCK_CRANE_REACH_TICKS,
  DOCK_BAY_INSET, DOCK_DEPOSIT_RANGE, DOCK_STILL_SPEED, DOCK_UNLOAD_HOLD_LOAD_TICKS, DOCK_UNLOAD_HOLD_MIN_TICKS, DOOR_TURRET_LEAF_TRAVEL, DOOR_TURRET_LIFT, DOOR_TURRET_MOUNT, FREIGHT_DOCK_HALF_H, FREIGHT_DOCK_HALF_W,
  CAPITAL_BAY, CRANE_BAYS, FREIGHT_DOCK_BAY, RIG_DEFS, SANDBOX_DOOR_TURRET_DEF, craneBayFor, craneBayWorldCentre, dockUnloadHoldTicks, inCraneBay, inDockBay, isStillForDock, rigById, rigForStructureKind,
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

  it('all parts are plane-layer physical; the mount rides the turret lift', () => {
    for (const p of rig.parts) {
      expect(p.layer).toBe('plane');
      expect(p.kind).toBe('physical');
    }
    expect(P(DOOR_TURRET_MOUNT.partId)).toBeGreaterThanOrEqual(0);
    const turret = STRUCTURE_KINDS_LIST.find((k) => k.id === 'turret')!;
    expect(turret.mounts?.some((m) => m.id === DOOR_TURRET_MOUNT.mountId)).toBe(true);
  });

  /** Host-frame box of part `id` in the current pose, its outline scaled by `k` about the part origin. */
  const boxOf = (id: string, k = 1): { x0: number; x1: number; y0: number; y1: number } => {
    const i = P(id), o = rig.parts[i]!.outline!;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j < o.length; j += 2) {
      // Parts here have angle 0: host = pose origin + outline.
      const x = pose.x[i]! + o[j]! * k, y = pose.y[i]! + o[j + 1]! * k;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { x0, x1, y0, y1 };
  };
  /** The drawn riser grows up to ~1.14x (client `liftScaleUp`); check with margin. */
  const RISEN = 1.15;

  it('the turret is a lift part over the socket (0, 0): no in-plane motion through deploy and retract', () => {
    const t = P('turret-lift');
    expect(rig.jointType[t]).toBe(JOINT_LIFT);
    for (const clip of ['turret-deploy', 'turret-retract']) {
      for (let tick = 0; tick <= 70; tick += 5) {
        evaluateRig(rig, play(clip, 0), tick, pose);
        expect(pose.x[t]).toBe(0);
        expect(pose.y[t]).toBe(0);
        expect(pose.angle[t]).toBe(0);
      }
    }
    evaluateRig(rig, play('turret-deploy', 0), 100, pose);
    expect(liftProgress(rig, t, pose.value[t]!)).toBe(1);
    expect(pose.value[t]).toBe(DOOR_TURRET_LIFT);
    evaluateRig(rig, play('turret-retract', 0), 100, pose);
    expect(liftProgress(rig, t, pose.value[t]!)).toBe(0);
  });

  it('closed, the leaves meet at the centre and cover the riser (even fully risen in size)', () => {
    evaluateRig(rig, play('door-close', 0), 100, pose);
    const l = boxOf('door-left'), r = boxOf('door-right'), riser = boxOf('turret-lift', RISEN);
    expect(l.x1).toBeCloseTo(0, 9);
    expect(r.x0).toBeCloseTo(0, 9);
    expect(l.x0).toBeLessThanOrEqual(riser.x0);
    expect(r.x1).toBeGreaterThanOrEqual(riser.x1);
    for (const leaf of [l, r]) {
      expect(leaf.y0).toBeLessThanOrEqual(riser.y0);
      expect(leaf.y1).toBeGreaterThanOrEqual(riser.y1);
    }
  });

  it('open, both leaves are clear of the fully risen riser and still on the 140 x 140 roof', () => {
    for (const [clip, tick] of [['door-open', 100], ['turret-deploy', 100], ['turret-retract', 45]] as const) {
      evaluateRig(rig, play(clip, 0), tick, pose);
      const riser = boxOf('turret-lift', RISEN);
      expect(boxOf('door-left').x1).toBeLessThan(riser.x0);
      expect(boxOf('door-right').x0).toBeGreaterThan(riser.x1);
      expect(boxOf('door-left').x0).toBeGreaterThan(-70);
      expect(boxOf('door-right').x1).toBeLessThan(70);
    }
  });

  it('the turret only rises once the hatch is (nearly) clear of it', () => {
    const t = P('turret-lift');
    for (let tick = 0; tick <= 60; tick++) {
      evaluateRig(rig, play('turret-deploy', 0), tick, pose);
      if (liftProgress(rig, t, pose.value[t]!) > 0) {
        expect(boxOf('door-left').x1).toBeLessThan(boxOf('turret-lift', 0.9).x0);
      }
    }
  });

  it('door-open slides the leaves apart; turret-deploy opens and raises; turret-retract closes over it', () => {
    evaluateRig(rig, play('door-open', 0), 100, pose);
    expect(pose.x[P('door-left')]!).toBeLessThan(-40);
    expect(pose.x[P('door-right')]!).toBeGreaterThan(40);
    evaluateRig(rig, play('door-close', 0), 100, pose);
    expect(pose.x[P('door-left')]).toBeCloseTo(-12, 9);

    evaluateRig(rig, play('turret-deploy', 0), 100, pose);
    expect(pose.value[P('turret-lift')]).toBeCloseTo(DOOR_TURRET_LIFT, 9);
    expect(pose.x[P('door-right')]!).toBeGreaterThan(40);

    evaluateRig(rig, play('turret-retract', 0), 45, pose);
    expect(pose.value[P('turret-lift')]).toBeCloseTo(0, 9);
    expect(pose.x[P('door-right')]!).toBeGreaterThan(40); // still open as it sinks
    evaluateRig(rig, play('turret-retract', 0), 100, pose);
    expect(pose.x[P('door-right')]).toBeCloseTo(12, 9);
  });
});

describe('dock bay service rule (structure-restyle 3a)', () => {
  const x0 = DOCK_BAY_CX - DOCK_BAY_HALF_W, x1 = DOCK_BAY_CX + DOCK_BAY_HALF_W;
  const y0 = DOCK_BAY_CY - DOCK_BAY_HALF_H, y1 = DOCK_BAY_CY + DOCK_BAY_HALF_H;
  const e = 1e-6;

  it('the bay is the 900 x 500 pad past the open (+y) edge', () => {
    expect([x0, x1, y0, y1]).toEqual([-450, 450, 210, 710]);
  });

  it('centre and inset edges are in; the outer inset band is out', () => {
    expect(inDockBay(DOCK_BAY_CX, DOCK_BAY_CY)).toBe(true);
    const ix0 = x0 + DOCK_BAY_INSET, ix1 = x1 - DOCK_BAY_INSET, iy0 = y0 + DOCK_BAY_INSET, iy1 = y1 - DOCK_BAY_INSET;
    for (const [x, y] of [[ix0, iy0], [ix1, iy0], [ix0, iy1], [ix1, iy1], [0, iy0], [0, iy1], [ix0, DOCK_BAY_CY], [ix1, DOCK_BAY_CY]] as const) {
      expect(inDockBay(x, y)).toBe(true);
    }
    for (const [x, y] of [[ix0 - e, DOCK_BAY_CY], [ix1 + e, DOCK_BAY_CY], [0, iy0 - e], [0, iy1 + e]] as const) {
      expect(inDockBay(x, y)).toBe(false);
    }
    // The raw pad edge is inside the inset band: a centre there is not parked.
    expect(inDockBay(x0, DOCK_BAY_CY)).toBe(false);
    expect(inDockBay(0, y0)).toBe(false);
    expect(inDockBay(0, y1)).toBe(false);
  });

  it('nothing inside the dock building or the gap counts', () => {
    expect(inDockBay(0, 0)).toBe(false);
    expect(inDockBay(0, FREIGHT_DOCK_HALF_H)).toBe(false);
    expect(inDockBay(0, FREIGHT_DOCK_HALF_H + 5)).toBe(false);
    expect(inDockBay(DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y)).toBe(false);
    expect(inDockBay(-FREIGHT_DOCK_HALF_W, -FREIGHT_DOCK_HALF_H)).toBe(false);
  });

  it('points outside the pad are out (behind, beyond, to each side)', () => {
    for (const [x, y] of [[0, -400], [0, 900], [-600, DOCK_BAY_CY], [600, DOCK_BAY_CY], [2000, 2000]] as const) {
      expect(inDockBay(x, y)).toBe(false);
    }
  });

  it('a hauler-sized hull (80 wide) parked with its centre in the bay is mostly on the pad', () => {
    expect(DOCK_BAY_INSET).toBeGreaterThanOrEqual(40);
    // Three haulers side by side still fit inside the inset zone.
    expect(2 * (DOCK_BAY_HALF_W - DOCK_BAY_INSET)).toBeGreaterThan(3 * 80);
  });

  it('stillness: strictly below DOCK_STILL_SPEED in any direction', () => {
    expect(isStillForDock(0, 0)).toBe(true);
    expect(isStillForDock(DOCK_STILL_SPEED - e, 0)).toBe(true);
    expect(isStillForDock(0, -(DOCK_STILL_SPEED - e))).toBe(true);
    expect(isStillForDock(DOCK_STILL_SPEED, 0)).toBe(false);
    const d = DOCK_STILL_SPEED / Math.SQRT2;
    expect(isStillForDock(d * 0.99, d * 0.99)).toBe(true);
    expect(isStillForDock(d * 1.01, -d * 1.01)).toBe(false);
    // A slow pass across the pad (50 u/s, 10 s to cross) is not still.
    expect(isStillForDock(50, 0)).toBe(false);
  });

  it('hold time: 3 s empty, 10 s full, linear between, clamped', () => {
    expect(DOCK_UNLOAD_HOLD_MIN_TICKS).toBe(180);
    expect(DOCK_UNLOAD_HOLD_MIN_TICKS + DOCK_UNLOAD_HOLD_LOAD_TICKS).toBe(600);
    expect(dockUnloadHoldTicks(0, 100)).toBe(180);
    expect(dockUnloadHoldTicks(100, 100)).toBe(600);
    expect(dockUnloadHoldTicks(50, 100)).toBe(390);
    expect(dockUnloadHoldTicks(1, 3)).toBe(320);
    expect(dockUnloadHoldTicks(500, 100)).toBe(600);
    expect(dockUnloadHoldTicks(-5, 100)).toBe(180);
    expect(dockUnloadHoldTicks(10, 0)).toBe(180);
    expect(dockUnloadHoldTicks(10, -1)).toBe(180);
    expect(dockUnloadHoldTicks(NaN, 100)).toBe(180);
    expect(dockUnloadHoldTicks(10, Infinity)).toBe(180);
    expect(dockUnloadHoldTicks(Infinity, 100)).toBe(600);
  });

  it('hold time is monotonic in load and always a whole tick in [180, 600]', () => {
    fc.assert(fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.double({ min: 1e-3, max: 1e6, noNaN: true }), (load, cap) => {
      const t = dockUnloadHoldTicks(load, cap);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(180);
      expect(t).toBeLessThanOrEqual(600);
      expect(dockUnloadHoldTicks(load + cap / 10, cap)).toBeGreaterThanOrEqual(t);
    }));
  });
});

describe('rigDeployed + idle pose (structure-restyle 2h)', () => {
  const rig: Rig = rigForStructureKind('turret')!;
  const pose = createRigPose(rig);
  const P = (id: string): number => rigPartIndex(rig, id);

  it('no clip record: the turret idles deployed (hatch open, gun fully up)', () => {
    evaluateRig(rig, null, 0, pose);
    expect(liftProgress(rig, P('turret-lift'), pose.value[P('turret-lift')]!)).toBe(1);
    expect(pose.value[P('door-left')]).toBeCloseTo(DOOR_TURRET_LEAF_TRAVEL, 9);
    expect(pose.value[P('door-right')]).toBeCloseTo(DOOR_TURRET_LEAF_TRAVEL, 9);
    expect(rigDeployed(rig, null, 0, pose)).toBe(true);
    expect(rigDeployed(rig, null, 123_456, pose)).toBe(true);
  });

  it('stowed, rising or sinking holds; only fully raised is deployed', () => {
    expect(rigDeployed(rig, play('turret-retract', 0), 1000, pose)).toBe(false); // packed away
    expect(rigDeployed(rig, play('turret-retract', 0), 20, pose)).toBe(false); // sinking
    expect(rigDeployed(rig, play('door-open', 0), 1000, pose)).toBe(false); // hatch open over a sunk gun
    expect(rigDeployed(rig, play('door-close', 0), 1000, pose)).toBe(false);
    expect(rigDeployed(rig, play('turret-deploy', 0), 59, pose)).toBe(false); // rising
    expect(rigDeployed(rig, play('turret-deploy', 0), 60, pose)).toBe(true);
    expect(rigDeployed(rig, play('turret-deploy', 0), 1000, pose)).toBe(true);
    // A clip scheduled but not started: rest (sunk).
    expect(rigDeployed(rig, play('turret-deploy', 500), 100, pose)).toBe(false);
  });

  it('a rig with no lift joint is always deployed', () => {
    const crane = rigForStructureKind('freight_dock')!;
    const cp = createRigPose(crane);
    expect(rigDeployed(crane, null, 0, cp)).toBe(true);
    expect(rigDeployed(crane, play('arm-retract', 0), 5, cp)).toBe(true);
  });

  it('a rig without idleClip rests with no clip; a bad idleClip fails the build', () => {
    const { idleClip: _omit, ...plain } = SANDBOX_DOOR_TURRET_DEF;
    const r = buildRig(plain);
    expect(r.idleClip).toBe(-1);
    const p = createRigPose(r);
    expect(rigDeployed(r, null, 0, p)).toBe(false);
    expect(() => buildRig({ ...SANDBOX_DOOR_TURRET_DEF, idleClip: 'nope' })).toThrow(/unknown idle clip/);
    const dock = RIG_DEFS.find((d) => d.id === 'dock-crane')!;
    const targeted = dock.clips.find((c) => c.ik !== undefined)!;
    expect(() => buildRig({ ...dock, idleClip: targeted.id })).toThrow(/targeted/);
  });
});
describe('crane bays per kind (structure-restyle 3i)', () => {
  it('freight_dock and capital carry a crane bay and its crane rig; nothing else does', () => {
    expect(craneBayFor('freight_dock')).toBe(FREIGHT_DOCK_BAY);
    expect(craneBayFor('capital')).toBe(CAPITAL_BAY);
    for (const id of ['cargo_bay', 'turret', 'toString', '']) expect(craneBayFor(id)).toBeNull();
    for (const bay of CRANE_BAYS) {
      expect(rigForStructureKind(bay.kindId)!.id).toBe(bay.rigId);
      expect(rigById(bay.rigId)!.clips.map((c) => c.id)).toEqual(['arm-reach', 'arm-hold', 'arm-retract']);
    }
  });

  it('each bay IS the keepClear pad of its kind, past the open (+y) edge, the tower on the roof', () => {
    for (const bay of CRANE_BAYS) {
      const k = getStructureKind(bay.kindId as 'capital');
      expect({ cx: bay.cx, cy: bay.cy, w: 2 * bay.padHalfW, h: 2 * bay.padHalfH }).toEqual(k.keepClear);
      expect(bay.halfH).toBe(k.footprint.h / 2);
      expect(bay.cy - bay.padHalfH, 'pad starts past the open edge').toBeGreaterThan(bay.halfH);
      expect(Math.abs(bay.pivotX)).toBeLessThan(bay.halfW);
      expect(bay.pivotY).toBeGreaterThan(-bay.halfH);
      expect(bay.pivotY).toBeLessThan(bay.halfH);
    }
    // The Capital: 500 × 240, 10 u past its 280 edge, centred on the hull.
    expect(CAPITAL.keepClear).toEqual({ cx: 0, cy: 410, w: 500, h: 240 });
  });

  it('inDockBay is the dock bay rule; the Capital bay rule is the same rule on its pad', () => {
    for (const [x, y] of [[0, 460], [0, 0], [400, 700], [0, 410], [210, 330]] as const) {
      expect(inDockBay(x, y)).toBe(inCraneBay(FREIGHT_DOCK_BAY, x, y));
    }
    const b = CAPITAL_BAY;
    expect(inCraneBay(b, b.cx, b.cy)).toBe(true);
    expect(inCraneBay(b, b.cx + b.padHalfW - DOCK_BAY_INSET, b.cy + b.padHalfH - DOCK_BAY_INSET)).toBe(true);
    expect(inCraneBay(b, b.cx + b.padHalfW - DOCK_BAY_INSET + 1e-6, b.cy)).toBe(false);
    expect(inCraneBay(b, 0, 0), 'the hull is not the bay').toBe(false);
    expect(inCraneBay(b, 0, b.halfH + 5), 'nor the gap').toBe(false);
    expect(inCraneBay(b, 0, -b.cy), 'nor the far side').toBe(false);
    // A hauler (80 wide) parks with room either side, centre band ≥ 160 deep.
    expect(2 * (b.padHalfW - DOCK_BAY_INSET)).toBeGreaterThan(3 * 80);
    expect(2 * (b.padHalfH - DOCK_BAY_INSET)).toBeGreaterThanOrEqual(160);
  });

  it('the Capital crane reaches every pad point and stows on the roof', () => {
    const rig = rigById(CAPITAL_BAY.rigId)!;
    const pose = createRigPose(rig);
    const clamp = rigPartIndex(rig, 'clamp');
    const b = CAPITAL_BAY;
    fc.assert(fc.property(
      fc.double({ min: b.cx - b.padHalfW, max: b.cx + b.padHalfW, noNaN: true }),
      fc.double({ min: b.cy - b.padHalfH, max: b.cy + b.padHalfH, noNaN: true }),
      (x, y) => {
        evaluateRig(rig, play('arm-reach', 0, { x, y }), DOCK_CRANE_REACH_TICKS, pose, twoBoneIkSolve);
        return pose.ikReached && Math.hypot(pose.x[clamp]! - x, pose.y[clamp]! - y) < 1e-6;
      },
    ), { numRuns: 300 });
    // Stowed: every arm part, and the boom's far end, on the 560 roof.
    evaluateRig(rig, null, 0, pose);
    for (const id of ['plinth', 'boom', 'jib', 'clamp']) {
      const i = rigPartIndex(rig, id);
      expect(Math.abs(pose.x[i]!), id).toBeLessThan(b.halfW);
      expect(Math.abs(pose.y[i]!), id).toBeLessThan(b.halfH);
    }
    const boom = rigPartIndex(rig, 'boom');
    const endX = pose.x[boom]! + (DOCK_CRANE_BOOM + 8) * pose.cos[boom]!;
    expect(Math.abs(endX)).toBeLessThanOrEqual(b.halfW);
    // The lip apron starts at the Capital's open edge and covers its pad.
    const lip = rig.parts[rigPartIndex(rig, 'lip')]!;
    expect(lip.anchorY).toBe(b.halfH);
    const ys = lip.outline!.filter((_, k) => k % 2 === 1);
    expect(lip.anchorY + Math.max(...ys)).toBeGreaterThanOrEqual(b.cy + b.padHalfH);
  });
});

describe('craneBayWorldCentre (structure-restyle 3h)', () => {
  it('maps the bay centre through the host pose: rot 0, 90, 180 and a CAPITAL offset', () => {
    const near = (p: { x: number; y: number }, x: number, y: number): void => {
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    };
    near(craneBayWorldCentre(FREIGHT_DOCK_BAY, 0, 0, 0), DOCK_BAY_CX, DOCK_BAY_CY);
    near(craneBayWorldCentre(FREIGHT_DOCK_BAY, 100, -50, 0), 100 + DOCK_BAY_CX, -50 + DOCK_BAY_CY);
    // 90° CCW: host +y points to world -x.
    near(craneBayWorldCentre(FREIGHT_DOCK_BAY, 0, 0, 90), -DOCK_BAY_CY, DOCK_BAY_CX);
    near(craneBayWorldCentre(FREIGHT_DOCK_BAY, 10, 20, 180), 10 - DOCK_BAY_CX, 20 - DOCK_BAY_CY);
    near(craneBayWorldCentre(CAPITAL_BAY, 0, 0, 0), CAPITAL_BAY.cx, CAPITAL_BAY.cy);
  });

  it('is the inverse of the host-frame bay test: the centre is always on the bay', () => {
    fc.assert(fc.property(
      fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: 0, max: 359 }),
      (x, y, rot) => {
        for (const bay of CRANE_BAYS) {
          const w = craneBayWorldCentre(bay, x, y, rot);
          const a = (rot * Math.PI) / 180;
          const dx = w.x - x, dy = w.y - y;
          if (!inCraneBay(bay, dx * Math.cos(a) + dy * Math.sin(a), -dx * Math.sin(a) + dy * Math.cos(a))) return false;
        }
        return true;
      },
    ));
  });
});
