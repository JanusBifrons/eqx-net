/** Solid door rigs (docs/plans/door-power.md, slice 4): the shield gate's
 *  `gate-doors` and the airlock's `airlock-doors`. Shut (clip time 0) the
 *  leaves close the gap; open (DOOR_TRAVEL_TICKS) the whole opening is clear
 *  and every leaf sits inside its tower; an airlock clip moves only its end. */
import { describe, expect, it } from 'vitest';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { AIRLOCK_POSTS, GATE_POSTS } from '../../shared-types/structureKinds/gatePosts.js';
import { rigPartIndex, type Rig } from './rig.js';
import { createRigPose, evaluateRig, type PlayingClip, type RigPose } from './evaluate.js';
import { rigById, rigForStructureKind } from './rigCatalogue.js';
import {
  AIRLOCK_END_Y, AIRLOCK_POST_D, AIRLOCK_POST_W, DOOR_TRAVEL_TICKS, GATE_DEPTH, GATE_GAP, GATE_POST_W, gateColliderBoxes, gateGapHalf,
} from '../structures/gateGeometry.js';
import { structureOutline } from '../../shared-types/structureKinds/outline.js';
import { SOCKET_OUTLINE_STYLE } from '../../shared-types/structureKinds/structureSockets.js';
import { AIRLOCK_DOOR_OPEN_TRAVEL, DOOR_LEAF_THICKNESS } from './rigs/fences.js';
import { DOOR_POS_MAX, gateWorldAxisBoxes } from '../structures/gateGeometry.js';
import { doorLeafCount, doorRestPos, gateHitBoxes, writeDoorLeafBoxes } from '../structures/doorLeafBoxes.js';
import { PAD_SPECS, padDoorwayHalf, padHalfExtent } from '../../shared-types/teleport.js';

interface Box { x0: number; x1: number; y0: number; y1: number }

/** Host-frame bounds of part `id` (door leaves never turn: angle 0). */
function boxOf(rig: Rig, pose: RigPose, id: string): Box {
  const i = rigPartIndex(rig, id), o = rig.parts[i]!.outline!;
  expect(pose.angle[i]).toBe(0);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let j = 0; j < o.length; j += 2) {
    const x = pose.x[i]! + o[j]!, y = pose.y[i]! + o[j + 1]!;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x0, x1, y0, y1 };
}

/** Clip `clipId` evaluated at clip time `t` (started at tick 0). */
const at = (rig: Rig, pose: RigPose, clipId: string | null, t: number): RigPose =>
  evaluateRig(rig, clipId === null ? null : ({ clipId, startTick: 0 } satisfies PlayingClip), t, pose);

/** `inner` lies within `outer` (tolerance 1e-9). */
function expectInside(inner: Box, outer: Box): void {
  expect(inner.x0).toBeGreaterThanOrEqual(outer.x0 - 1e-9);
  expect(inner.x1).toBeLessThanOrEqual(outer.x1 + 1e-9);
  expect(inner.y0).toBeGreaterThanOrEqual(outer.y0 - 1e-9);
  expect(inner.y1).toBeLessThanOrEqual(outer.y1 + 1e-9);
}

const towerBox = (cx: number, cy: number, w: number, d: number): Box => ({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - d / 2, y1: cy + d / 2 });

describe('gate-doors (shield gate)', () => {
  const rig = rigForStructureKind('shield_gate')!;
  const pose = createRigPose(rig);
  const half = gateGapHalf('gate');

  it('maps shield_gate to a two-leaf physical slide rig with one door clip, DOOR_TRAVEL_TICKS long', () => {
    expect(rig).toBe(rigById('gate-doors'));
    expect(rig.partIds).toEqual(['leaf-left', 'leaf-right']);
    for (const p of rig.parts) {
      expect(p.kind).toBe('physical');
      expect(p.layer).toBe('plane');
      expect(p.joint.type).toBe('slide');
    }
    expect(rig.clips.map((c) => c.id)).toEqual(['door']);
    expect(rig.clips[0]!.endTick).toBe(DOOR_TRAVEL_TICKS);
    expect(half).toBe(88);
    expect(getStructureKind('shield_gate').footprint.w).toBe(416);
  });

  it('shut (no clip, and clip time 0): the leaves close the whole opening, tower face to tower face', () => {
    for (const clip of [null, 'door'] as const) {
      at(rig, pose, clip, 0);
      const l = boxOf(rig, pose, 'leaf-left'), r = boxOf(rig, pose, 'leaf-right');
      expect(l.x0).toBeCloseTo(-half, 9);
      expect(l.x1).toBeCloseTo(0, 9);
      expect(r.x0).toBeCloseTo(0, 9);
      expect(r.x1).toBeCloseTo(half, 9);
      // Within the gate's depth, on the centre line.
      for (const b of [l, r]) { expect(b.y0).toBeGreaterThan(-GATE_DEPTH / 2); expect(b.y1).toBeLessThan(GATE_DEPTH / 2); }
    }
  });

  it('open (clip end and after): the full opening is clear and each leaf is inside its tower', () => {
    const towers = GATE_POSTS.map(([cx, cy]) => towerBox(cx, cy, GATE_POST_W, GATE_DEPTH));
    for (const t of [DOOR_TRAVEL_TICKS, DOOR_TRAVEL_TICKS + 500]) {
      at(rig, pose, 'door', t);
      const l = boxOf(rig, pose, 'leaf-left'), r = boxOf(rig, pose, 'leaf-right');
      expect(l.x1).toBeCloseTo(-half, 9);
      expect(r.x0).toBeCloseTo(half, 9);
      expectInside(l, towers[0]!);
      expectInside(r, towers[1]!);
    }
    // The tower colliders the leaves slide into are the gate's own.
    expect(gateColliderBoxes('shield_gate')!.map((b) => b.cx)).toEqual(GATE_POSTS.map(([cx]) => cx));
  });

  it('linear: half way through the travel each leaf has slid half its length', () => {
    at(rig, pose, 'door', DOOR_TRAVEL_TICKS / 2);
    expect(boxOf(rig, pose, 'leaf-left').x1).toBeCloseTo(-half / 2, 9);
    expect(boxOf(rig, pose, 'leaf-right').x0).toBeCloseTo(half / 2, 9);
    at(rig, pose, 'door', DOOR_TRAVEL_TICKS / 4);
    expect(boxOf(rig, pose, 'leaf-right').x0).toBeCloseTo(half / 4, 9);
  });

  it('a scrubbed clip (from = end, rate -1) closes the door again', () => {
    evaluateRig(rig, { clipId: 'door', startTick: 100, from: DOOR_TRAVEL_TICKS, rate: -1 }, 100 + DOOR_TRAVEL_TICKS, pose);
    expect(boxOf(rig, pose, 'leaf-right').x0).toBeCloseTo(0, 9);
  });
});

describe('airlock-doors (shield airlock)', () => {
  const rig = rigForStructureKind('shield_airlock')!;
  const pose = createRigPose(rig);
  const half = gateGapHalf('airlock');
  const A = ['leaf-a-left', 'leaf-a-right'] as const;
  const B = ['leaf-b-left', 'leaf-b-right'] as const;

  it('maps shield_airlock to a four-leaf physical slide rig with door-a and door-b', () => {
    expect(rig).toBe(rigById('airlock-doors'));
    expect([...rig.partIds].sort()).toEqual([...A, ...B].sort());
    for (const p of rig.parts) { expect(p.kind).toBe('physical'); expect(p.joint.type).toBe('slide'); }
    expect(rig.clips.map((c) => c.id)).toEqual(['door-a', 'door-b']);
    for (const c of rig.clips) expect(c.endTick).toBe(DOOR_TRAVEL_TICKS);
    expect(half).toBe(96);
    expect(getStructureKind('shield_airlock').footprint).toEqual({ w: 392, h: 260 });
  });

  /** End `pair` (y sign `sy`) is shut: the leaves close the opening at that end. */
  function expectShut(pair: readonly [string, string], sy: number): void {
    const l = boxOf(rig, pose, pair[0]), r = boxOf(rig, pose, pair[1]);
    expect(l.x0).toBeCloseTo(-half, 9);
    expect(l.x1).toBeCloseTo(0, 9);
    expect(r.x0).toBeCloseTo(0, 9);
    expect(r.x1).toBeCloseTo(half, 9);
    for (const b of [l, r]) expect((b.y0 + b.y1) / 2).toBeCloseTo(sy * AIRLOCK_END_Y, 9);
  }

  /** End `pair` is open: each leaf is inside its corner post, leaving only a
   *  short lip in the opening (the cut corners stop the leaf short), so the
   *  clear width is still wider than the shield gate's gap. */
  function expectOpen(pair: readonly [string, string], sy: number): void {
    const posts = AIRLOCK_POSTS.filter(([, cy]) => Math.sign(cy) === sy).map(([cx, cy]) => towerBox(cx, cy, AIRLOCK_POST_W, AIRLOCK_POST_D));
    const l = boxOf(rig, pose, pair[0]), r = boxOf(rig, pose, pair[1]);
    const lip = half - AIRLOCK_DOOR_OPEN_TRAVEL;
    expect(lip).toBeGreaterThanOrEqual(0);
    expect(l.x1).toBeCloseTo(-half + lip, 9);
    expect(r.x0).toBeCloseTo(half - lip, 9);
    expect(r.x0 - l.x1).toBeGreaterThan(GATE_GAP);
    // Inside its post but for the lip on the opening side.
    const pl = posts.find((p) => p.x0 < 0)!, pr = posts.find((p) => p.x0 > 0)!;
    expectInside(l, { ...pl, x1: pl.x1 + lip });
    expectInside(r, { ...pr, x0: pr.x0 - lip });
  }

  it('no clip: both ends shut', () => {
    at(rig, pose, null, 0);
    expectShut(A, 1);
    expectShut(B, -1);
  });

  it('door-a opens only the A end (+y); B stays shut throughout', () => {
    for (let t = 0; t <= DOOR_TRAVEL_TICKS; t += 15) { at(rig, pose, 'door-a', t); expectShut(B, -1); }
    at(rig, pose, 'door-a', 0);
    expectShut(A, 1);
    at(rig, pose, 'door-a', DOOR_TRAVEL_TICKS);
    expectOpen(A, 1);
  });

  it('door-b opens only the B end (-y); A stays shut throughout', () => {
    for (let t = 0; t <= DOOR_TRAVEL_TICKS; t += 15) { at(rig, pose, 'door-b', t); expectShut(A, 1); }
    at(rig, pose, 'door-b', 0);
    expectShut(B, -1);
    at(rig, pose, 'door-b', DOOR_TRAVEL_TICKS);
    expectOpen(B, -1);
  });
});

// Bug (restyle, door leaves): a fully OPEN airlock leaf's outer tip poked
// ~7.6 past the building's cut corner (door line 98, leaf faces 87..109, the
// house-look outline's corner cut starts at 101.4), out of the tower pocket.
describe('door leaves stay inside the building (every door rig)', () => {
  /** `p` lies inside the CCW convex outline `poly` (tolerance 1e-9). */
  function insideOutline(poly: readonly { x: number; y: number }[], px: number, py: number): boolean {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      if ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) < -1e-9) return false;
    }
    return true;
  }

  for (const kind of ['shield_gate', 'shield_airlock'] as const) {
    const rig = rigForStructureKind(kind)!;
    const pose = createRigPose(rig);
    const half = gateGapHalf(kind === 'shield_gate' ? 'gate' : 'airlock');
    const outline = structureOutline(kind, SOCKET_OUTLINE_STYLE);
    const towers = gateColliderBoxes(kind)!;

    it(`${rig.id}: fully open (clip end), every leaf is inside the outline and inside a tower (its pocket)`, () => {
      for (const clip of rig.clips) {
        at(rig, pose, clip.id, clip.endTick);
        for (const id of rig.partIds) {
          const b = boxOf(rig, pose, id);
          for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]] as const) {
            expect(insideOutline(outline, x, y), `${id} corner (${x.toFixed(1)}, ${y.toFixed(1)}) in ${clip.id}`).toBe(true);
          }
          if (clip.trackOfPart[rigPartIndex(rig, id)] === -1) continue; // this clip leaves it shut
          // In its tower's pocket: the outer end and both faces inside the
          // tower block (the inner end may keep a short lip in the opening).
          const outerX = b.x0 < 0 ? b.x0 : b.x1, midY = (b.y0 + b.y1) / 2;
          const t = towers.find((p) => Math.abs(p.cx - outerX) <= p.hw && Math.abs(p.cy - midY) <= p.hh);
          expect(t, `${id} outer end sits in a tower`).toBeDefined();
          expect(b.y0).toBeGreaterThanOrEqual(t!.cy - t!.hh);
          expect(b.y1).toBeLessThanOrEqual(t!.cy + t!.hh);
          expect(Math.min(Math.abs(b.x0), Math.abs(b.x1)), `${id} lip`).toBeGreaterThanOrEqual(GATE_GAP / 2);
        }
      }
    });

    it(`${rig.id}: shut (clip start), each door line's leaves cover the whole doorway with no gap`, () => {
      for (const clip of rig.clips) {
        at(rig, pose, clip.id, 0);
        const lines = new Map<number, Box[]>();
        for (const id of rig.partIds) {
          const b = boxOf(rig, pose, id), y = Math.round((b.y0 + b.y1) / 2);
          lines.set(y, [...(lines.get(y) ?? []), b]);
        }
        for (const boxes of lines.values()) {
          boxes.sort((p, q) => p.x0 - q.x0);
          let reach = -half;
          for (const b of boxes) { expect(b.x0).toBeLessThanOrEqual(reach + 1e-9); reach = Math.max(reach, b.x1); }
          expect(reach).toBeGreaterThanOrEqual(half - 1e-9);
        }
      }
    });
  }
});

// Teleporter redesign T1: the chamber's blast doors, one leaf pair per
// doorway (local ±y ends), BOTH on one clip, resting OPEN.
describe('tp-doors (teleporter chamber)', () => {
  const CASES = [
    { kind: 'teleporter', rigId: 'tp-doors' },
    { kind: 'pocket_pad', rigId: 'tp-doors' },
    { kind: 'teleporter_large', rigId: 'tp-doors-large' },
  ] as const;
  const IDS = ['leaf-a-left', 'leaf-a-right', 'leaf-b-left', 'leaf-b-right'] as const;

  it('the transit pad is the small teleporter\'s size, so it shares tp-doors', () => {
    expect(PAD_SPECS.pocket_pad.padRadius).toBe(PAD_SPECS.teleporter.padRadius);
    expect(PAD_SPECS.pocket_pad.post).toBe(PAD_SPECS.teleporter.post);
  });

  for (const { kind, rigId } of CASES) {
    const rig = rigForStructureKind(kind)!;
    const pose = createRigPose(rig);
    const door = padDoorwayHalf(kind);
    const r = PAD_SPECS[kind].padRadius, half = padHalfExtent(kind), post = PAD_SPECS[kind].post;
    const lineY = half - post / 2;
    const walls = gateColliderBoxes(kind)!;

    it(`${kind}: four physical slide leaves on ONE clip 'door', idling on it (rest open)`, () => {
      expect(rig).toBe(rigById(rigId));
      expect([...rig.partIds]).toEqual([...IDS]);
      for (const p of rig.parts) {
        expect(p.kind).toBe('physical');
        expect(p.joint.type).toBe('slide');
        const ys = p.outline!.filter((_, k) => k % 2 === 1);
        expect(Math.max(...ys) - Math.min(...ys)).toBe(DOOR_LEAF_THICKNESS);
      }
      expect(rig.clips.map((c) => c.id)).toEqual(['door']);
      expect(rig.clips[0]!.endTick).toBe(DOOR_TRAVEL_TICKS);
      for (let i = 0; i < rig.partCount; i++) expect(rig.clips[0]!.trackOfPart[i]).toBeGreaterThanOrEqual(0);
      expect(rig.idleClip).toBe(0);
    });

    it(`${kind}: no clip = OPEN: both doorways fully clear, each leaf inside its wall stub`, () => {
      at(rig, pose, null, 0);
      for (const id of IDS) {
        const b = boxOf(rig, pose, id);
        expect(Math.min(Math.abs(b.x0), Math.abs(b.x1)), id).toBeCloseTo(door, 9);
        expect(Math.max(Math.abs(b.x0), Math.abs(b.x1)), id).toBeLessThanOrEqual(r + 1e-9);
        const midX = (b.x0 + b.x1) / 2, midY = (b.y0 + b.y1) / 2;
        const stub = walls.find((w) => Math.abs(w.cx - midX) < 1e-9 && Math.abs(w.cy - midY) < 1e-9);
        expect(stub, `${id} in a stub`).toBeDefined();
        expectInside(b, { x0: stub!.cx - stub!.hw, x1: stub!.cx + stub!.hw, y0: stub!.cy - stub!.hh, y1: stub!.cy + stub!.hh });
      }
      // The clip's end pose is the same open pose.
      at(rig, pose, 'door', DOOR_TRAVEL_TICKS);
      expect(boxOf(rig, pose, 'leaf-b-right').x0).toBeCloseTo(door, 9);
    });

    it(`${kind}: clip time 0 = shut: BOTH doorways covered edge to edge on the wall line`, () => {
      at(rig, pose, 'door', 0);
      for (const [l, rr, sy] of [['leaf-a-left', 'leaf-a-right', 1], ['leaf-b-left', 'leaf-b-right', -1]] as const) {
        const a = boxOf(rig, pose, l), b = boxOf(rig, pose, rr);
        expect(a.x0).toBeCloseTo(-door, 9);
        expect(a.x1).toBeCloseTo(0, 9);
        expect(b.x0).toBeCloseTo(0, 9);
        expect(b.x1).toBeCloseTo(door, 9);
        for (const q of [a, b]) {
          expect((q.y0 + q.y1) / 2).toBeCloseTo(sy * lineY, 9);
          expect(Math.min(Math.abs(q.y0), Math.abs(q.y1))).toBeGreaterThanOrEqual(r); // off the pad floor
        }
      }
    });

    it(`${kind}: hit boxes spawn with the doors at rest (open); a re-pose to 0 shuts them`, () => {
      expect(doorRestPos(kind)).toBe(DOOR_POS_MAX);
      for (const angle of [0, Math.PI / 2, Math.PI]) {
        const boxes = gateHitBoxes(kind, angle)!;
        const n = doorLeafCount(kind);
        expect(n).toBe(4);
        const fixed = gateWorldAxisBoxes(kind, angle)!;
        const open = new Float32Array(boxes);
        writeDoorLeafBoxes(kind, angle, DOOR_POS_MAX, DOOR_POS_MAX, open);
        expect([...boxes]).toEqual([...open]);
        // Open: the doorway (local x = ±door/2, on the door line) is clear.
        const c = Math.cos(angle), s = Math.sin(angle);
        const clear = (bx: Float32Array): boolean => {
          for (const sy of [1, -1]) for (const lx of [-door / 2, door / 2]) {
            const px = lx * c - sy * lineY * s, py = lx * s + sy * lineY * c;
            for (let i = 0; i < bx.length; i += 4) {
              if (Math.abs(px - bx[i]!) < bx[i + 2]! && Math.abs(py - bx[i + 1]!) < bx[i + 3]!) return false;
            }
          }
          return true;
        };
        expect(clear(boxes)).toBe(true);
        expect(boxes.length).toBe(fixed.length + n * 4);
        const shut = new Float32Array(boxes);
        writeDoorLeafBoxes(kind, angle, 0, 0, shut);
        expect(clear(shut)).toBe(false);
      }
    });
  }

  it("gates still rest shut, and the Ancients' gate has no doors", () => {
    expect(doorRestPos('shield_gate')).toBe(0);
    expect(doorRestPos('shield_airlock')).toBe(0);
    expect(rigForStructureKind('alien_gate')?.id).toBe('alien-astrolabe'); // rings only, no door clip
    expect(doorLeafCount('alien_gate')).toBe(0);
    expect(doorRestPos('alien_gate')).toBe(0);
  });
});
