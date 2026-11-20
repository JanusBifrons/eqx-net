/**
 * Aiming cosmetic hinges (`PartDef.aim`, restyle Family 1 solar): a part
 * flagged `aim` turns to face the aim angle the caller passes to
 * `evaluateRig` (the client passes the sector sun); with no aim it sits at
 * rest, so the server's pose is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { buildRig, type RigDef } from './rig.js';
import { aimHinge, createRigPose, evaluateRig } from './evaluate.js';
import { SOLAR_TRACKER_DEF } from './rigs/power.js';
import { rigForStructureKind } from './rigCatalogue.js';

const pose = createRigPose;

describe('aimHinge', () => {
  it('wraps any angle into [-pi, pi)', () => {
    expect(aimHinge(0)).toBeCloseTo(0);
    expect(aimHinge(Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(aimHinge(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    expect(aimHinge(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(aimHinge(10 * Math.PI + 0.25)).toBeCloseTo(0.25);
    expect(aimHinge(Math.PI)).toBeCloseTo(-Math.PI);
  });
});

describe('buildRig — aim validation', () => {
  const base = { id: 'p', parent: null, anchorX: 0, anchorY: 0, rest: 0, layer: 'plane' } as const;
  it('rejects aim on a slide joint', () => {
    const def: RigDef = { id: 'bad-slide', clips: [], parts: [{ ...base, joint: { type: 'slide', min: 0, max: 1, axisX: 1, axisY: 0 }, kind: 'cosmetic', aim: true }] } as unknown as RigDef;
    expect(() => buildRig(def)).toThrow(/aims but is not a cosmetic hinge/);
  });
  it('rejects aim on a physical part', () => {
    const def: RigDef = { id: 'bad-phys', clips: [], parts: [{ ...base, joint: { type: 'hinge', min: -Math.PI, max: Math.PI }, kind: 'physical', aim: true }] } as unknown as RigDef;
    expect(() => buildRig(def)).toThrow(/aims but is not a cosmetic hinge/);
  });
});

describe('solar-tracker rig', () => {
  const rig = buildRig(SOLAR_TRACKER_DEF);

  it('is the solar kind\'s rig: eight aiming panels', () => {
    expect(rigForStructureKind('solar')?.id).toBe('solar-tracker');
    expect(rig.partCount).toBe(8);
    for (let i = 0; i < rig.partCount; i++) expect(rig.aims[i]).toBe(1);
  });

  it('panels sit at rest with no aim (the server pose)', () => {
    const out = pose(rig);
    evaluateRig(rig, null, 0, out);
    for (let i = 0; i < rig.partCount; i++) expect(out.angle[i]).toBeCloseTo(0);
  });

  it('every panel faces the aim, whatever it is', () => {
    const out = pose(rig);
    for (const a of [0, 0.7, -2.5, Math.PI - 0.01, 5]) {
      evaluateRig(rig, null, 0, out, undefined, a);
      for (let i = 0; i < rig.partCount; i++) expect(Math.cos(out.angle[i]! - a)).toBeCloseTo(1, 6);
    }
  });

  it('panels keep their anchors when they turn', () => {
    const rest = pose(rig), aimed = pose(rig);
    evaluateRig(rig, null, 0, rest);
    evaluateRig(rig, null, 0, aimed, undefined, 1.2);
    for (let i = 0; i < rig.partCount; i++) {
      expect(aimed.x[i]).toBeCloseTo(rest.x[i]!);
      expect(aimed.y[i]).toBeCloseTo(rest.y[i]!);
    }
  });
});
