/**
 * Solid doors on the server hit path (docs/plans/door-power.md, slice 10b).
 *
 * The server tests weapons against a gate with main-thread geometry, not the
 * worker's Rapier bodies: a gate's swarm record carries `boxes`, flat
 * `[offsetX, offsetY, halfW, halfH, ...]` world-axis boxes from its centre
 * (`gateWorldAxisBoxes`: posts and towers, gap open). This module appends one
 * box per PHYSICAL door leaf of the kind's rig (`rigs/fences.ts`
 * GATE_DOORS_DEF / AIRLOCK_DOORS_DEF) and re-poses them in place from the door
 * positions, so a shut leaf covers the gap and blocks shots (the hit lands on
 * the gate through the normal structure-damage path) while a fully open leaf
 * sits in its tower pocket and the gap is clear.
 *
 * Leaf size and travel come only from the rig def: each leaf is posed by the
 * shared rig evaluator at the door's clip time (`doorClipTime`), and its box is
 * the AABB of its outline in that pose. Nothing is copied from the def.
 */
import { rigForStructureKind } from '../articulation/rigCatalogue.js';
import { createRigPose, evaluateRig, type RigPose } from '../articulation/evaluate.js';
import type { Rig } from '../articulation/rig.js';
import { doorClipTime } from './doorMotion.js';
import { DOOR_POS_MAX, DOOR_POWER_LEVELS, gateWorldAxisBoxes } from './gateGeometry.js';

/** One kind's leaf layout, built once per kind. */
interface LeafLayout {
  readonly rig: Rig;
  readonly pose: RigPose;
  /** Reused scrub record for `evaluateRig` (rate 0: hold at `from`). */
  readonly playing: { clipId: string; startTick: number; from: number; rate: number };
  /** Rig part index per leaf (physical parts with an outline, rig order). */
  readonly part: Int16Array;
  /** Clip index that moves each leaf (0 when none does: it stays at rest). */
  readonly clipOf: Int16Array;
  /** Which door position drives each clip: 0 = A (`door`, `door-a`), 1 = B. */
  readonly clipDoor: Uint8Array;
  /** Leaf outline bounds in its own frame: x0, y0, x1, y1 per leaf. */
  readonly bounds: Float64Array;
}

const layouts = new Map<string, LeafLayout | null>();

function layoutFor(kind: string): LeafLayout | null {
  const hit = layouts.get(kind);
  if (hit !== undefined) return hit;
  const rig = rigForStructureKind(kind);
  let layout: LeafLayout | null = null;
  if (rig !== null) {
    const leaves: number[] = [];
    for (let i = 0; i < rig.partCount; i++) {
      const p = rig.parts[i]!;
      if (p.kind === 'physical' && p.outline !== undefined && p.outline.length >= 6) leaves.push(i);
    }
    if (leaves.length > 0) {
      const n = leaves.length;
      const part = Int16Array.from(leaves);
      const clipOf = new Int16Array(n);
      const bounds = new Float64Array(n * 4);
      for (let j = 0; j < n; j++) {
        const i = part[j]!;
        for (let c = 0; c < rig.clips.length; c++) {
          if (rig.clips[c]!.trackOfPart[i]! >= 0) { clipOf[j] = c; break; }
        }
        const o = rig.parts[i]!.outline!;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k + 1 < o.length; k += 2) {
          if (o[k]! < x0) x0 = o[k]!;
          if (o[k]! > x1) x1 = o[k]!;
          if (o[k + 1]! < y0) y0 = o[k + 1]!;
          if (o[k + 1]! > y1) y1 = o[k + 1]!;
        }
        bounds[j * 4] = x0; bounds[j * 4 + 1] = y0; bounds[j * 4 + 2] = x1; bounds[j * 4 + 3] = y1;
      }
      const clipDoor = new Uint8Array(rig.clips.length);
      for (let c = 0; c < rig.clips.length; c++) clipDoor[c] = rig.clips[c]!.id === 'door-b' ? 1 : 0;
      layout = {
        rig, pose: createRigPose(rig), playing: { clipId: '', startTick: 0, from: 0, rate: 0 },
        part, clipOf, clipDoor, bounds,
      };
    }
  }
  layouts.set(kind, layout);
  return layout;
}

/** Number of door-leaf boxes a kind's hit boxes carry (0 = not a door kind). */
export function doorLeafCount(kind: string | null | undefined): number {
  if (!kind) return 0;
  const l = layoutFor(kind);
  return l === null ? 0 : l.part.length;
}

/**
 * The door position (0 shut .. DOOR_POS_MAX open) a kind's leaves stand at
 * with no clip record: the end of its rig's `idleClip` (a teleporter
 * chamber's doors rest OPEN), else 0 (a gate's doors rest shut).
 */
export function doorRestPos(kind: string | null | undefined): number {
  const l = kind ? layoutFor(kind) : null;
  if (l === null || l.rig.idleClip < 0) return 0;
  return Math.min(DOOR_POS_MAX, Math.round(l.rig.clips[l.rig.idleClip]!.endTick * DOOR_POWER_LEVELS));
}

/**
 * A gate's hit boxes for its swarm record (spawn time, allocates once): the
 * static `gateWorldAxisBoxes` followed by one box per door leaf, posed at
 * rest (`doorRestPos`: shut on a gate, open on a teleporter chamber).
 * null ⇒ not a gate.
 */
export function gateHitBoxes(kind: string | null | undefined, angle: number, mirror?: boolean): Float32Array | null {
  const fixed = gateWorldAxisBoxes(kind, angle, mirror);
  if (fixed === null) return null;
  const leaves = doorLeafCount(kind);
  if (leaves === 0) return fixed;
  const out = new Float32Array(fixed.length + leaves * 4);
  out.set(fixed);
  const rest = doorRestPos(kind);
  writeDoorLeafBoxes(kind!, angle, rest, rest, out);
  return out;
}

/**
 * Re-pose the leaf boxes at the tail of `out` (from `gateHitBoxes`) for door
 * positions `posA` / `posB` (0..DOOR_POS_MAX; a gate uses `posA` only).
 * `angle` is the structure's rotation (rad, a quarter turn). Allocation-free.
 */
export function writeDoorLeafBoxes(kind: string, angle: number, posA: number, posB: number, out: Float32Array): void {
  const l = layoutFor(kind);
  if (l === null) return;
  const n = l.part.length;
  const base = out.length - n * 4;
  if (base < 0) return;
  // TODO(bp-16): oriented box — axis-aligned at an odd-30° turn.
  const q = (((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4);
  const qc = q === 0 ? 1 : q === 2 ? -1 : 0;
  const qs = q === 1 ? 1 : q === 3 ? -1 : 0;
  const clips = l.rig.clips;
  for (let c = 0; c < clips.length; c++) {
    l.playing.clipId = clips[c]!.id;
    l.playing.from = doorClipTime(l.clipDoor[c] === 1 ? posB : posA);
    evaluateRig(l.rig, l.playing, 0, l.pose);
    for (let j = 0; j < n; j++) {
      if (l.clipOf[j] !== c) continue;
      writeLeaf(l, j, out, base + j * 4, qc, qs, q % 2 === 1);
    }
  }
}

/** The AABB of leaf `j`'s outline in its posed frame, turned to world axes. */
function writeLeaf(l: LeafLayout, j: number, out: Float32Array, at: number, qc: number, qs: number, swap: boolean): void {
  const i = l.part[j]!;
  const { x, y, cos, sin } = l.pose;
  const c = cos[i]!, s = sin[i]!;
  const b = l.bounds;
  const bx0 = b[j * 4]!, by0 = b[j * 4 + 1]!, bx1 = b[j * 4 + 2]!, by1 = b[j * 4 + 3]!;
  // Host-frame box: centre of the outline bounds, extents rotated by the part angle.
  const mx = (bx0 + bx1) / 2, my = (by0 + by1) / 2;
  const ex = (bx1 - bx0) / 2, ey = (by1 - by0) / 2;
  const cx = x[i]! + mx * c - my * s;
  const cy = y[i]! + mx * s + my * c;
  const hw = Math.abs(ex * c) + Math.abs(ey * s);
  const hh = Math.abs(ex * s) + Math.abs(ey * c);
  out[at] = cx * qc - cy * qs;
  out[at + 1] = cx * qs + cy * qc;
  out[at + 2] = swap ? hh : hw;
  out[at + 3] = swap ? hw : hh;
}
