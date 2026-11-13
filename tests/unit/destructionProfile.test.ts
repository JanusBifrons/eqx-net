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
import { WRECK_LINEAR_DAMPING } from '../../src/core/destruction/wreckPieces.js';

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
    expect(s.piecesCollide).toBe(false);
    expect(DESTRUCTION_PROFILES.none.fracture).toBeNull();
  });

  /**
   * Hostile review 2026-11-13 (30-v-30 fleet fight): "robot pieces barely
   * separated (still read as one hull with a crack)". The parting push is
   * per unit of hull radius (`wreckPushMin/Max`), so the profile's
   * `pushScale` must open a visible gap within ~1 s on every sub-cap, while
   * the damping (`WRECK_LINEAR_DAMPING × dampingScale`) still brings the
   * pieces to rest within ~10-20 s (so they can sleep). Model: two pieces
   * driven apart at least at `wreckPushMin × pushScale` each, exponential
   * linear damping d: gap(t) = 2·v0·(1 − e^(−d·t)) / d.
   * (Round 2: that model was wrong. The push runs away from the kill point,
   * so a hit at one end moves every piece the same way; the cracks are
   * opened by `separateScale`. The real kicks are measured in
   * `src/core/destruction/wreckPieces.subcapParting.test.ts`.)
   */
  it('sub-cap pieces visibly part within ~1 s and come to rest within ~10-20 s', () => {
    const s = DESTRUCTION_PROFILES.subcap;
    const d = WRECK_LINEAR_DAMPING * s.dampingScale;
    for (const kind of SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'subcap')) {
      const t = shipTuning(kind);
      const v0 = t.wreckPushMin * s.pushScale;
      const gap1s = (2 * v0 * (1 - Math.exp(-d))) / d;
      expect(gap1s / kind.radius, `${kind.id}: gap after 1 s, in hull radii`).toBeGreaterThanOrEqual(0.3);
      // Not flung across the fight: the fastest piece drifts under ~1.5 radii in all.
      expect((t.wreckPushMax * s.pushScale * 1.25) / d / kind.radius, `${kind.id}: total drift`).toBeLessThan(1.5);
    }
    // Capitals keep the capital seam speed (byte-identical kicks).
    expect(DESTRUCTION_PROFILES.capital.separateScale).toBe(1);
    expect(s.separateScale).toBeGreaterThan(1);
    // Speed under 1 % of the kick by 20 s; still visibly moving at 1 s.
    expect(Math.exp(-d * 20)).toBeLessThan(0.01);
    expect(Math.exp(-d * 1)).toBeGreaterThan(0.5);
  });

  /**
   * Slice 2 report (2026-11-13): overkill knock-back on sub-cap wreck pieces
   * was invisible (`wreckKnockMax` = 0.025 × radius/s, < 1 u/s at fighter
   * size). The owner wants shots on debris to shove it a little: a
   * small-arms hit on half a fighter-class wreck changes its speed by
   * ~10-25 u/s (then the damping slows it again), and no hit, however big,
   * flings it faster than ~25 u/s. The server's knock (`CapitalWreckSubsystem
   * .onWreckHit`): J = damage × hull mass × wreckKnockSpeed ÷ max hull,
   * Δv = min(J ÷ piece mass, wreckKnockMax). Capitals unchanged.
   */
  it('a small-arms hit visibly shoves a sub-cap wreck piece; capitals unchanged', () => {
    const SMALL_ARMS = 12;
    for (const id of ['fighter', 'scout', 'interceptor', 'heavy', 'gunship', 'robot-square', 'robot-circle', 'patrol-fighter']) {
      const kind = SHIP_KINDS_LIST.find((k) => k.id === id)!;
      const t = shipTuning(kind);
      const pieceShare = 0.5; // one of two halves
      const dv = Math.min((SMALL_ARMS * t.wreckKnockSpeed) / kind.maxHealth / pieceShare, t.wreckKnockMax);
      expect(dv, `${id}: Δv from one small-arms hit (u/s)`).toBeGreaterThanOrEqual(10);
      expect(dv, `${id}`).toBeLessThanOrEqual(25);
      expect(t.wreckKnockMax, `${id}: the per-hit ceiling (a naval shell)`).toBeLessThanOrEqual(25);
    }
    const c = DESTRUCTION_PROFILES.capital;
    expect([c.knockScale, c.knockMaxScale]).toEqual([1, 1]);
    for (const kind of SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'capital')) {
      expect(shipTuning(kind).wreckKnockMax).toBeCloseTo(0.025 * kind.radius, 9);
      expect(shipTuning(kind).wreckKnockSpeed).toBeCloseTo(0.012 * kind.radius, 9);
    }
  });

  it('death blast and dead tint: shrunk + burnt for sub-caps, untouched for capitals', () => {
    const c = DESTRUCTION_PROFILES.capital.fx;
    const s = DESTRUCTION_PROFILES.subcap.fx;
    expect([c.deathBlastScale, c.deathBlastLinger, c.deadTint]).toEqual([1, 1, null]);
    expect(s.deathBlastScale).toBeCloseTo(0.5, 5);
    expect(s.deathBlastLinger).toBeCloseTo(0.5, 5);
    expect(s.deadTint).not.toBeNull();
  });
});
