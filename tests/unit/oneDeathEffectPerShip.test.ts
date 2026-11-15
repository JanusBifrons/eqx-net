/**
 * One death effect per ship (break-up switched on by default, 2026-11-14).
 *
 * A dying ship either breaks into wreck pieces (its destruction profile is
 * `capital` or `subcap`) or, for a composite kind (havok, cargo pod), sheds
 * one scrap body per component (`SWARM_KIND_SCRAP`). Never both: the server's
 * scrap paths spawn only for kinds with scrap groups, and
 * `SectorRoom.wreckKindAllowed` breaks a sub-cap only when it has none. A
 * capital is broken whatever its scrap groups, so this lock fails the day a
 * breaking kind gains components without picking one effect.
 */
import { describe, expect, it } from 'vitest';
import { SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { shipScrapGroups } from '../../src/core/geometry/shipScrapGroups.js';
import { shipTuning } from '../../src/shared-types/shipScale/tuning.js';

describe('one death effect per ship', () => {
  it('no kind both breaks into wreck pieces and sheds scrap', () => {
    const both: string[] = [];
    for (const kind of SHIP_KINDS_LIST) {
      const breaks = shipTuning(kind).destruction !== 'none';
      const scraps = shipScrapGroups(kind.id).length > 0;
      if (breaks && scraps) both.push(kind.id);
    }
    expect(both).toEqual([]);
  });

  it('every kind has exactly one death effect or a plain explosion (none)', () => {
    let breaking = 0;
    let scrapping = 0;
    for (const kind of SHIP_KINDS_LIST) {
      if (shipTuning(kind).destruction !== 'none') breaking++;
      else if (shipScrapGroups(kind.id).length > 0) scrapping++;
    }
    // Positive control: both paths exist in the catalogue.
    expect(breaking).toBeGreaterThan(0);
    expect(scrapping).toBeGreaterThan(0);
  });
});
