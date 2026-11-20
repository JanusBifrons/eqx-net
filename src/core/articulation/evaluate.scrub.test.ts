/**
 * Scrubbed clips (`PlayingClip.from` / `rate`, solid-doors slice 1): clip time
 * is `clamp(from + rate * (now - startTick), 0, endTick)`, so a clip can run
 * forwards, backwards or freeze part way. A clip with neither field is the
 * plain start-tick clip, byte-identical to before.
 */
import { describe, expect, it } from 'vitest';
import { buildRig, rigPartIndex } from './rig.js';
import { clipFinished, clipTime, createRigPose, evaluateRig, type PlayingClip, type RigPose } from './evaluate.js';
import { DOCK_RIG_DEF, DOOR_OPEN, TURRET_OUT } from './testRigs.js';

const rig = buildRig(DOCK_RIG_DEF);
const TURRET = rigPartIndex(rig, 'turret');
const DOOR = rigPartIndex(rig, 'door');
// turret-retract: TURRET_OUT at tick 0 -> 0 at tick 20, linear.
const retract = (from?: number, rate?: number, startTick = 100): PlayingClip => {
  const p: { clipId: string; startTick: number; from?: number; rate?: number } = { clipId: 'turret-retract', startTick };
  if (from !== undefined) p.from = from;
  if (rate !== undefined) p.rate = rate;
  return p;
};
const at = (clip: PlayingClip, now: number, pose = createRigPose(rig)): number =>
  evaluateRig(rig, clip, now, pose).value[TURRET]!;
const snapshot = (pose: RigPose): number[] => [...pose.value, ...pose.x, ...pose.y, ...pose.angle];

describe('scrubbed clips (PlayingClip from/rate)', () => {
  it('scrubs forward from a mid-clip time at a fractional rate', () => {
    const c = retract(5, 0.5);
    expect(at(c, 100)).toBeCloseTo(TURRET_OUT * 0.75, 12); // t = 5
    expect(at(c, 110)).toBeCloseTo(TURRET_OUT * 0.5, 12); // t = 10
    expect(clipFinished(rig, c, 129)).toBe(false); // t = 19.5
    expect(clipFinished(rig, c, 130)).toBe(true); // t = 20
  });

  it('plays backwards with a negative rate', () => {
    const c = retract(20, -1);
    expect(at(c, 100)).toBe(0);
    expect(at(c, 105)).toBeCloseTo(TURRET_OUT * 0.25, 12); // t = 15
    expect(at(c, 115)).toBeCloseTo(TURRET_OUT * 0.75, 12); // t = 5
    expect(clipFinished(rig, c, 119)).toBe(false);
    expect(clipFinished(rig, c, 120)).toBe(true); // reached tick 0, the end it moves toward
  });

  it('rate 0 freezes mid-clip and counts as finished (idle)', () => {
    const c = retract(8, 0);
    const v = at(c, 100);
    expect(v).toBeCloseTo(TURRET_OUT * 0.6, 12);
    expect(at(c, 100_000)).toBe(v);
    expect(clipFinished(rig, c, 100)).toBe(true);
  });

  it('clamps at both ends and holds `from` before its start', () => {
    const fwd = retract(0, 3);
    expect(clipTime(fwd, 1_000, 20)).toBe(20);
    expect(at(fwd, 1_000)).toBe(0);
    const back = retract(10, -2);
    expect(clipTime(back, 1_000, 20)).toBe(0);
    expect(at(back, 1_000)).toBe(TURRET_OUT);
    expect(clipTime(retract(50, 0), 100, 20)).toBe(20); // out-of-range from clamps too
    expect(clipTime(retract(-5, 0), 100, 20)).toBe(0);
    expect(at(retract(10, 1), 90)).toBeCloseTo(TURRET_OUT * 0.5, 12); // before start: holds from
    // A backwards clip clamped at the far (wrong) end is still moving, not finished.
    expect(clipFinished(rig, retract(20, -1), 100)).toBe(false);
  });

  it('old clips (no from/rate) are unchanged, and match from 0 / rate 1 inside the clip', () => {
    const plain = retract();
    // Unclamped clip time, rest before the start, holding after the end.
    expect(clipTime(plain, 90, 20)).toBe(-10);
    expect(clipTime(plain, 500, 20)).toBe(400);
    const pose = createRigPose(rig);
    const rest = snapshot(evaluateRig(rig, null, 0, createRigPose(rig)));
    expect(snapshot(evaluateRig(rig, plain, 99.5, pose))).toEqual(rest);
    expect(clipFinished(rig, plain, 119)).toBe(false);
    expect(clipFinished(rig, plain, 120)).toBe(true);
    const a = createRigPose(rig), b = createRigPose(rig);
    for (let now = 100; now <= 140; now += 0.25) {
      expect(snapshot(evaluateRig(rig, plain, now, a))).toEqual(snapshot(evaluateRig(rig, retract(0, 1), now, b)));
      expect(clipFinished(rig, plain, now)).toBe(clipFinished(rig, retract(0, 1), now));
    }
  });

  it('is deterministic: the same record and tick give the same pose', () => {
    const door = (now: number): number[] =>
      snapshot(evaluateRig(rig, { clipId: 'door-open', startTick: 7, from: 12, rate: -0.4 }, now, createRigPose(rig)));
    for (const now of [7, 13.3, 20, 40, 99]) expect(door(now)).toEqual(door(now));
    const p = createRigPose(rig);
    evaluateRig(rig, { clipId: 'door-open', startTick: 7, from: 30, rate: 0 }, 1e6, p);
    expect(p.value[DOOR]).toBe(DOOR_OPEN);
  });
});
