/**
 * Storage fill gauge — `writeStorageFillRow` writes a storage structure's
 * `fillPct` (hold weight over `holdCapacity`, floored to `FILL_PCT_STEP`)
 * only when the step changes, and leaves non-storage rows unset.
 */
import { describe, expect, it } from 'vitest';
import type { Hold } from '../../shared-types/goods.js';
import { FILL_PCT_STEP, storageFillPct } from '../../shared-types/structureStateWire.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { holdWeight } from '../../core/cargo/hold.js';
import { writeStorageFillRow } from './structureStateRows.js';

/** A row that counts its `fillPct` writes. */
function row(): { fillPct?: number; writes: number[] } {
  let v: number | undefined;
  const r = { writes: [] as number[] } as { fillPct?: number; writes: number[] };
  Object.defineProperty(r, 'fillPct', {
    get: () => v,
    set: (n: number) => { v = n; r.writes.push(n); },
    enumerable: true,
  });
  return r;
}

function hold(minerals: number): Hold {
  return { goods: minerals > 0 ? { minerals } : {}, blueprints: [] };
}

describe('storageFillPct', () => {
  it('floors to the step, 100 only when full, 0 with no capacity', () => {
    expect(storageFillPct(0, 1000)).toBe(0);
    expect(storageFillPct(99, 1000)).toBe(0);
    expect(storageFillPct(100, 1000)).toBe(FILL_PCT_STEP);
    expect(storageFillPct(555, 1000)).toBe(50);
    expect(storageFillPct(999, 1000)).toBe(90);
    expect(storageFillPct(1000, 1000)).toBe(100);
    expect(storageFillPct(5000, 1000)).toBe(100);
    expect(storageFillPct(10, 0)).toBe(0);
  });
});

describe('writeStorageFillRow: fillPct on step change only', () => {
  for (const kind of ['cargo_bay', 'storage_vault'] as const) {
    it(`${kind}: writes as the hold crosses steps, nothing in between`, () => {
      const cap = getStructureKind(kind).holdCapacity!;
      const perMineral = holdWeight(hold(1));
      const units = (frac: number): number => Math.round((cap * frac) / perMineral);
      const st = row();
      const rec = { kind, hold: undefined as Hold | undefined };
      writeStorageFillRow(rec, st); // empty: already the default 0
      expect(st.writes).toEqual([]);
      rec.hold = hold(units(0.05));
      writeStorageFillRow(rec, st); // still under one step
      expect(st.writes).toEqual([]);
      rec.hold = hold(units(0.31));
      writeStorageFillRow(rec, st);
      writeStorageFillRow(rec, st); // unchanged: no second write
      rec.hold = hold(units(0.35));
      writeStorageFillRow(rec, st); // same step
      expect(st.writes).toEqual([30]);
      rec.hold = hold(units(1));
      writeStorageFillRow(rec, st);
      rec.hold = hold(0);
      writeStorageFillRow(rec, st);
      expect(st.writes).toEqual([30, 100, 0]);
    });
  }

  it('leaves a non-storage row unset', () => {
    const st = row();
    writeStorageFillRow({ kind: 'battery', hold: hold(50) }, st);
    expect(st.writes).toEqual([]);
    expect(st.fillPct).toBeUndefined();
  });
});
