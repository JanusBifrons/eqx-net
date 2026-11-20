/** The Capital unfolds from its crate on its existing crane rig (`unfoldRig.ts`). */
import { describe, expect, it } from 'vitest';
import { createRigPose, evaluateRig, type PlayingClip } from './evaluate.js';
import { rigClipIndex, type Rig } from './rig.js';
import {
  CAPITAL_UNFOLD, PACK_CLIP, UNFOLD_CLIP, UNFOLD_SCRUB, UNFOLD_TICKS, isUnfoldPart, rigById, rigForStructureKind,
  unfoldBusy, unfoldPosition,
} from './rigCatalogue.js';

const capital = (): Rig => rigForStructureKind('capital')!;
const crate = CAPITAL_UNFOLD.w / CAPITAL_UNFOLD.cols; // one panel = the crate face

function poseAt(rig: Rig, playing: PlayingClip | null, tick: number) {
  const pose = createRigPose(rig);
  evaluateRig(rig, playing, tick, pose);
  return pose;
}

/** Host-frame box over every panel's outline at `pose`. */
function panelBounds(rig: Rig, pose: ReturnType<typeof createRigPose>) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < rig.partCount; i++) {
    if (!isUnfoldPart(rig, i)) continue;
    const o = rig.parts[i]!.outline!;
    for (let j = 0; j < o.length; j += 2) {
      // Panels never turn (slides on a host-fixed root).
      x0 = Math.min(x0, pose.x[i]! + o[j]!); x1 = Math.max(x1, pose.x[i]! + o[j]!);
      y0 = Math.min(y0, pose.y[i]! + o[j + 1]!); y1 = Math.max(y1, pose.y[i]! + o[j + 1]!);
    }
  }
  return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

describe('Capital unfold from its crate', () => {
  it('the capital-crane rig has an unfold clip', () => {
    const rig = rigById('capital-crane')!;
    expect(rig).toBe(capital());
    expect(rigClipIndex(rig, UNFOLD_CLIP)).toBeGreaterThanOrEqual(0);
    expect(rigClipIndex(rig, PACK_CLIP)).toBeGreaterThanOrEqual(0);
    // The crane clips keep their wire indices (unfold / pack appended).
    expect(rig.clips.slice(0, 3).map((c) => c.id)).toEqual(['arm-reach', 'arm-hold', 'arm-retract']);
    expect(rig.clips[rigClipIndex(rig, UNFOLD_CLIP)]!.endTick).toBe(UNFOLD_TICKS);
    // The panels are cosmetic only: nothing new for the physics worker.
    for (let i = 0; i < rig.partCount; i++) if (isUnfoldPart(rig, i)) expect(rig.parts[i]!.kind).toBe('cosmetic');
  });

  it('unfold at 0 is crate-sized and at 1 is the rest pose', () => {
    const rig = capital();
    const at0 = poseAt(rig, UNFOLD_SCRUB, 0);
    const b0 = panelBounds(rig, at0);
    expect(b0.w).toBeCloseTo(crate, 6);
    expect(b0.h).toBeCloseTo(crate, 6);
    expect(b0.cx).toBeCloseTo(0, 6);
    expect(b0.cy).toBeCloseTo(0, 6);
    const at1 = poseAt(rig, UNFOLD_SCRUB, UNFOLD_TICKS);
    const rest = poseAt(rig, { clipId: 'none-such', startTick: 0 }, 0); // unknown clip: every part at rest
    for (let i = 0; i < rig.partCount; i++) {
      expect(at1.x[i], rig.partIds[i]).toBeCloseTo(rest.x[i]!, 9);
      expect(at1.y[i], rig.partIds[i]).toBeCloseTo(rest.y[i]!, 9);
      expect(at1.angle[i], rig.partIds[i]).toBeCloseTo(rest.angle[i]!, 9);
    }
    const b1 = panelBounds(rig, at1);
    expect(b1.w).toBeCloseTo(CAPITAL_UNFOLD.w, 6);
    expect(b1.h).toBeCloseTo(CAPITAL_UNFOLD.h, 6);
    // The crane rests the whole way (no track: the stowed arm).
    const mid = poseAt(rig, UNFOLD_SCRUB, UNFOLD_TICKS / 3);
    for (const id of ['boom', 'jib', 'clamp']) {
      const i = rig.partIds.indexOf(id);
      expect(mid.angle[i], id).toBeCloseTo(rest.angle[i]!, 9);
    }
    expect(unfoldPosition({ clipId: UNFOLD_CLIP, startTick: 100 }, 100)).toBe(0);
    expect(unfoldPosition({ clipId: UNFOLD_CLIP, startTick: 100 }, 100 + UNFOLD_TICKS / 2)).toBeCloseTo(0.5, 9);
  });

  it('packing plays it backwards', () => {
    const rig = capital();
    const start = 500;
    for (const t of [0, 13, 40, 77, 120, 150, 200, UNFOLD_TICKS]) {
      const pack = poseAt(rig, { clipId: PACK_CLIP, startTick: start }, start + t);
      const unfold = poseAt(rig, { clipId: UNFOLD_CLIP, startTick: start }, start + UNFOLD_TICKS - t);
      for (let i = 0; i < rig.partCount; i++) {
        expect(pack.x[i], `${rig.partIds[i]} at ${t}`).toBeCloseTo(unfold.x[i]!, 9);
        expect(pack.y[i], `${rig.partIds[i]} at ${t}`).toBeCloseTo(unfold.y[i]!, 9);
      }
      expect(unfoldPosition({ clipId: PACK_CLIP, startTick: start }, start + t)).toBeCloseTo(1 - t / UNFOLD_TICKS, 9);
    }
    // Packed: back to the crate block.
    const end = panelBounds(rig, poseAt(rig, { clipId: PACK_CLIP, startTick: start }, start + UNFOLD_TICKS));
    expect(end.w).toBeCloseTo(crate, 6);
  });

  it('a late joiner sees it at rest', () => {
    const rig = capital();
    // The row carries the server's clip record from placement; a client
    // joining long after poses from the same record: the finished Capital.
    const rec: PlayingClip = { clipId: UNFOLD_CLIP, startTick: 1000 };
    const late = poseAt(rig, rec, 1000 + 60 * 60 * 5);
    const rest = poseAt(rig, null, 0);
    for (let i = 0; i < rig.partCount; i++) expect(late.x[i], rig.partIds[i]).toBeCloseTo(rest.x[i]!, 9);
    expect(unfoldPosition(rec, 1000 + 60 * 60 * 5)).toBe(1);
    expect(unfoldPosition(null, 0)).toBe(1);
    expect(unfoldPosition({ clipId: 'arm-reach', startTick: 0 }, 1)).toBe(1);
    // ... and the crane is free again once it has played.
    expect(unfoldBusy(rec, 1000 + UNFOLD_TICKS - 1)).toBe(true);
    expect(unfoldBusy(rec, 1000 + UNFOLD_TICKS)).toBe(false);
    expect(unfoldBusy({ clipId: 'arm-reach', startTick: 1000 }, 1001)).toBe(false);
  });
});
