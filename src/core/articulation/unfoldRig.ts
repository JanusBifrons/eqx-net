/**
 * Unfold from a crate (sunday base loop): a structure placed from its crate
 * UNFOLDS on its EXISTING rig. A grid of cosmetic panel parts starts stacked
 * in a crate-sized block at the host's centre and slides out, ring by ring,
 * to tile the full footprint; then the seams glow, then they fuse (the
 * client fades the panels into the real art). Packing plays the same clip
 * backwards (`pack`, the exact time-reverse of `unfold`).
 *
 * No new animation system: the panels are ordinary slide parts and both
 * clips are ordinary clips (`rig.ts` / `evaluate.ts`). Each panel's slide
 * axis points from the host centre to its rest centre, so slide `-|centre|`
 * puts it on the crate block and 0 (rest) is its place in the footprint.
 * Parts without a track rest, so the crane (or anything else on the rig)
 * rests while the unfold plays.
 *
 * Invariant 16: the server starts `unfold` on placement as an ordinary clip
 * record (`{clipId, startTick}` on the structure row), so the client poses it
 * from the clip time: a late joiner sees the finished structure (the clip has
 * long held its end pose, the rest pose), never a replay.
 * `unfoldPosition` reads that record as a scrubbed 0..1 position.
 */
import { box, rigClipIndex, type ClipDef, type KeyframeDef, type PartDef, type Rig, type RigDef, type TrackDef } from './rig.js';
import type { PlayingClip } from './evaluate.js';

/** Clip ids every unfolding rig carries. */
export const UNFOLD_CLIP = 'unfold';
export const PACK_CLIP = 'pack';
/** Panel part id prefix (`unfold-<col>-<row>`). */
export const UNFOLD_PART_PREFIX = 'unfold-';

/** Whole clip: 4 s of game time (60 ticks / s). */
export const UNFOLD_TICKS = 240;
/** Clip position (0..1) where the panels are all out (the slides end). */
export const UNFOLD_OUT_AT = 0.7;
/** Clip position where the seams have glown up and start to fuse. */
export const UNFOLD_FUSE_AT = 0.85;

/** A rig's unfold layout: a `cols` × `rows` grid of panels over a `w` × `h`
 *  footprint (host frame, centre origin). Each panel is one crate face. */
export interface UnfoldSpec {
  readonly w: number;
  readonly h: number;
  readonly cols: number;
  readonly rows: number;
}

/** The ring of panel (c, r): 0 for the innermost, counting out. */
function ringOf(spec: UnfoldSpec, c: number, r: number): number {
  const dc = Math.abs(c - (spec.cols - 1) / 2);
  const dr = Math.abs(r - (spec.rows - 1) / 2);
  return Math.floor(Math.max(dc, dr));
}

/** Number of rings in `spec`'s grid. */
function ringCount(spec: UnfoldSpec): number {
  return ringOf(spec, 0, 0) + 1;
}

interface Panel { id: string; cx: number; cy: number; ring: number }

/** Every panel, outermost ring first (so the inner rings draw on top of the
 *  stack and slide off it first, uncovering the next ring down). */
function panels(spec: UnfoldSpec): Panel[] {
  const pw = spec.w / spec.cols, ph = spec.h / spec.rows;
  const out: Panel[] = [];
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      out.push({
        id: `${UNFOLD_PART_PREFIX}${c}-${r}`,
        cx: -spec.w / 2 + pw * (c + 0.5), cy: -spec.h / 2 + ph * (r + 0.5), ring: ringOf(spec, c, r),
      });
    }
  }
  return out.sort((a, b) => b.ring - a.ring);
}

/** The panel parts: over-layer cosmetic slides, rest = in place. */
function panelParts(spec: UnfoldSpec): PartDef[] {
  const pw = spec.w / spec.cols, ph = spec.h / spec.rows;
  return panels(spec).map((p): PartDef => {
    const d = Math.hypot(p.cx, p.cy);
    return {
      id: p.id, parent: null, anchorX: p.cx, anchorY: p.cy,
      // A panel on the centre (odd grid) never moves: any axis, zero travel.
      joint: { type: 'slide', axisX: d > 0 ? p.cx : 1, axisY: d > 0 ? p.cy : 0, min: -d, max: 0 },
      rest: 0, layer: 'over', kind: 'cosmetic',
      outline: box(-pw / 2, -ph / 2, pw / 2, ph / 2),
    };
  });
}

/** The unfold clip: ring k slides out over its share of [0, UNFOLD_OUT_AT],
 *  the inner ring first; every track holds to the clip's end (the glow and
 *  fuse), so the clip's last tick is `UNFOLD_TICKS`. */
function unfoldClip(spec: UnfoldSpec): ClipDef {
  const rings = ringCount(spec);
  const out = UNFOLD_TICKS * UNFOLD_OUT_AT;
  // Each ring moves for `move` ticks; ring starts are staggered evenly.
  const move = out / (1 + (rings - 1) * 0.5);
  const tracks = panels(spec).map((p): TrackDef => {
    const d = Math.hypot(p.cx, p.cy);
    const start = Math.round(p.ring * move * 0.5);
    const end = Math.round(start + move);
    const keys: KeyframeDef[] = [{ tick: 0, value: -d }];
    if (start > 0) keys.push({ tick: start, value: -d });
    keys.push({ tick: end, value: 0, ease: 'inOut' }, { tick: UNFOLD_TICKS, value: 0 });
    return { part: p.id, keys };
  });
  return { id: UNFOLD_CLIP, tracks };
}

/** The reverse of an ease (the same curve run backwards in time). */
function reverseEase(e: KeyframeDef['ease']): KeyframeDef['ease'] {
  return e === 'in' ? 'out' : e === 'out' ? 'in' : e;
}

/** `clip` run backwards over `[0, total]`: its pose at tick t is `clip`'s at
 *  `total - t`. Every track must key tick 0 and tick `total`. */
export function reverseClip(clip: ClipDef, id: string, total: number): ClipDef {
  return {
    id,
    tracks: clip.tracks.map((t): TrackDef => {
      const k = t.keys;
      if (k[0]?.tick !== 0 || k[k.length - 1]?.tick !== total) throw new Error(`reverseClip '${clip.id}': track '${t.part}' must key 0 and ${total}`);
      const keys: KeyframeDef[] = [];
      for (let i = k.length - 1; i >= 0; i--) {
        // The curve INTO reversed key i is old key i+1's curve, reversed.
        const into = i < k.length - 1 ? reverseEase(k[i + 1]!.ease ?? 'inOut') : undefined;
        keys.push({ tick: total - k[i]!.tick, value: k[i]!.value!, ...(into !== undefined ? { ease: into } : {}) });
      }
      return { part: t.part, keys };
    }),
  };
}

/** `def` with the unfold panels and the `unfold` / `pack` clips added. The
 *  panels go first so they draw under the rig's own over parts (a crane
 *  stowed on the roof stays on top); the clips go last, so the existing
 *  clips keep their wire indices. */
export function withUnfold(def: RigDef, spec: UnfoldSpec): RigDef {
  const unfold = unfoldClip(spec);
  return {
    ...def,
    parts: [...panelParts(spec), ...def.parts],
    clips: [...def.clips, unfold, reverseClip(unfold, PACK_CLIP, UNFOLD_TICKS)],
  };
}

/** The rig unfolds (it carries the `unfold` clip). */
export function rigUnfolds(rig: Rig): boolean {
  return rigClipIndex(rig, UNFOLD_CLIP) >= 0;
}

/** A panel part of an unfolding rig. */
export function isUnfoldPart(rig: Rig, i: number): boolean {
  return rig.partIds[i]!.startsWith(UNFOLD_PART_PREFIX);
}

/**
 * The unfold position, 0 (a crate) .. 1 (unfolded and fused), at `nowTick`
 * under clip record `playing`: the `unfold` clip scrubs 0 -> 1 over its
 * length, `pack` 1 -> 0; no record or any other clip is 1 (standing).
 * Alloc-free.
 */
export function unfoldPosition(playing: PlayingClip | null, nowTick: number): number {
  if (playing === null) return 1;
  const un = playing.clipId === UNFOLD_CLIP;
  if (!un && playing.clipId !== PACK_CLIP) return 1;
  let f = (nowTick - playing.startTick) / UNFOLD_TICKS;
  f = f > 0 ? (f < 1 ? f : 1) : 0;
  return un ? f : 1 - f;
}

/** The record that poses `unfold` at position `p` (0..1): scrub with
 *  `evaluateRig(rig, rec, p * UNFOLD_TICKS, pose)`. */
export const UNFOLD_SCRUB: PlayingClip = { clipId: UNFOLD_CLIP, startTick: 0 };

/** Is the unfold clip still playing (the crane must wait)? True for `unfold`
 *  or `pack` before its end. */
export function unfoldBusy(playing: PlayingClip | null | undefined, nowTick: number): boolean {
  if (playing === null || playing === undefined) return false;
  if (playing.clipId !== UNFOLD_CLIP && playing.clipId !== PACK_CLIP) return false;
  return nowTick - playing.startTick < UNFOLD_TICKS;
}
