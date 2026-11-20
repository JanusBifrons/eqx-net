/**
 * Spinning cosmetic hinges (`PartDef.spin`, restyle Family 1 reactor): a part
 * with a spin rate turns at that rate from rest for the spin clock the caller
 * passes to `evaluateRig` (the client's running ticks); with no clock it sits
 * at rest, so the server's pose is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { buildRig, type RigDef } from './rig.js';
import { createRigPose, evaluateRig } from './evaluate.js';
import { REACTOR_FANS_DEF, REACTOR_FAN_SPIN, reactorFanLayout } from './rigs/power.js';
import { rigForStructureKind } from './rigCatalogue.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';

describe('buildRig — spin validation', () => {
  const base = { id: 'p', parent: null, anchorX: 0, anchorY: 0, rest: 0, layer: 'plane' } as const;
  const full = { type: 'hinge', min: -Math.PI, max: Math.PI } as const;
  const bad = (id: string, part: object): RigDef => ({ id, clips: [], parts: [{ ...base, ...part }] }) as unknown as RigDef;
  it('rejects spin on a slide joint', () => {
    expect(() => buildRig(bad('s1', { joint: { type: 'slide', min: 0, max: 1, axisX: 1, axisY: 0 }, kind: 'cosmetic', spin: 0.1 })))
      .toThrow(/spins but is not a cosmetic hinge/);
  });
  it('rejects spin on a physical part', () => {
    expect(() => buildRig(bad('s2', { joint: full, kind: 'physical', spin: 0.1 }))).toThrow(/spins but is not a cosmetic hinge/);
  });
  it('rejects a part that both aims and spins', () => {
    expect(() => buildRig(bad('s3', { joint: full, kind: 'cosmetic', aim: true, spin: 0.1 }))).toThrow(/both aims and spins/);
  });
  it('rejects spin on a hinge short of a full turn', () => {
    expect(() => buildRig(bad('s4', { joint: { type: 'hinge', min: -1, max: 1 }, kind: 'cosmetic', spin: 0.1 })))
      .toThrow(/not a full turn/);
  });
  it('a spin of 0 is no spin', () => {
    expect(buildRig(bad('s5', { joint: full, kind: 'cosmetic', spin: 0 })).spins[0]).toBe(0);
  });
});

describe('reactor-fans rig', () => {
  const rig = buildRig(REACTOR_FANS_DEF);

  it("is the reactor kind's rig: four spinning fans, no outline (no collider)", () => {
    expect(rigForStructureKind('reactor')?.id).toBe('reactor-fans');
    expect(rig.partCount).toBe(4);
    for (let i = 0; i < rig.partCount; i++) {
      expect(Math.abs(rig.spins[i]!)).toBeCloseTo(REACTOR_FAN_SPIN);
      expect(rig.parts[i]!.outline).toBeUndefined();
      expect(rig.parts[i]!.kind).toBe('cosmetic');
    }
  });

  it('fans sit on the corners of the footprint, inside it', () => {
    const fp = getStructureKind('reactor').footprint;
    const L = reactorFanLayout(fp.w, fp.h);
    for (let i = 0; i < rig.partCount; i++) {
      expect(Math.abs(rig.anchorX[i]!)).toBeCloseTo(L.at);
      expect(Math.abs(rig.anchorY[i]!)).toBeCloseTo(L.at);
    }
    expect(L.at + L.shroud).toBeLessThan(Math.min(fp.w, fp.h) / 2);
  });

  it('the layout scales with the short side (drawn for 600)', () => {
    const a = reactorFanLayout(600, 600), b = reactorFanLayout(400, 400);
    expect(b.at / a.at).toBeCloseTo(400 / 600);
    expect(b.blade / a.blade).toBeCloseTo(400 / 600);
    expect(reactorFanLayout(600, 800)).toEqual(a);
  });

  it('fans sit at rest with no spin clock (the server pose)', () => {
    const out = createRigPose(rig);
    evaluateRig(rig, null, 1234, out);
    for (let i = 0; i < rig.partCount; i++) expect(out.angle[i]).toBeCloseTo(0);
  });

  it('fans turn by rate × clock, whatever the tick, and diagonal pairs counter-rotate', () => {
    const out = createRigPose(rig);
    for (const clock of [0, 1, 7.5, 60, 1e5]) {
      evaluateRig(rig, null, 999, out, undefined, undefined, clock);
      for (let i = 0; i < rig.partCount; i++) {
        const want = rig.spins[i]! * clock;
        expect(Math.cos(out.angle[i]! - want)).toBeCloseTo(1, 6);
        expect(Math.sin(out.angle[i]! - want)).toBeCloseTo(0, 6);
      }
    }
    expect(Math.sign(rig.spins[0]!)).toBe(-Math.sign(rig.spins[1]!));
  });

  it('a held clock holds the fans (stopped, they stay where they are)', () => {
    const a = createRigPose(rig), b = createRigPose(rig);
    evaluateRig(rig, null, 10, a, undefined, undefined, 42);
    evaluateRig(rig, null, 500, b, undefined, undefined, 42);
    for (let i = 0; i < rig.partCount; i++) expect(b.angle[i]).toBeCloseTo(a.angle[i]!);
  });

  it('fans keep their anchors when they turn', () => {
    const rest = createRigPose(rig), spun = createRigPose(rig);
    evaluateRig(rig, null, 0, rest);
    evaluateRig(rig, null, 0, spun, undefined, undefined, 33);
    for (let i = 0; i < rig.partCount; i++) {
      expect(spun.x[i]).toBeCloseTo(rest.x[i]!);
      expect(spun.y[i]).toBeCloseTo(rest.y[i]!);
    }
  });
});
