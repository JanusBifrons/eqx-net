import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyEase, easeCode, EASE_IDS } from './easing.js';
import { buildRig, rigClipIndex, rigPartIndex, type RigDef } from './rig.js';
import { clipFinished, createRigPose, evaluateRig, type IkSolve, type PlayingClip, type RigPose } from './evaluate.js';
import { mountAnchorOnPart, partWorldFrame, type PartFrame } from './mountBridge.js';
import { DOCK_RIG_DEF, DOOR_OPEN, stubIk, TURRET_OUT } from './testRigs.js';

const rig = buildRig(DOCK_RIG_DEF);
const P = (id: string): number => rigPartIndex(rig, id);
const play = (clipId: string, startTick = 100, target?: { x: number; y: number }): PlayingClip =>
  target ? { clipId, startTick, target } : { clipId, startTick };

function snapshot(pose: RigPose): number[] {
  return [...pose.value, ...pose.x, ...pose.y, ...pose.angle];
}

describe('easing (structure-restyle 2a)', () => {
  it('every curve hits its endpoints exactly and clamps outside [0, 1]', () => {
    for (const id of EASE_IDS) {
      const c = easeCode(id);
      expect(applyEase(c, 0)).toBe(0);
      expect(applyEase(c, 1)).toBe(1);
      expect(applyEase(c, -3)).toBe(0);
      expect(applyEase(c, 7)).toBe(1);
      expect(applyEase(c, Number.NaN)).toBe(0);
    }
  });

  it('curves are monotone on [0, 1]', () => {
    for (const id of EASE_IDS) {
      const c = easeCode(id);
      let prev = 0;
      for (let i = 0; i <= 100; i++) {
        const v = applyEase(c, i / 100);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });
});

describe('buildRig', () => {
  it('orders parents before children', () => {
    for (let i = 0; i < rig.partCount; i++) expect(rig.parent[i]!).toBeLessThan(i);
    expect(rig.parent[P('arm2')]).toBe(P('arm1'));
    expect(rig.maxChain).toBe(2);
  });

  it('rejects malformed definitions', () => {
    const part = DOCK_RIG_DEF.parts[2]!; // door
    const bad = (d: Partial<RigDef>): RigDef => ({ ...DOCK_RIG_DEF, clips: [], ...d });
    expect(() => buildRig(bad({ parts: [part, part] }))).toThrow(/duplicate part/);
    expect(() => buildRig(bad({ parts: [{ ...part, parent: 'nope' }] }))).toThrow(/unknown parent/);
    expect(() => buildRig(bad({ parts: [{ ...part, id: 'a', parent: 'b' }, { ...part, id: 'b', parent: 'a' }] }))).toThrow(/cycle/);
    expect(() => buildRig(bad({ parts: [{ ...part, rest: 9 }] }))).toThrow(/rest/);
    expect(() => buildRig(bad({ parts: [{ ...part, joint: { type: 'slide', min: 0, max: 1, axisX: 0, axisY: 0 } }] }))).toThrow(/axis/);
    expect(() => buildRig(bad({ parts: [part], clips: [{ id: 'c', tracks: [{ part: 'door', keys: [{ tick: 5, value: 0 }, { tick: 5, value: 1 }] }] }] }))).toThrow(/increasing/);
    expect(() => buildRig(bad({ parts: [part], clips: [{ id: 'c', tracks: [{ part: 'door', keys: [{ tick: 5, fromTarget: true }] }] }] }))).toThrow(/IK chain/);
  });
});

describe('evaluateRig (structure-restyle 2a)', () => {
  it('rest pose with no clip, an unknown clip, or before the start', () => {
    const pose = createRigPose(rig);
    const rest = snapshot(evaluateRig(rig, null, 500, pose));
    for (let i = 0; i < rig.partCount; i++) expect(pose.value[i]).toBe(rig.rest[i]);
    expect(snapshot(evaluateRig(rig, play('door-open', 100), 99.5, pose))).toEqual(rest);
    expect(snapshot(evaluateRig(rig, play('no-such-clip', 100), 150, pose))).toEqual(rest);
  });

  it('door-open: starts at 0, eases, holds the last key after the end', () => {
    const pose = createRigPose(rig);
    const d = P('door');
    evaluateRig(rig, play('door-open'), 100, pose);
    expect(pose.value[d]).toBe(0);
    evaluateRig(rig, play('door-open'), 115, pose);
    const mid = pose.value[d]!;
    expect(mid).toBeGreaterThan(DOOR_OPEN / 2); // ease 'out' is past half at half time
    expect(mid).toBeLessThan(DOOR_OPEN);
    evaluateRig(rig, play('door-open'), 130, pose);
    expect(pose.value[d]).toBe(DOOR_OPEN);
    evaluateRig(rig, play('door-open'), 10_000, pose);
    expect(pose.value[d]).toBe(DOOR_OPEN);
    expect(clipFinished(rig, play('door-open'), 129)).toBe(false);
    expect(clipFinished(rig, play('door-open'), 130)).toBe(true);
  });

  it('turret-deploy: a first key after tick 0 eases from rest, along the slide axis', () => {
    const pose = createRigPose(rig);
    const t = P('turret');
    evaluateRig(rig, play('turret-deploy'), 105, pose); // linear, half way
    expect(pose.value[t]).toBeCloseTo(TURRET_OUT / 2, 12);
    evaluateRig(rig, play('turret-deploy'), 200, pose);
    expect(pose.value[t]).toBe(TURRET_OUT);
    // Anchor (0, 5), base angle +90 deg, axis (1, 0): slides out along +y.
    expect(pose.x[t]).toBeCloseTo(0, 12);
    expect(pose.y[t]).toBeCloseTo(5 + TURRET_OUT, 12);
    // Other parts untouched by this clip.
    expect(pose.value[P('door')]).toBe(0);
  });

  it('clamps to joint limits', () => {
    const pose = createRigPose(rig);
    for (const tick of [100, 102, 105, 110, 1000]) {
      evaluateRig(rig, play('door-slam'), tick, pose);
      expect(pose.value[P('door')]).toBeGreaterThanOrEqual(0);
      expect(pose.value[P('door')]).toBeLessThanOrEqual(DOOR_OPEN);
    }
    expect(pose.value[P('door')]).toBe(DOOR_OPEN);
  });

  it('a child follows its parent (forward kinematics)', () => {
    const pose = createRigPose(rig);
    const lamp = P('lamp');
    evaluateRig(rig, null, 0, pose);
    expect(pose.x[lamp]).toBeCloseTo(16, 12); // door anchor 10 + lamp 6
    expect(pose.y[lamp]).toBeCloseTo(0, 12);
    evaluateRig(rig, play('door-open'), 1000, pose);
    // Door swung +90 deg about (10, 0): the lamp is now at (10, 6).
    expect(pose.x[lamp]).toBeCloseTo(10, 12);
    expect(pose.y[lamp]).toBeCloseTo(6, 12);
    expect(pose.angle[lamp]).toBeCloseTo(DOOR_OPEN, 12);
  });

  it('targeted clip: arm-reach asks the IK hook from the chain root frame; arm-retract returns to rest', () => {
    const pose = createRigPose(rig);
    const a1 = P('arm1'), a2 = P('arm2');
    let calls = 0;
    let seenOrigin: [number, number] = [NaN, NaN];
    const ik: IkSolve = (req, out) => {
      calls++;
      seenOrigin = [req.originX, req.originY];
      expect(req.chain[0]).toBe(a1);
      expect(req.chain[1]).toBe(a2);
      return stubIk(req, out);
    };
    const reach = play('arm-reach', 100, { x: -5, y: 10 });
    evaluateRig(rig, reach, 200, pose, ik);
    expect(calls).toBe(1);
    expect(seenOrigin).toEqual([0, 0]); // arm1 is host-fixed
    expect(pose.value[a1]).toBeCloseTo(Math.PI / 2, 12); // straight up at the target
    expect(pose.value[a2]).toBeCloseTo(0.25, 12);
    expect(pose.ikReached).toBe(true);
    // Half way through the reach it is between rest and the solution.
    evaluateRig(rig, reach, 120, pose, ik);
    expect(pose.value[a1]).toBeGreaterThan(0);
    expect(pose.value[a1]).toBeLessThan(Math.PI / 2);
    // Retract starts at the solution and ends at rest.
    const retract = play('arm-retract', 300, { x: -5, y: 10 });
    evaluateRig(rig, retract, 300, pose, ik);
    expect(pose.value[a1]).toBeCloseTo(Math.PI / 2, 12);
    evaluateRig(rig, retract, 340, pose, ik);
    expect(pose.value[a1]).toBe(0);
    expect(pose.value[a2]).toBe(0);
    // Out of reach is reported, and no target or no solver falls back to rest.
    evaluateRig(rig, play('arm-reach', 100, { x: 500, y: 0 }), 200, pose, ik);
    expect(pose.ikReached).toBe(false);
    evaluateRig(rig, play('arm-reach', 100), 200, pose, ik);
    expect(pose.value[a1]).toBe(0);
    evaluateRig(rig, reach, 200, pose);
    expect(pose.value[a1]).toBe(0);
  });

  it('is deterministic: same inputs give bit-identical outputs (property)', () => {
    const clipIds = rig.clips.map((c) => c.id);
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom(...clipIds), { nil: null }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.double({ min: -2000, max: 2000, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        (clipId, startTick, nowTick, tx, ty) => {
          const playing = clipId === null ? null : { clipId, startTick, target: { x: tx, y: ty } };
          const a = createRigPose(rig);
          const b = createRigPose(rig);
          evaluateRig(rig, playing, nowTick, a, stubIk);
          // Dirty b with another evaluation first: the result must not depend on history.
          evaluateRig(rig, play('door-open', 0), 15, b, stubIk);
          evaluateRig(rig, playing, nowTick, b, stubIk);
          // A freshly built rig from the same definition agrees too.
          const c = createRigPose(buildRig(DOCK_RIG_DEF));
          evaluateRig(rig, playing, nowTick, c, stubIk);
          const sa = snapshot(a);
          for (const s of [snapshot(b), snapshot(c)]) {
            for (let i = 0; i < sa.length; i++) expect(Object.is(s[i], sa[i])).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('allocates nothing in the eval path (counted constructions, stable scratch)', () => {
    const pose = createRigPose(rig);
    const refs = [pose.value, pose.x, pose.y, pose.angle, pose.cos, pose.sin, pose.ikOut, pose.ikReq];
    const target = { x: -5, y: 10 };
    const clips = rig.clips.map((c) => ({ clipId: c.id, startTick: 0, target }));
    // Count constructions of every collection a careless eval path would make.
    const g = globalThis as unknown as Record<string, unknown>;
    const names = ['Float64Array', 'Float32Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Array', 'Map', 'Set', 'Object'];
    const saved = names.map((n) => g[n]);
    let constructed = 0;
    names.forEach((n, i) => {
      g[n] = new Proxy(saved[i] as object, {
        construct(t, args, nt) { constructed++; return Reflect.construct(t as new (...a: unknown[]) => object, args, nt); },
      });
    });
    try {
      for (let tick = -5; tick < 60; tick += 0.5) {
        for (const c of clips) evaluateRig(rig, c, tick, pose, stubIk);
        evaluateRig(rig, null, tick, pose);
      }
    } finally {
      names.forEach((n, i) => { g[n] = saved[i]; });
    }
    expect(constructed).toBe(0);
    expect([pose.value, pose.x, pose.y, pose.angle, pose.cos, pose.sin, pose.ikOut, pose.ikReq]).toEqual(refs);
    refs.forEach((r, i) => expect([pose.value, pose.x, pose.y, pose.angle, pose.cos, pose.sin, pose.ikOut, pose.ikReq][i]).toBe(r));
  });

  it('rigClipIndex finds clips by id', () => {
    expect(rigClipIndex(rig, 'turret-deploy')).toBeGreaterThanOrEqual(0);
    expect(rigClipIndex(rig, 'nope')).toBe(-1);
  });
});

describe('mount bridge (structure-restyle 2a)', () => {
  const mount = { localX: 1, localY: 0 }; // a turret mount on the slide part

  it("a mount's world anchor follows the slide part; the mount angle is not touched", () => {
    const pose = createRigPose(rig);
    const t = P('turret');
    const out: PartFrame = { x: 0, y: 0, angle: 0 };
    const hostX = 100, hostY = 50, hostAngle = Math.PI / 2;
    const mountRecord = { ...mount, angle: 0.3 };

    evaluateRig(rig, null, 0, pose);
    mountAnchorOnPart(pose, t, hostX, hostY, hostAngle, mountRecord, out);
    const restX = out.x, restY = out.y;
    // Turret part at host-local (0, 5) facing +90 deg; mount 1 u along it ->
    // host-local (0, 6); host faces +90 deg -> world (100 - 6, 50).
    expect(restX).toBeCloseTo(94, 12);
    expect(restY).toBeCloseTo(50, 12);
    expect(out.angle).toBeCloseTo(Math.PI, 12);

    evaluateRig(rig, play('turret-deploy', 0), 100, pose);
    mountAnchorOnPart(pose, t, hostX, hostY, hostAngle, mountRecord, out);
    expect(out.x).toBeCloseTo(restX - TURRET_OUT, 12); // slid out with the part
    expect(out.y).toBeCloseTo(restY, 12);
    expect(mountRecord.angle).toBe(0.3); // owned by tickSlot only
  });

  it('partWorldFrame composes the host pose with the part pose', () => {
    const pose = createRigPose(rig);
    evaluateRig(rig, play('door-open', 0), 100, pose);
    const out: PartFrame = { x: 0, y: 0, angle: 0 };
    partWorldFrame(pose, P('lamp'), 0, 0, 0, out);
    expect(out.x).toBeCloseTo(10, 12);
    expect(out.y).toBeCloseTo(6, 12);
    expect(out.angle).toBeCloseTo(DOOR_OPEN, 12);
  });
});
