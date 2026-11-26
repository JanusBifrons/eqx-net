/** Ancients' gate "Astrolabe" rings (teleporter redesign A1): looks only,
 *  lanes in line from the hold through the jump, free-running between. */
import { describe, expect, it } from 'vitest';
import {
  ASTROLABE_CYCLE_MS, ASTROLABE_FX_PARTS, ASTROLABE_LANES, ASTROLABE_PRE_HOLD_MS, ASTROLABE_RELEASE_MS, ASTROLABE_RINGS, ASTROLABE_SETTLE_MS,
  astrolabePoseAt, createAstrolabePose,
} from './alienGateAstrolabe.js';
import { ALIEN_GATE_INTERVAL_MS, alienGateOffsetMs, nextAlienGateJumpMs, TP_PHASE } from '../../shared-types/teleport.js';
import { ALIEN_GATE_SEAL_RADIUS } from '../../shared-types/alienGateSeal.js';
import { rigForStructureKind } from '../articulation/rigCatalogue.js';
import { createRigPose, evaluateRig } from '../articulation/evaluate.js';
import { gateColliderBoxes } from '../structures/gateGeometry.js';
import { doorLeafCount, gateHitBoxes } from '../structures/doorLeafBoxes.js';

const LANE = (2 * Math.PI) / ASTROLABE_LANES;
/** Distance of an angle from the nearest lane-aligned angle (rad). */
const offLane = (a: number): number => {
  const m = ((a % LANE) + LANE) % LANE;
  return Math.min(m, LANE - m);
};
const OFFSET = alienGateOffsetMs('A', 'B');
/** A timetabled fire time well after the epoch. */
const FIRE = nextAlienGateJumpMs(1_700_000_000_000, OFFSET);

describe('astrolabe rings', () => {
  it('lanes coincide from the pre-hold through the whole jump cycle', () => {
    const p = createAstrolabePose();
    for (let t = FIRE - ASTROLABE_PRE_HOLD_MS + 1; t <= FIRE + ASTROLABE_CYCLE_MS; t += 97) {
      astrolabePoseAt(p, t, OFFSET);
      expect(p.aligned, `t=${t - FIRE}`).toBe(true);
      expect(p.settle).toBe(1);
      for (let i = 0; i < ASTROLABE_RINGS.length; i++) expect(offLane(p.angles[i]!)).toBeLessThan(1e-9);
    }
  });

  it('runs free between jumps, each ring at its own speed', () => {
    const p = createAstrolabePose();
    const mid = FIRE + ALIEN_GATE_INTERVAL_MS / 2;
    astrolabePoseAt(p, mid, OFFSET);
    expect(p.aligned).toBe(false);
    expect(p.settle).toBe(0);
    const a0 = Array.from(p.angles);
    astrolabePoseAt(p, mid + 100, OFFSET);
    const rates = a0.map((a, i) => (p.angles[i]! - a) / 100);
    expect(new Set(rates.map((r) => r.toFixed(9))).size).toBe(ASTROLABE_RINGS.length);
    expect(rates.some((r) => r > 0) && rates.some((r) => r < 0)).toBe(true);
    // Out of line somewhere mid-interval.
    expect(Math.max(...a0.map(offLane))).toBeGreaterThan(0.05);
  });

  it('swings into line and speeds out of it with no jump in any angle', () => {
    const p = createAstrolabePose();
    const prev = new Float64Array(ASTROLABE_RINGS.length);
    astrolabePoseAt(p, FIRE, OFFSET);
    prev.set(p.angles);
    let maxStep = 0;
    for (let t = FIRE + 10; t <= FIRE + ALIEN_GATE_INTERVAL_MS + 10; t += 10) {
      astrolabePoseAt(p, t, OFFSET);
      for (let i = 0; i < prev.length; i++) {
        let d = Math.abs(p.angles[i]! - prev[i]!);
        if (d > Math.PI) d = 2 * Math.PI - d;
        maxStep = Math.max(maxStep, d);
      }
      prev.set(p.angles);
    }
    const fastest = Math.max(...ASTROLABE_RINGS.map((r) => Math.abs(r.spin))) * 0.6; // rad per 10 ms at full speed
    expect(maxStep).toBeLessThanOrEqual(2.5 * fastest); // the swing peaks near 2x, never a jump
    // The glow ramps through the swing: half-way through, half on.
    astrolabePoseAt(p, FIRE + ALIEN_GATE_INTERVAL_MS - ASTROLABE_PRE_HOLD_MS - ASTROLABE_SETTLE_MS / 2, OFFSET);
    expect(p.settle).toBeCloseTo(0.5, 6);
    astrolabePoseAt(p, FIRE + ASTROLABE_CYCLE_MS + ASTROLABE_RELEASE_MS / 4, OFFSET);
    expect(p.settle).toBeCloseTo(0.75, 6);
  });

  it('the rings visibly swing into line just before the gate fires (owner, take 19: "align prior to warp")', () => {
    const p = createAstrolabePose();
    const end = FIRE + ALIEN_GATE_INTERVAL_MS - ASTROLABE_PRE_HOLD_MS;
    const travel = new Float64Array(ASTROLABE_RINGS.length);
    const prev = new Float64Array(ASTROLABE_RINGS.length);
    astrolabePoseAt(p, end - ASTROLABE_SETTLE_MS, OFFSET);
    prev.set(p.angles);
    let peak = 0;
    for (let t = end - ASTROLABE_SETTLE_MS + 10; t <= end; t += 10) {
      astrolabePoseAt(p, t, OFFSET);
      for (let i = 0; i < prev.length; i++) {
        let d = Math.abs(p.angles[i]! - prev[i]!);
        if (d > Math.PI) d = 2 * Math.PI - d;
        travel[i] = travel[i]! + d;
        if (i === 0) peak = Math.max(peak, d / (Math.abs(ASTROLABE_RINGS[0]!.spin) * 0.6));
      }
      prev.set(p.angles);
    }
    // In ~3 s every ring turns a visible arc (outer >= 25 deg, inner >= 80 deg)...
    expect(travel[0]! * 180 / Math.PI).toBeGreaterThanOrEqual(25);
    expect(travel[ASTROLABE_RINGS.length - 1]! * 180 / Math.PI).toBeGreaterThanOrEqual(80);
    // ...speeding up before it brakes into line (a swing, not a slow drift)...
    expect(peak).toBeGreaterThan(1.5);
    // ...and stops with every lane in line.
    expect(p.aligned).toBe(true);
    for (let i = 0; i < ASTROLABE_RINGS.length; i++) expect(offLane(p.angles[i]!)).toBeLessThan(1e-9);
    expect(ASTROLABE_SETTLE_MS).toBeLessThanOrEqual(3500);
  });

  it('reports the time since the last timetabled fire (effects timing)', () => {
    const p = createAstrolabePose();
    astrolabePoseAt(p, FIRE + 1234, OFFSET);
    expect(p.sinceFireMs).toBeCloseTo(1234, 6);
    astrolabePoseAt(p, FIRE - 10, OFFSET);
    expect(p.sinceFireMs).toBeCloseTo(ALIEN_GATE_INTERVAL_MS - 10, 6);
  });

  it('is deterministic for the same inputs (a late joiner sees the same angles)', () => {
    const a = createAstrolabePose(), b = createAstrolabePose();
    const t = FIRE + 23_456;
    astrolabePoseAt(a, t, OFFSET);
    astrolabePoseAt(b, FIRE + 40_000, OFFSET); // a different history first
    astrolabePoseAt(b, t, OFFSET);
    expect(Array.from(b.angles)).toEqual(Array.from(a.angles));
    expect(b.clockTicks).toBe(a.clockTicks);
    // One interval later: the same pose.
    astrolabePoseAt(b, t + ALIEN_GATE_INTERVAL_MS, OFFSET);
    for (let i = 0; i < a.angles.length; i++) expect(b.angles[i]).toBeCloseTo(a.angles[i]!, 9);
  });

  it('a running cycle (tpPhase) holds the lanes in line whatever the clock says', () => {
    const p = createAstrolabePose();
    const off = FIRE + 20_000; // the timetable says free-running
    for (const ph of [TP_PHASE.ARMED, TP_PHASE.CLOSING, TP_PHASE.SEALED, TP_PHASE.OPEN]) {
      astrolabePoseAt(p, off, OFFSET, ph);
      expect(p.aligned).toBe(true);
      expect(p.clockTicks).toBe(0);
      for (let i = 0; i < p.angles.length; i++) expect(offLane(p.angles[i]!)).toBeLessThan(1e-9);
    }
    astrolabePoseAt(p, off, OFFSET, TP_PHASE.IDLE);
    expect(p.aligned).toBe(false);
  });

  it("follows the server's test speed-up (scale) timetable", () => {
    const p = createAstrolabePose();
    const scale = 0.01;
    const fire = nextAlienGateJumpMs(1_700_000_000_000, OFFSET * scale, ALIEN_GATE_INTERVAL_MS * scale);
    astrolabePoseAt(p, fire + 10, OFFSET, TP_PHASE.IDLE, scale);
    expect(p.aligned).toBe(true);
    astrolabePoseAt(p, fire + (ALIEN_GATE_INTERVAL_MS * scale) / 2, OFFSET, TP_PHASE.IDLE, scale);
    expect(p.aligned).toBe(false);
  });

  it('the angles are what the rig poses for the same spin clock', () => {
    const rig = rigForStructureKind('alien_gate')!;
    const pose = createRigPose(rig);
    const p = createAstrolabePose();
    astrolabePoseAt(p, FIRE + 31_000, OFFSET);
    evaluateRig(rig, null, 0, pose, undefined, undefined, p.clockTicks);
    for (let i = 0; i < ASTROLABE_RINGS.length; i++) {
      const pi = rig.partIds.indexOf(ASTROLABE_RINGS[i]!.part);
      expect(pose.value[pi]).toBeCloseTo(p.angles[i]!, 9);
    }
  });
});

describe('alien gate rig: looks only', () => {
  it('three cosmetic spinning rings OVER the ships (arches they fly under, owner 2026-11-26), no outline, no clips', () => {
    const rig = rigForStructureKind('alien_gate')!;
    expect(rig.id).toBe('alien-astrolabe');
    expect(rig.partCount).toBe(ASTROLABE_RINGS.length + ASTROLABE_FX_PARTS.length);
    expect(rig.clips.length).toBe(0);
    for (let i = 0; i < ASTROLABE_RINGS.length; i++) {
      const part = rig.parts[i]!;
      expect(part.kind).toBe('cosmetic');
      expect(part.outline).toBeUndefined();
      expect(part.layer).toBe('over');
      expect(rig.spins[i]).not.toBe(0);
    }
  });

  it('the light-only parts (lanes, pool waves, crystal, flash) are still, cosmetic and outline-free', () => {
    const rig = rigForStructureKind('alien_gate')!;
    for (const f of ASTROLABE_FX_PARTS) {
      const i = rig.partIds.indexOf(f.part);
      expect(i, f.part).toBeGreaterThanOrEqual(ASTROLABE_RINGS.length);
      const part = rig.parts[i]!;
      expect(part.kind).toBe('cosmetic');
      expect(part.outline).toBeUndefined();
      expect(part.layer).toBe(f.layer);
      expect(rig.spins[i]).toBe(0);
      expect(part.light).toBe(true);
    }
    // The flash is over everything at the gate; the floor light under the ships.
    expect(ASTROLABE_FX_PARTS.find((f) => f.part === 'fx-flash')?.layer).toBe('over');
    expect(ASTROLABE_FX_PARTS.find((f) => f.part === 'fx-lanes')?.layer).toBe('under');
  });

  it('the server pose (no spin clock) is at rest', () => {
    const rig = rigForStructureKind('alien_gate')!;
    const pose = createRigPose(rig);
    evaluateRig(rig, null, 12_345, pose);
    for (let i = 0; i < rig.partCount; i++) expect(pose.value[i]).toBe(0);
  });

  it('no posts, colliders or hit boxes (redesign A3), no door leaves', () => {
    expect(gateColliderBoxes('alien_gate')).toEqual([]);
    expect(doorLeafCount('alien_gate')).toBe(0);
    expect(gateHitBoxes('alien_gate', 0)?.length).toBe(0);
  });

  it('the inner ring is the one that seals, at its inner edge round the light pool (owner 2026-11-26)', () => {
    const inner = ASTROLABE_RINGS[ASTROLABE_RINGS.length - 1]!;
    expect(inner.part).toBe('ring-inner');
    for (const r of ASTROLABE_RINGS) expect(r.radius - r.width / 2).toBeGreaterThanOrEqual(inner.radius - inner.width / 2);
    expect(ALIEN_GATE_SEAL_RADIUS).toBe(inner.radius - inner.width / 2);
  });
});
