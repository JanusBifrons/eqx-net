/**
 * Structure break-up T6: a structure's wreck pieces act exactly like a
 * ship's (owner): they wear like a ship wreck's (not a rock's) and a
 * worn-out or hauled piece is worth ship-style salvage (`pieceSalvageQtyOf`
 * only special-cases rock), a sensible non-zero amount.
 */
import { describe, expect, it } from 'vitest';
import { structureBreaks, structureWreckSource } from '../../core/destruction/wreckSource.js';
import { wreckSalvageQty, wreckWearFactor } from '../../core/destruction/wreckIntegrity.js';
import { STRUCTURE_KINDS_LIST, type StructureKindId } from '../../shared-types/structureKinds.js';
import { pieceSalvageQtyOf } from './wreckLineage.js';
import type { LiveWreck, PieceKnock } from './capitalWreckTypes.js';

describe('structure wreck salvage and wear (structure break-up T6)', () => {
  const kinds: StructureKindId[] = ['capital', 'solar', 'connector', 'turret'];

  it.each(kinds)('a %s piece is worth non-zero ship-style salvage', (k) => {
    const src = structureWreckSource({ k });
    expect(src.rock).toBeNull();
    // A whole hull's worth, a quarter piece (turns to salvage), a sliver.
    const whole = wreckSalvageQty(src, src.bodyMass);
    const quarter = wreckSalvageQty(src, src.bodyMass / 4);
    const sliver = wreckSalvageQty(src, src.bodyMass / 1000);
    expect(whole).toBeGreaterThan(1);
    expect(quarter).toBeGreaterThanOrEqual(1);
    expect(quarter).toBeLessThanOrEqual(whole);
    expect(sliver).toBe(1);
    // The room's lookup: not a rock ⇒ the same salvage (never 0).
    const wrecks = new Map([[7, { src } as unknown as LiveWreck]]);
    const knock = new Map([['p', { mass: src.bodyMass / 4 } as PieceKnock]]);
    expect(pieceSalvageQtyOf(wrecks, new Map([['p', 7]]), knock, 'p')).toBe(quarter);
  });

  it('every breaking kind has a positive whole-hull salvage', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      if (!structureBreaks(kind.id, true)) continue;
      expect(wreckSalvageQty(structureWreckSource({ k: kind.id }), structureWreckSource({ k: kind.id }).bodyMass), kind.id).toBeGreaterThan(0);
    }
  });

  it('pieces wear like a ship wreck, not a rock', () => {
    // `CapitalWreckSubsystem` passes `src.rock !== null` (false here).
    expect(wreckWearFactor(undefined, structureWreckSource({ k: 'solar' }).rock !== null)).toBe(wreckWearFactor(undefined, false));
    expect(wreckWearFactor(undefined, false)).toBeGreaterThan(0);
  });
});
