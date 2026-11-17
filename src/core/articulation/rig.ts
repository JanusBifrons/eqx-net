/**
 * Articulation rig model (structure-restyle 2a, plan §5).
 *
 * A rig is a tree of PARTS attached to a host entity (a structure or a ship;
 * nothing here knows which). Each part has one joint:
 *  - hinge: an angle (rad) about the part's anchor, within [min, max];
 *  - slide: an offset (world units) along a local axis, within [min, max].
 *
 * CLIPS are keyframed joint targets over GAME ticks. A clip only drives
 * clip-owned joints (deploy slides, door hinges, arm segments); a weapon
 * mount's angle stays owned by `WeaponMountController.tickSlot` (invariant
 * #12). A mount rides a moving part through `mountBridge.ts`, which exposes
 * the part's pose as the mount's parent frame and never writes the angle.
 *
 * `buildRig` validates a definition once and compiles it to index arrays so
 * `evaluateRig` (evaluate.ts) runs with no lookups by id and no allocation.
 */
import { easeCode, type EaseId } from './easing.js';

export type DrawLayer = 'under' | 'plane' | 'over';
/** cosmetic = drawn only; physical = a kinematic body in the physics worker (2d). */
export type PartKind = 'cosmetic' | 'physical';

export interface HingeJointDef {
  readonly type: 'hinge';
  /** Angle limits (rad), relative to the part's base angle. */
  readonly min: number;
  readonly max: number;
}

export interface SlideJointDef {
  readonly type: 'slide';
  /** Slide direction in the part's frame before the joint (parent angle +
   *  `baseAngle`); normalised at build. Default (1, 0). */
  readonly axisX?: number;
  readonly axisY?: number;
  /** Offset limits (world units) along the axis. */
  readonly min: number;
  readonly max: number;
}

export type JointDef = HingeJointDef | SlideJointDef;

export interface PartDef {
  readonly id: string;
  /** Parent part id, or null for a part fixed to the host. */
  readonly parent: string | null;
  /** Anchor offset in the parent's frame (host frame for a root part). */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Fixed orientation of the part in its parent's frame (rad). Default 0. */
  readonly baseAngle?: number;
  readonly joint: JointDef;
  /** Joint value at rest (no clip, or before a clip starts). */
  readonly rest: number;
  readonly layer: DrawLayer;
  readonly kind: PartKind;
  /** Optional outline in the part's own frame, flat [x0, y0, x1, y1, ...]
   *  (render 2c and physics 2d read it; evaluation ignores it). */
  readonly outline?: readonly number[];
}

export interface KeyframeDef {
  /** Game ticks from the clip start. */
  readonly tick: number;
  /** Joint value at this key. Ignored when `fromTarget` is set. */
  readonly value?: number;
  /** Take the value from the IK solution for the clip's target (targeted
   *  clips only; the track's part must be in the clip's `ik.chain`). */
  readonly fromTarget?: boolean;
  /** Curve INTO this key from the previous one. Default 'inOut'. */
  readonly ease?: EaseId;
}

export interface TrackDef {
  readonly part: string;
  /** Strictly increasing ticks. A first key after tick 0 eases from rest. */
  readonly keys: readonly KeyframeDef[];
}

export interface IkChainDef {
  /** Part ids root -> tip; each part's parent is the previous one. */
  readonly chain: readonly string[];
  /** End effector in the tip part's frame. */
  readonly tipX: number;
  readonly tipY: number;
}

export interface ClipDef {
  readonly id: string;
  readonly tracks: readonly TrackDef[];
  /** Present on a targeted clip (e.g. arm-reach). */
  readonly ik?: IkChainDef;
}

export interface RigDef {
  readonly id: string;
  readonly parts: readonly PartDef[];
  readonly clips: readonly ClipDef[];
}

export const JOINT_HINGE = 0;
export const JOINT_SLIDE = 1;

/** A compiled track: flat key arrays, read-only after build. */
export interface CompiledTrack {
  readonly part: number;
  readonly ticks: Float64Array;
  readonly values: Float64Array;
  readonly ease: Uint8Array;
  /** 1 where the key's value comes from the IK solution. */
  readonly fromTarget: Uint8Array;
  /** Position of the track's part in the clip's IK chain, or -1. */
  readonly chainSlot: number;
}

export interface CompiledClip {
  readonly id: string;
  readonly tracks: readonly CompiledTrack[];
  /** Per part (rig order): index into `tracks`, or -1 (part stays at rest). */
  readonly trackOfPart: Int16Array;
  /** Last key tick over all tracks: after it the clip holds. */
  readonly endTick: number;
  /** IK chain part indices root -> tip (empty for a plain clip). */
  readonly chain: Int16Array;
  readonly tipX: number;
  readonly tipY: number;
}

/** A built rig. Parts are in topological order (every parent before its
 *  children); `parent[i]` is -1 for a host-fixed part. */
export interface Rig {
  readonly id: string;
  readonly partCount: number;
  readonly partIds: readonly string[];
  readonly parts: readonly PartDef[];
  readonly parent: Int16Array;
  readonly jointType: Uint8Array;
  readonly anchorX: Float64Array;
  readonly anchorY: Float64Array;
  readonly baseAngle: Float64Array;
  readonly axisX: Float64Array;
  readonly axisY: Float64Array;
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly rest: Float64Array;
  readonly clips: readonly CompiledClip[];
  /** Longest IK chain over all clips (sizes the pose's IK scratch). */
  readonly maxChain: number;
}

function fail(rig: string, msg: string): never {
  throw new Error(`articulation rig '${rig}': ${msg}`);
}

/** Validate and compile a rig definition. Throws on a malformed definition
 *  (build time only, never in the evaluation path). */
export function buildRig(def: RigDef): Rig {
  const rid = def.id;
  const byId = new Map<string, PartDef>();
  for (const p of def.parts) {
    if (byId.has(p.id)) fail(rid, `duplicate part '${p.id}'`);
    byId.set(p.id, p);
  }
  // Topological order: stable (definition order) DFS from parents.
  const ordered: PartDef[] = [];
  const state = new Map<string, number>(); // 1 visiting, 2 done
  const visit = (p: PartDef): void => {
    const s = state.get(p.id);
    if (s === 2) return;
    if (s === 1) fail(rid, `parent cycle at '${p.id}'`);
    state.set(p.id, 1);
    if (p.parent !== null) {
      const par = byId.get(p.parent);
      if (!par) fail(rid, `part '${p.id}' has unknown parent '${p.parent}'`);
      visit(par);
    }
    state.set(p.id, 2);
    ordered.push(p);
  };
  for (const p of def.parts) visit(p);

  const n = ordered.length;
  if (n > 0x7fff) fail(rid, 'too many parts');
  const index = new Map<string, number>();
  ordered.forEach((p, i) => index.set(p.id, i));
  const parent = new Int16Array(n);
  const jointType = new Uint8Array(n);
  const anchorX = new Float64Array(n);
  const anchorY = new Float64Array(n);
  const baseAngle = new Float64Array(n);
  const axisX = new Float64Array(n);
  const axisY = new Float64Array(n);
  const min = new Float64Array(n);
  const max = new Float64Array(n);
  const rest = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = ordered[i]!;
    const j = p.joint;
    if (!(j.min <= j.max)) fail(rid, `part '${p.id}' has min > max`);
    if (!(p.rest >= j.min && p.rest <= j.max)) fail(rid, `part '${p.id}' rest is outside its limits`);
    if (p.outline && p.outline.length % 2 !== 0) fail(rid, `part '${p.id}' outline has an odd length`);
    parent[i] = p.parent === null ? -1 : index.get(p.parent)!;
    anchorX[i] = p.anchorX;
    anchorY[i] = p.anchorY;
    baseAngle[i] = p.baseAngle ?? 0;
    min[i] = j.min;
    max[i] = j.max;
    rest[i] = p.rest;
    if (j.type === 'hinge') {
      jointType[i] = JOINT_HINGE;
    } else {
      jointType[i] = JOINT_SLIDE;
      const ax = j.axisX ?? 1;
      const ay = j.axisY ?? 0;
      const len = Math.sqrt(ax * ax + ay * ay);
      if (!(len > 0)) fail(rid, `part '${p.id}' has a zero slide axis`);
      axisX[i] = ax / len;
      axisY[i] = ay / len;
    }
  }

  let maxChain = 0;
  const clipIds = new Set<string>();
  const clips = def.clips.map((c): CompiledClip => {
    if (clipIds.has(c.id)) fail(rid, `duplicate clip '${c.id}'`);
    clipIds.add(c.id);
    const chain = new Int16Array(c.ik ? c.ik.chain.length : 0);
    if (c.ik) {
      if (c.ik.chain.length === 0) fail(rid, `clip '${c.id}' has an empty IK chain`);
      c.ik.chain.forEach((pid, k) => {
        const pi = index.get(pid);
        if (pi === undefined) fail(rid, `clip '${c.id}' IK chain names unknown part '${pid}'`);
        if (k > 0 && parent[pi] !== chain[k - 1]) fail(rid, `clip '${c.id}' IK chain is not a parent chain at '${pid}'`);
        chain[k] = pi;
      });
      if (chain.length > maxChain) maxChain = chain.length;
    }
    const trackOfPart = new Int16Array(n).fill(-1);
    let endTick = 0;
    const tracks = c.tracks.map((t, ti): CompiledTrack => {
      const pi = index.get(t.part);
      if (pi === undefined) fail(rid, `clip '${c.id}' tracks unknown part '${t.part}'`);
      if (trackOfPart[pi] !== -1) fail(rid, `clip '${c.id}' has two tracks for '${t.part}'`);
      trackOfPart[pi] = ti;
      if (t.keys.length === 0) fail(rid, `clip '${c.id}' track '${t.part}' has no keys`);
      const chainSlot = chain.indexOf(pi);
      const m = t.keys.length;
      const ticks = new Float64Array(m);
      const values = new Float64Array(m);
      const ease = new Uint8Array(m);
      const fromTarget = new Uint8Array(m);
      let prev = -Infinity;
      t.keys.forEach((k, ki) => {
        if (!(k.tick >= 0) || !(k.tick > prev)) fail(rid, `clip '${c.id}' track '${t.part}' key ticks must be >= 0 and increasing`);
        prev = k.tick;
        ticks[ki] = k.tick;
        if (k.fromTarget) {
          if (chainSlot < 0) fail(rid, `clip '${c.id}' track '${t.part}' uses the target but is not in the IK chain`);
          fromTarget[ki] = 1;
          values[ki] = rest[pi]!; // fallback when no target / solver
        } else {
          if (k.value === undefined || !Number.isFinite(k.value)) fail(rid, `clip '${c.id}' track '${t.part}' key needs a value`);
          values[ki] = k.value;
        }
        ease[ki] = easeCode(k.ease ?? 'inOut');
      });
      if (prev > endTick) endTick = prev;
      return { part: pi, ticks, values, ease, fromTarget, chainSlot };
    });
    return { id: c.id, tracks, trackOfPart, endTick, chain, tipX: c.ik?.tipX ?? 0, tipY: c.ik?.tipY ?? 0 };
  });

  return {
    id: rid, partCount: n, partIds: ordered.map((p) => p.id), parts: ordered,
    parent, jointType, anchorX, anchorY, baseAngle, axisX, axisY, min, max, rest,
    clips, maxChain,
  };
}

/** Index of part `id` in rig order, or -1. Build/setup time only. */
export function rigPartIndex(rig: Rig, id: string): number {
  return rig.partIds.indexOf(id);
}

/** Index of clip `id`, or -1. Allocation-free linear scan (rigs hold few clips). */
export function rigClipIndex(rig: Rig, id: string): number {
  const cs = rig.clips;
  for (let i = 0; i < cs.length; i++) if (cs[i]!.id === id) return i;
  return -1;
}
