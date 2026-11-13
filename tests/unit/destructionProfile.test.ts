/**
 * Sub-capital break-up, slice 1: `destructionProfile` maps every ship kind
 * to `capital` | `subcap` | `none` (read through `shipTuning`, #18), takes an
 * entity so structures can join later, and the profiles are plain data
 * whose capital fracture options are the fracture defaults (so capital
 * wrecks stay byte-identical).
 */
import { describe, expect, it } from 'vitest';
import { SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { STRUCTURE_KINDS_LIST } from '../../src/shared-types/structureKinds.js';
import { shipTuning } from '../../src/shared-types/shipScale/tuning.js';
import {
  DESTRUCTION_PROFILES,
  DESTRUCTION_PROFILE_IDS,
} from '../../src/shared-types/shipScale/destruction.js';
import { destructionProfile, destructionProfileOf } from '../../src/shared-types/shipScale/destructionProfile.js';
import { isCapitalKindId } from '../../src/core/combat/capitalHits.js';
import { FRACTURE_MAX_PIECES, FRACTURE_SNAP_CHANCE } from '../../src/core/destruction/fractureHull.js';

describe('destructionProfile: every ship kind', () => {
  for (const kind of SHIP_KINDS_LIST) {
    const want = isCapitalKindId(kind.id)
      ? 'capital'
      : kind.engineeringOnly || kind.id === 'cargo-pod'
        ? 'none'
        : 'subcap';
    it(`${kind.id} → ${want}`, () => {
      expect(destructionProfile({ type: 'ship', kindId: kind.id })).toBe(want);
      expect(shipTuning(kind).destruction).toBe(want);
      expect(destructionProfileOf({ type: 'ship', kindId: kind.id })).toBe(DESTRUCTION_PROFILES[want]);
    });
  }

  it('fighters are sub-capitals (owner: "Everything")', () => {
    for (const id of ['fighter', 'scout', 'interceptor', 'patrol-fighter']) {
      expect(destructionProfile({ type: 'ship', kindId: id })).toBe('subcap');
    }
  });

  it('an unknown ship kind id leaves nothing (never the default kind)', () => {
    expect(destructionProfile({ type: 'ship', kindId: 'no-such-ship' })).toBe('none');
  });

  it('structures map to `none` until that work picks their profiles', () => {
    for (const s of STRUCTURE_KINDS_LIST) {
      expect(destructionProfile({ type: 'structure', kindId: s.id })).toBe('none');
    }
  });
});

describe('DESTRUCTION_PROFILES', () => {
  it('is plain data (survives a JSON round trip)', () => {
    expect(JSON.parse(JSON.stringify(DESTRUCTION_PROFILES))).toEqual(DESTRUCTION_PROFILES);
    for (const id of DESTRUCTION_PROFILE_IDS) expect(DESTRUCTION_PROFILES[id].id).toBe(id);
  });

  it('the capital fracture options are exactly the fracture defaults', () => {
    const f = DESTRUCTION_PROFILES.capital.fracture!;
    expect(f).toEqual({ maxPieces: FRACTURE_MAX_PIECES, snapChance: FRACTURE_SNAP_CHANCE, fanCracks: true, farCrack: true, chunkyPieces: false });
  });

  it('the capital keeps its spectacle; the sub-capital is quiet', () => {
    const c = DESTRUCTION_PROFILES.capital;
    const s = DESTRUCTION_PROFILES.subcap;
    expect(c.holdMs).toBe(1200);
    expect(c.fx).toMatchObject({ breakBurst: true, killBlasts: true, crackFront: true, ripples: true, hullDeathBlastReplaced: true, glowStyle: 'full' });
    expect(s.holdMs).toBe(0);
    expect(s.fracture).toMatchObject({ maxPieces: 3, fanCracks: false, farCrack: false, chunkyPieces: true });
    expect(s.fx).toMatchObject({ breakBurst: false, killBlasts: false, crackFront: false, ripples: false, hullDeathBlastReplaced: false, glowStyle: 'simple' });
    expect(s.fx.glowSeconds).toBeLessThan(c.fx.glowSeconds);
    expect(s.pushScale).toBeLessThan(c.pushScale);
    expect(s.piecesCollide).toBe(false);
    expect(DESTRUCTION_PROFILES.none.fracture).toBeNull();
  });
});
