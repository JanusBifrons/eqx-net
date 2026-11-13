/**
 * Sub-cap parting (hostile review round 2, 2026-11-13): robot pieces still
 * touched ~1 s after the break and a fighter's wreckage still read as a whole
 * fighter, although `pushScale` was 50. The push is AWAY FROM THE KILL POINT,
 * so with a hit on one side every piece is shoved the same way and they only
 * drift off together; what opens the cracks is the seam pass, whose least
 * parting speed (`wreckSeparate`, 1.4 % of the radius a second) the profile
 * did not scale. This measures the real kicks `buildWreckPieces` hands the
 * server: every shared cut must open by ~1/3 of the hull radius within 1 s of
 * the profile's damping, for every sub-cap kind over seeds and kill points
 * round the hull, and no piece may be flung across the fight. Capitals are
 * unchanged (`wreckPiecesSeparate.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { buildWreckPieces, findSeams, wreckBodyParams, wreckPieceGeometry } from './wreckPieces.js';
import { shipShapeToPolygon } from '../geometry/shipHullDecomp.js';
import { shipScrapGroups } from '../geometry/shipScrapGroups.js';
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

const SUBCAP_KINDS = SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'subcap' && shipScrapGroups(k.id).length === 0);

/** Distance a speed v covers in t s under linear damping d (Rapier: ≈ exponential). */
function opened(v: number, d: number, t: number): number {
  return (v * (1 - Math.exp(-d * t))) / d;
}

describe('sub-cap wreck pieces part visibly (buildWreckPieces kicks)', () => {
  it('every shared cut opens >= ~1/3 radius in 1 s, and no piece drifts over ~1.5 radii', () => {
    expect(SUBCAP_KINDS.length).toBeGreaterThan(5);
    let worst = Infinity;
    let worstWhat = '';
    for (const kind of SUBCAP_KINDS) {
      const d = wreckBodyParams(kind.id).linearDamping;
      const outline = shipShapeToPolygon(kind);
      for (let seed = 1; seed <= 12; seed++) {
        // Kill points round the outline (world space at pose 0 = the ship's math-up frame).
        const v = outline[(seed * 3) % outline.length]!;
        const b = buildWreckPieces({
          kindId: kind.id,
          pose: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 },
          killWorld: { x: v.x, y: v.y },
          attackerWorld: null,
          seed: seed * 7919,
          killBlowDamage: 0.3,
          recentDamageRate: 0.2,
        });
        const p = b.pieces;
        expect(p.length).toBeGreaterThanOrEqual(2);
        const seams = findSeams(wreckPieceGeometry(b.fracture));
        expect(seams.length, `${kind.id} seed ${seed}: seams`).toBeGreaterThan(0);
        // Relative speed of j's and i's material along the seam normal (kicks only).
        const at = (i: number, j: number, x: number, y: number, nx: number, ny: number): number => {
          const a = p[i]!, c = p[j]!;
          const vjx = c.kickVx - c.kickAngvel * (y - c.y), vjy = c.kickVy + c.kickAngvel * (x - c.x);
          const vix = a.kickVx - a.kickAngvel * (y - a.y), viy = a.kickVy + a.kickAngvel * (x - a.x);
          return (vjx - vix) * nx + (vjy - viy) * ny;
        };
        for (const sm of seams) {
          const open = Math.min(at(sm.i, sm.j, sm.ax, sm.ay, sm.nx, sm.ny), at(sm.i, sm.j, sm.bx, sm.by, sm.nx, sm.ny));
          const gap = opened(open, d, 1) / kind.radius;
          if (gap < worst) { worst = gap; worstWhat = `${kind.id} seed ${seed}`; }
        }
        for (const q of p) {
          const k = Math.hypot(q.kickVx, q.kickVy);
          expect(k / d / kind.radius, `${kind.id} seed ${seed}: drift`).toBeLessThan(1.5);
        }
      }
    }
    console.log(`[subcap-parting] narrowest cut 1 s after the break: ${worst.toFixed(3)} radii (${worstWhat})`);
    expect(worst, `narrowest cut after 1 s (${worstWhat}), in hull radii`).toBeGreaterThanOrEqual(0.3);
  });

  it('a fighter killed mid-turn: no piece spins faster than 60 °/s at spawn (owner, v5 film 2026-11-13)', () => {
    // "I think they spin too much when destroyed". The pieces took the dying
    // hull's whole turn rate (2 rad/s = 115 °/s: a fighter hard over, or
    // spun by a ram, as `subcapWrecks.test.ts` kills it) plus the seeded
    // kick; the sub-cap profile's `spinScale` keeps a fraction of both.
    const kind = SHIP_KINDS_LIST.find((k) => k.id === 'fighter')!;
    const outline = shipShapeToPolygon(kind);
    const limit = (60 * Math.PI) / 180;
    let worst = 0;
    for (const turn of [2, -2]) {
      for (let seed = 1; seed <= 12; seed++) {
        const v = outline[(seed * 5) % outline.length]!;
        const b = buildWreckPieces({
          kindId: kind.id,
          pose: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: turn },
          killWorld: { x: v.x, y: v.y },
          attackerWorld: null,
          seed: seed * 104729,
          killBlowDamage: 0.6,
          recentDamageRate: 0.4,
        });
        // A sub-cap has no crack hold: the server spawns each piece at angvel + kickAngvel.
        for (const p of b.pieces) worst = Math.max(worst, Math.abs(p.angvel + p.kickAngvel));
      }
    }
    console.log(`[subcap-spin] fastest fighter piece at spawn: ${((worst * 180) / Math.PI).toFixed(1)} °/s`);
    expect(worst, 'fastest sub-cap piece spin at spawn (rad/s)').toBeLessThanOrEqual(limit);
  });
});
