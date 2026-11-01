import { describe, expect, it } from 'vitest';
import { MATERIAL_MAX } from './blueprints.js';
import type { BlueprintItem } from './items.js';
import {
  COMBINE_FEE, COMBINE_PULSES, COPY_MAX_RUNS,
  completeLabJob, copyFee, copyPulses, planLabJob, researchFee, researchLevel, researchPulses,
  type LabJobSpec,
} from './research.js';

function bp(uid: string, over: Partial<BlueprintItem> = {}): BlueprintItem {
  return { uid, product: 'hull:gunship', kind: 'bpo', runs: null, material: 2, output: 30, research: 0, ...over };
}

function finder(...items: BlueprintItem[]): (uid: string) => BlueprintItem | undefined {
  return (uid) => items.find((b) => b.uid === uid);
}

describe('Research Lab rules (economy v2 W3)', () => {
  it('research raises one stat by a step on an ORIGINAL; time and fee grow per level', () => {
    const a = bp('a', { material: 3 });
    const plan = planLabJob({ kind: 'research', stat: 'material', uid: 'a' }, finder(a));
    expect(plan).toEqual({ ok: true, inputs: [a], pulses: researchPulses(3), fee: researchFee(3) });
    expect(researchPulses(4)).toBeGreaterThan(researchPulses(3));
    const [out] = completeLabJob({ kind: 'research', stat: 'material', uid: 'a' }, [a], 1);
    expect(out).toMatchObject({ uid: 'a', material: 4, output: 30, research: 1 });
    expect(a.material).toBe(3); // inputs never mutated
    const [o2] = completeLabJob({ kind: 'research', stat: 'output', uid: 'a' }, [a], 1);
    expect(o2!.output).toBe(40);
    expect(researchLevel({ material: 0, output: 40 }, 'output')).toBe(4);
  });

  it('research refuses copies, missing items, bound items and maxed stats', () => {
    const msg = (spec: LabJobSpec, ...items: BlueprintItem[]): string | null => {
      const p = planLabJob(spec, finder(...items));
      return p.ok ? null : p.message;
    };
    expect(msg({ kind: 'research', stat: 'material', uid: 'x' })).toMatch(/not in this base/);
    expect(msg({ kind: 'research', stat: 'material', uid: 'c' }, bp('c', { kind: 'bpc', runs: 3 }))).toMatch(/originals/);
    expect(msg({ kind: 'research', stat: 'material', uid: 'n' }, bp('n', { bound: true }))).toMatch(/cannot be moved/);
    expect(msg({ kind: 'research', stat: 'material', uid: 'm' }, bp('m', { material: MATERIAL_MAX }))).toMatch(/fully researched/);
    expect(msg({ kind: 'research', stat: 'output', uid: 'm' }, bp('m', { output: 100 }))).toMatch(/fully researched/);
  });

  it('copy turns an original into itself plus a copy with N runs and the same stats', () => {
    const a = bp('a', { material: 5, output: 60 });
    const plan = planLabJob({ kind: 'copy', uid: 'a', runs: 4 }, finder(a));
    expect(plan).toMatchObject({ ok: true, pulses: copyPulses(4), fee: copyFee(4) });
    const out = completeLabJob({ kind: 'copy', uid: 'a', runs: 4 }, [a], 77);
    expect(out[0]).toEqual(a);
    expect(out[1]).toMatchObject({ product: 'hull:gunship', kind: 'bpc', runs: 4, material: 5, output: 60 });
    expect(out[1]!.uid).not.toBe('a');
    expect(planLabJob({ kind: 'copy', uid: 'a', runs: COPY_MAX_RUNS + 1 }, finder(a)).ok).toBe(false);
    expect(planLabJob({ kind: 'copy', uid: 'a', runs: 0 }, finder(a)).ok).toBe(false);
  });

  it('combine: 3 of the same product and kind ⇒ 1, never worse than the best input, deterministic', () => {
    const items = [
      bp('a', { kind: 'bpc', runs: 4, material: 1, output: 20 }),
      bp('b', { kind: 'bpc', runs: 5, material: 6, output: 10 }),
      bp('c', { kind: 'bpc', runs: 6, material: 2, output: 70 }),
    ];
    const spec: LabJobSpec = { kind: 'combine', uids: ['a', 'b', 'c'] };
    expect(planLabJob(spec, finder(...items))).toMatchObject({ ok: true, pulses: COMBINE_PULSES, fee: COMBINE_FEE });
    const [out] = completeLabJob(spec, items, 0);
    expect(out!.kind).toBe('bpc');
    expect(out!.material).toBeGreaterThanOrEqual(6);
    expect(out!.output).toBeGreaterThanOrEqual(70);
    expect(out!.runs).toBe(Math.floor(15 * 0.6));
    // Same inputs, any order ⇒ the same result (no reroll by retrying).
    const [again] = completeLabJob({ kind: 'combine', uids: ['c', 'a', 'b'] }, [items[2]!, items[0]!, items[1]!], 999);
    expect(again).toEqual(out);
  });

  it('combine refuses a mix of products or kinds, duplicates, or the wrong count', () => {
    const a = bp('a');
    const b = bp('b');
    expect(planLabJob({ kind: 'combine', uids: ['a', 'b'] }, finder(a, b)).ok).toBe(false);
    expect(planLabJob({ kind: 'combine', uids: ['a', 'a', 'b'] }, finder(a, b)).ok).toBe(false);
    const other = bp('o', { product: 'hull:interceptor' });
    expect(planLabJob({ kind: 'combine', uids: ['a', 'b', 'o'] }, finder(a, b, other)).ok).toBe(false);
    const copy = bp('k', { kind: 'bpc', runs: 2 });
    expect(planLabJob({ kind: 'combine', uids: ['a', 'b', 'k'] }, finder(a, b, copy)).ok).toBe(false);
  });

  it('combined originals stay originals and every stat stays capped', () => {
    const items = ['a', 'b', 'c'].map((u) => bp(u, { material: MATERIAL_MAX, output: 100 }));
    for (let s = 0; s < 20; s++) {
      const uids = items.map((b) => `${b.uid}${s}`);
      const [out] = completeLabJob({ kind: 'combine', uids }, items.map((b, i) => ({ ...b, uid: uids[i]! })), s);
      expect(out!.kind).toBe('bpo');
      expect(out!.runs).toBeNull();
      expect(out!.material).toBe(MATERIAL_MAX);
      expect(out!.output).toBe(100);
    }
  });
});
