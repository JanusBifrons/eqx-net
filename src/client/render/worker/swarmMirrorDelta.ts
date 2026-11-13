/**
 * Render-mirror post delta (2026-11-13): the swarm map crosses to the
 * renderer worker as a CHANGE SET, not a full structured clone.
 *
 * Before, every MIRROR_UPDATE cloned every swarm entry with its 10-slot pose
 * ring, so a field of ~1,000 resting wreck pieces cost the main thread a clone
 * of ~1,000 objects + 10,000 ring slots per frame, for pieces that had not
 * moved (~10 % of the main thread at ~480 pieces; capital-destruction.md
 * "Client cost per wreck piece"). Now the worker keeps its own copy
 * (`SwarmMirrorReplica`) and each post carries only:
 *  - `full`: entries that are new, or whose non-pose fields changed (a flag,
 *    a mount-angle array, a key added or removed): cloned whole;
 *  - `pose`: entries whose ONLY changes are the hot pose fields (`HOT_KEYS`)
 *    and new pose-ring slots: packed into a float64 buffer that is TRANSFERRED
 *    and handed back on FEEDBACK (no per-frame allocation at steady state);
 *  - `removed`: ids gone since the last post.
 * An unchanged entry (a sleeping piece) is skipped entirely.
 *
 * Change detection is GENERIC over the entry's own keys against a shadow of
 * what was last posted, so a field added to `SwarmRenderState` later is synced
 * without touching this file (#15: the worker's view must equal the main
 * thread's; lock `swarmMirrorDelta.test.ts`). Arrays compare element-wise;
 * `poseRing` is tracked by identity + `ringHead` + `lastUpdateTick` (only the
 * decoder writes it, always advancing both). The scan is O(entries) of cheap
 * compares; the POST is O(changed) (count gate in the same test).
 *
 * Pose record layout (float64): `id, <HOT_KEYS…>, sleeping, nSlots`, then
 * `nSlots ×` `slot, x, y, angle, vx, vy, angvel, arrivalMs, serverTick,
 * sleeping, empty`.
 */

import type { PoseRingEntry, SwarmRenderState } from '@core/contracts/IRenderer';
import type { SwarmDeltaMsg } from './protocol';

/** Numeric pose fields the packed path carries (`sleeping` rides beside them). */
const HOT_KEYS = [
  'x', 'y', 'vx', 'vy', 'angle', 'angvel',
  'prevX', 'prevY', 'prevAngle', 'prevArrivalMs', 'latestArrivalMs',
  'lastUpdateTick', 'ringHead',
] as const;
const HOT: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
for (const k of HOT_KEYS) HOT[k] = true;
HOT['sleeping'] = true;

/** Floats per pose record before its ring slots: id + HOT_KEYS + sleeping + nSlots. */
export const POSE_HEADER = 1 + HOT_KEYS.length + 2;
/** Floats per ring slot: index + 10 fields. */
export const POSE_SLOT_STRIDE = 11;

const UNCHANGED = 0;
const POSE_ONLY = 1;
const WHOLE = 2;

type Rec = Record<string, unknown>;

interface Shadow {
  ref: SwarmRenderState | null;
  ringRef: PoseRingEntry[] | null;
  /** Last posted value per key (arrays copied into shadow-owned arrays). */
  vals: Rec;
  nKeys: number;
  gen: number;
}

function sameArray(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && !(x !== x && y !== y)) return false;
  }
  return true;
}

/** Per-post counts, for the count gate and diagnostics. */
export interface SwarmDeltaStats {
  full: number;
  pose: number;
  removed: number;
  poseFloats: number;
}

/**
 * Main-thread side. `encode` fills the reused `msg` (and the pooled pose
 * buffer); after `postMessage(…, [msg.pose])` call `posted()`; hand returned
 * buffers to `returnBuffer`.
 */
export class SwarmDeltaEncoder {
  readonly msg: SwarmDeltaMsg = {
    reset: true, present: false, fullIds: [], full: [], removed: [], pose: null, poseLen: 0,
  };
  readonly stats: SwarmDeltaStats = { full: 0, pose: 0, removed: 0, poseFloats: 0 };
  private readonly shadows = new Map<number, Shadow>();
  private readonly shadowPool: Shadow[] = [];
  private lastSwarm: Map<number, SwarmRenderState> | undefined | null = null;
  private gen = 0;
  private buf: Float64Array | null = null;
  private readonly freeBufs: ArrayBuffer[] = [];

  /** A pose buffer the worker handed back (detached ones are dropped). */
  returnBuffer(ab: ArrayBuffer): void {
    if (ab.byteLength > 0 && this.freeBufs.length < 4) this.freeBufs.push(ab);
  }

  /** Build the change set for `swarm` against what was last posted. */
  encode(swarm: Map<number, SwarmRenderState> | undefined): SwarmDeltaMsg {
    const msg = this.msg;
    msg.fullIds.length = 0;
    msg.full.length = 0;
    msg.removed.length = 0;
    msg.pose = null;
    msg.poseLen = 0;
    msg.reset = swarm !== this.lastSwarm;
    msg.present = swarm !== undefined;
    if (msg.reset) {
      for (const s of this.shadows.values()) this.releaseShadow(s);
      this.shadows.clear();
      this.lastSwarm = swarm;
    }
    const gen = ++this.gen;
    let len = 0;
    let poseCount = 0;
    if (swarm) {
      for (const [id, e] of swarm) {
        let s = this.shadows.get(id);
        if (s === undefined) {
          s = this.takeShadow();
          this.shadows.set(id, s);
          this.pushWhole(id, e, s);
        } else {
          const c = classify(e, s);
          if (c === WHOLE) this.pushWhole(id, e, s);
          else if (c === POSE_ONLY) {
            len = this.packPose(id, e, s, len);
            poseCount++;
            recordShadow(e, s);
          }
        }
        s.gen = gen;
      }
    }
    for (const [id, s] of this.shadows) {
      if (s.gen !== gen) {
        msg.removed.push(id);
        this.shadows.delete(id);
        this.releaseShadow(s);
      }
    }
    if (len > 0 && this.buf) {
      msg.pose = this.buf.buffer as ArrayBuffer;
      msg.poseLen = len;
    }
    const st = this.stats;
    st.full = msg.full.length;
    st.pose = poseCount;
    st.removed = msg.removed.length;
    st.poseFloats = len;
    return msg;
  }

  /** Call after the post: a transferred buffer is gone; an unused one is kept. */
  posted(): void {
    if (this.msg.pose !== null) this.buf = null;
    this.msg.pose = null;
  }

  private pushWhole(id: number, e: SwarmRenderState, s: Shadow): void {
    this.msg.fullIds.push(id);
    this.msg.full.push(e);
    recordShadow(e, s);
  }

  private ensure(need: number): Float64Array {
    let b = this.buf;
    if (b !== null && b.length >= need) return b;
    let next: Float64Array | null = null;
    while (this.freeBufs.length > 0) {
      const ab = this.freeBufs.pop()!;
      if (ab.byteLength / 8 >= need && (b === null || ab.byteLength / 8 > b.length)) {
        next = new Float64Array(ab); // view over a pooled buffer
        break;
      }
    }
    if (next === null) {
      // Grows to the field's peak once; steady state reuses returned buffers.
      next = new Float64Array(Math.max(need, (b?.length ?? 0) * 2, 4096));
    }
    if (b !== null) next.set(b);
    this.buf = next;
    return next;
  }

  private packPose(id: number, e: SwarmRenderState, s: Shadow, off: number): number {
    const rec = e as unknown as Rec;
    const ring = e.poseRing;
    const depth = ring.length;
    const prevHead = s.vals['ringHead'] as number;
    const prevTick = s.vals['lastUpdateTick'] as number;
    let nSlots = 0;
    if (e.ringHead !== prevHead || e.lastUpdateTick !== prevTick) {
      nSlots = (e.ringHead - prevHead + depth) % depth;
      if (nSlots === 0) nSlots = depth;
    }
    const b = this.ensure(off + POSE_HEADER + nSlots * POSE_SLOT_STRIDE);
    let o = off;
    b[o++] = id;
    for (let i = 0; i < HOT_KEYS.length; i++) b[o++] = rec[HOT_KEYS[i]!] as number;
    b[o++] = e.sleeping ? 1 : 0;
    b[o++] = nSlots;
    for (let k = nSlots; k > 0; k--) {
      const idx = (e.ringHead - k + depth) % depth;
      const p = ring[idx]!;
      b[o++] = idx;
      b[o++] = p.x; b[o++] = p.y; b[o++] = p.angle;
      b[o++] = p.vx; b[o++] = p.vy; b[o++] = p.angvel;
      b[o++] = p.arrivalMs; b[o++] = p.serverTick;
      b[o++] = p.sleeping ? 1 : 0; b[o++] = p.empty ? 1 : 0;
    }
    return o;
  }

  private takeShadow(): Shadow {
    // Pooled: one shadow per live entity, recycled on removal.
    return this.shadowPool.pop() ?? { ref: null, ringRef: null, vals: Object.create(null) as Rec, nKeys: 0, gen: 0 };
  }

  private releaseShadow(s: Shadow): void {
    s.ref = null;
    s.ringRef = null;
    for (const k in s.vals) s.vals[k] = undefined;
    this.shadowPool.push(s);
  }
}

/** UNCHANGED, POSE_ONLY (only HOT keys and the ring moved) or WHOLE. */
function classify(e: SwarmRenderState, s: Shadow): number {
  if (s.ref !== e) return WHOLE;
  const rec = e as unknown as Rec;
  const vals = s.vals;
  let hot = false;
  let n = 0;
  for (const k in rec) {
    const v = rec[k];
    if (v === undefined) continue;
    n++;
    if (k === 'poseRing') {
      if (v !== s.ringRef) return WHOLE;
      continue;
    }
    const old = vals[k];
    if (Array.isArray(v)) {
      if (!Array.isArray(old) || !sameArray(v, old)) return WHOLE;
      continue;
    }
    if (v === old || (v !== v && old !== old)) continue;
    if (HOT[k] === true && (typeof v === 'number' || typeof v === 'boolean') && old !== undefined) {
      hot = true;
      continue;
    }
    return WHOLE;
  }
  if (n !== s.nKeys) return WHOLE;
  if (!hot) return UNCHANGED;
  // The packed record writes every HOT key: one missing ⇒ send whole.
  for (let i = 0; i < HOT_KEYS.length; i++) {
    if (typeof rec[HOT_KEYS[i]!] !== 'number') return WHOLE;
  }
  return typeof e.sleeping === 'boolean' ? POSE_ONLY : WHOLE;
}

function recordShadow(e: SwarmRenderState, s: Shadow): void {
  const rec = e as unknown as Rec;
  const vals = s.vals;
  for (const k in vals) if (rec[k] === undefined) vals[k] = undefined;
  let n = 0;
  for (const k in rec) {
    const v = rec[k];
    if (v === undefined) continue;
    n++;
    if (k === 'poseRing') continue;
    if (Array.isArray(v)) {
      let a = vals[k];
      // TODO: alloc-debt — one array per array-valued key per entity, on its
      // first sighting only (never per frame).
      if (!Array.isArray(a)) { a = []; vals[k] = a; }
      const arr = a as unknown[];
      arr.length = v.length;
      for (let i = 0; i < v.length; i++) arr[i] = v[i];
    } else {
      vals[k] = v;
    }
  }
  s.ref = e;
  s.ringRef = e.poseRing;
  s.nKeys = n;
}

/** Worker side: the worker's own copy of the swarm map. */
export class SwarmMirrorReplica {
  readonly map = new Map<number, SwarmRenderState>();

  /** Apply one delta; returns the swarm to hand the renderer (undefined ⇒ none). */
  apply(d: SwarmDeltaMsg): Map<number, SwarmRenderState> | undefined {
    const map = this.map;
    if (d.reset) map.clear();
    for (let i = 0; i < d.removed.length; i++) map.delete(d.removed[i]!);
    for (let i = 0; i < d.full.length; i++) map.set(d.fullIds[i]!, d.full[i]!);
    if (d.pose !== null && d.poseLen > 0) {
      const b = new Float64Array(d.pose, 0, d.poseLen); // TODO: alloc-debt — one view per frame, worker side
      let o = 0;
      while (o < d.poseLen) {
        const e = map.get(b[o]!);
        const rec = e as unknown as Rec | undefined;
        o++;
        for (let i = 0; i < HOT_KEYS.length; i++) {
          const v = b[o++]!;
          if (rec) rec[HOT_KEYS[i]!] = v;
        }
        const sleeping = b[o++] === 1;
        const nSlots = b[o++]!;
        if (e) e.sleeping = sleeping;
        for (let k = 0; k < nSlots; k++) {
          const p = e?.poseRing[b[o]!];
          if (p) {
            p.x = b[o + 1]!; p.y = b[o + 2]!; p.angle = b[o + 3]!;
            p.vx = b[o + 4]!; p.vy = b[o + 5]!; p.angvel = b[o + 6]!;
            p.arrivalMs = b[o + 7]!; p.serverTick = b[o + 8]!;
            p.sleeping = b[o + 9] === 1; p.empty = b[o + 10] === 1;
          }
          o += POSE_SLOT_STRIDE;
        }
      }
    }
    return d.present ? map : undefined;
  }
}
