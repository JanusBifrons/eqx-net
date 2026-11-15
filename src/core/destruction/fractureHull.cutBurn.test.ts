/**
 * Fracture v11: a cut kill burns away every piece too small to drift on
 * (owner 2026-11-15: "any piece too small" burns away when a heavy beam or a
 * railgun kills a ship; with no piece left the whole ship is vaporised).
 *
 * The per-profile minimum is `FractureInput.cutBurnMinShare` (a share of the
 * hull's area, scale-free, #18), from `DestructionFractureOptions`. Absent, a
 * fracture is exactly v10 (the channel's 5 % sliver erase). A fracture
 * without a cut ignores it. capital-destruction.md "Kill cuts", "Burn-away".
 */
import { describe, expect, it } from 'vitest';
import { fractureHull, type FractureInput } from './fractureHull.js';
import { wreckPieceGeometry } from './wreckPieces.js';
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';

/** A 100 × 40 box, keel along x: a cut across it at x0 leaves a left bank of
 *  (x0 - width/2 + 50) / 100 of the hull. */
const BOX: ReadonlyArray<readonly [number, number]> = [[-50, -20], [50, -20], [50, 20], [-50, 20]];
const BOX_AREA = 4000;
const SHARE = 0.2;

/** A clean snap (snapChance 1): no cracks but the cut, so the pieces are the
 *  cut's banks exactly. */
function boxCut(kind: 'slice' | 'channel', x0: number, width: number, share?: number): FractureInput {
  return {
    hull: BOX, seed: 11, killPoint: { x: x0, y: 20 }, maxPieces: 8, snapChance: 1,
    cut: { kind, dirX: 0, dirY: 1, width },
    ...(share !== undefined ? { cutBurnMinShare: share } : {}),
  };
}

function shares(input: FractureInput): number[] {
  return fractureHull(input).map((p) => Math.round((p.area / BOX_AREA) * 1000) / 1000).sort((a, b) => a - b);
}

describe('fracture v11: a cut kill burns away pieces under cutBurnMinShare', () => {
  for (const [kind, width] of [['channel', 4], ['slice', 4], ['slice', 0]] as const) {
    const tag = `${kind}${kind === 'slice' ? (width > 0 ? ' (wide)' : ' (line)') : ''}`;
    // The left bank's share: (x0 - width/2 + 50) / 100.
    const above = -29 + width / 2; // 0.21
    const below = -31 + width / 2; // 0.19
    it(`${tag}: a piece just above the share survives`, () => {
      const s = shares(boxCut(kind, above, width, SHARE));
      expect(s).toHaveLength(2);
      expect(s[0]).toBeCloseTo(0.21, 3);
    });
    it(`${tag}: a piece just below the share burns away`, () => {
      const s = shares(boxCut(kind, below, width, SHARE));
      expect(s).toHaveLength(1);
      expect(s[0]).toBeGreaterThan(0.7);
    });
    it(`${tag}: without the option it drifts on as in v10`, () => {
      expect(shares(boxCut(kind, below, width))).toHaveLength(2);
    });
  }

  it('every piece too small: no piece at all (vaporised), slice and channel', () => {
    // A 70-wide strip through the middle leaves two 15 % banks.
    for (const kind of ['channel', 'slice'] as const) {
      expect(fractureHull(boxCut(kind, 0, 70, SHARE)), kind).toEqual([]);
      expect(fractureHull(boxCut(kind, 0, 70)), `${kind} without the option`).toHaveLength(2);
    }
  });

  it('a fracture without a cut ignores the option (byte-identical)', () => {
    const base: FractureInput = { hull: BOX, seed: 5, killPoint: { x: -40, y: 20 }, maxPieces: 8, killBlowDamage: 1, recentDamageRate: 1 };
    expect(fractureHull({ ...base, cutBurnMinShare: 0.45 })).toEqual(fractureHull(base));
  });

  it('the capital profile keeps the v10 sliver erase; the sub-capital burns under its share', () => {
    expect(DESTRUCTION_PROFILES.capital.fracture!.cutBurnMinShare).toBeUndefined();
    expect(DESTRUCTION_PROFILES.subcap.fracture!.cutBurnMinShare).toBe(SHARE);
  });
});

/** The real ships, through the real profile (`wreckPieceGeometry`, the one
 *  source both sides build from). Hull 1× frame, Pixi-up: the bow is -y. */
describe('fracture v11 on real ships: the heavy beam vaporises sub-capitals, a capital keeps its hulks', () => {
  const HEAVY_BEAM_W = 60; // world units, HEAVY_BEAM_WIDTH
  const RAIL_W = 16; // world units, RAILGUN_BOLT_WIDTH
  // u16 angles (65536 a turn): across the hull from starboard (+x → -x) and
  // along the keel bow to stern (-y → +y, Pixi-up).
  const ACROSS = 32768;
  const ALONG = 16384;
  const geom = (kindId: 'fighter' | 'gunship' | 'missile-frigate' | 'heavy-cruiser', s: number, cutKind: 'slice' | 'channel', w: number, killX: number, killY: number, cutAng: number) =>
    wreckPieceGeometry({ kindId, seed: 3, killX, killY, killBlowDamage: 0.3, recentDamageRate: 0.3, snapChance: 0.2, cutKind, cutAng, cutW: w / s });

  it('heavy beam: fighter and gunship (any line), missile frigate across or along: nothing survives', () => {
    expect(geom('fighter', 2, 'slice', HEAVY_BEAM_W, 10, -3, ACROSS)).toEqual([]);
    expect(geom('gunship', 2, 'slice', HEAVY_BEAM_W, 10, -2, ACROSS)).toEqual([]);
    // Missile frigate across amidships: banks of ~7 % and ~15 % (both burn).
    expect(geom('missile-frigate', 2, 'slice', HEAVY_BEAM_W, 16, 0, ACROSS)).toEqual([]);
    expect(geom('missile-frigate', 2, 'slice', HEAVY_BEAM_W, 0, -22, ALONG)).toEqual([]);
  });

  it('railgun: a 20 %+ bank drifts on, a smaller one burns (gunship off-centre along the keel)', () => {
    // A 4 u (1×) channel down the gunship 4 u off its keel: ~12 % and ~44 %.
    const g = geom('gunship', 2, 'channel', RAIL_W, 4, -16, ALONG);
    expect(g).toHaveLength(1);
  });

  it('heavy cruiser: the heavy beam slice amidships still leaves its big hulks', () => {
    const g = geom('heavy-cruiser', 1, 'slice', HEAVY_BEAM_W, 227, 0, ACROSS);
    expect(g.length).toBeGreaterThanOrEqual(2);
  });

  it('every sub-capital cut kill leaves only pieces of at least the share (sweep)', () => {
    const SUB = DESTRUCTION_PROFILES.subcap.fracture!;
    const share = SUB.cutBurnMinShare!;
    for (const kind of SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'subcap')) {
      const hull = shipHullOutline(kind);
      let a2 = 0;
      for (let i = 0; i < hull.length; i++) {
        const p = hull[i]!;
        const q = hull[(i + 1) % hull.length]!;
        a2 += p[0] * q[1] - q[0] * p[1];
      }
      const area = Math.abs(a2) / 2;
      let r = 0;
      for (const [x, y] of hull) r = Math.max(r, Math.hypot(x, y));
      for (let seed = 0; seed < 24; seed++) {
        const ang = (seed * 2.399963) % (2 * Math.PI);
        for (const [cutKind, w] of [['slice', 0], ['slice', 0.25 * r], ['channel', 0.12 * r]] as const) {
          const pieces = fractureHull({
            hull, seed: seed * 7919 + 13, killPoint: { x: Math.cos(ang) * r * 2, y: Math.sin(ang) * r * 2 },
            maxPieces: SUB.maxPieces, hullRadius: r, killBlowDamage: 1, recentDamageRate: 1, snapChance: SUB.snapChance,
            fanCracks: SUB.fanCracks, farCrack: SUB.farCrack, chunkyPieces: SUB.chunkyPieces,
            chunkyMinWidthBeams: SUB.chunkyMinWidthBeams, soundMinShare: SUB.soundMinShare,
            extraChunkChance: SUB.extraChunkChance, jag: SUB.jag, cutBurnMinShare: share,
            cut: { kind: cutKind, dirX: -Math.cos(ang + 0.3), dirY: -Math.sin(ang + 0.3), width: w },
          });
          for (const p of pieces) expect(p.area / area, `${kind.id} ${cutKind} w ${w.toFixed(1)} seed ${seed}`).toBeGreaterThanOrEqual(share);
        }
      }
    }
  });
});
