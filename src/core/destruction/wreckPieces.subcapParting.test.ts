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
import { buildWreckPieces, findSeams, hullLocalCutAngle, wreckBodyParams, wreckPieceGeometry } from './wreckPieces.js';
import { HEAVY_BEAM_WIDTH } from '../combat/WeaponCatalogue.js';
import { shipShapeScale } from '../geometry/shipHullOutline.js';
import { shipShapeToPolygon } from '../geometry/shipHullDecomp.js';
import { shipScrapGroups } from '../geometry/shipScrapGroups.js';
import { SHIP_KINDS_LIST, getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

const SUBCAP_KINDS = SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'subcap' && shipScrapGroups(k.id).length === 0);

/** Distance a speed v covers in t s under linear damping d (Rapier: ≈ exponential). */
function opened(v: number, d: number, t: number): number {
  return (v * (1 - Math.exp(-d * t))) / d;
}

describe('sub-cap wreck pieces part visibly (buildWreckPieces kicks)', () => {
  it('every shared cut opens >= ~1/3 radius in 1 s, and no piece drifts over ~8 radii', () => {
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
          expect(k / d / kind.radius, `${kind.id} seed ${seed}: drift`).toBeLessThan(8);
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

/**
 * Hostile review of take 9 (2026-11-14). A robot-square died and its hull
 * "stays whole, a grey pod pops out, only a faint red cut line", then "reads
 * as a robot sitting still" for 13 s; an orange heavy's two pieces "drift
 * side by side for ~18 s, like two live ships flying together". Cause: the
 * primary crack only had to leave 15 % on its small side, so the big piece
 * was up to ~85 % of the hull (a whole-looking ship), and the pieces parted
 * at ~0.55-0.6 radii/s: under damping 0.6/s about ONE radius in all, while
 * both carried the dead ship's few hundred u/s. Take 10 (with 70 % and
 * 2 radii/s) still read as a live robot plus a chip. Now no piece is over
 * 60 % of the hull, and every pair of pieces parts at >= 3 radii/s
 * (`shipTuning`'s `wreckSeparate` × the profile's `separateScale`):
 * >= 2.25 radii further apart 1 s after the break and ~5+ at rest, a broken
 * ship whose halves drift off from each other, not a formation.
 */
describe('sub-cap wreck pieces read as broken (take 9 review)', () => {
  function hullArea(kindId: ShipKindId): number {
    const o = shipShapeToPolygon(getShipKind(kindId));
    let a = 0;
    for (let i = 0; i < o.length; i++) { const p = o[i]!, q = o[(i + 1) % o.length]!; a += p.x * q.y - q.x * p.y; }
    return Math.abs(a) / 2;
  }
  const NAMED = ['robot-square', 'robot-circle', 'heavy', 'fighter'] as ShipKindId[];
  const KINDS = [...new Set([...NAMED, ...SUBCAP_KINDS.map((k) => k.id)])];
  const SEEDS = 60;

  for (const id of KINDS) {
    it(`${id}: 2-3 pieces, none over 60 % of the hull; every pair parts at >= 3 radii/s`, () => {
      const kind = getShipKind(id);
      const area = hullArea(id);
      const d = wreckBodyParams(id).linearDamping;
      const outline = shipShapeToPolygon(kind);
      let biggest = 0;
      let slowest = Infinity;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const v = outline[(seed * 3) % outline.length]!;
        const b = buildWreckPieces({
          kindId: id,
          // The dying ship at speed: its pieces inherit it; only the kicks part them.
          pose: { x: 0, y: 0, vx: 0.8 * kind.maxSpeed, vy: 0, angle: 0, angvel: 0 },
          killWorld: { x: v.x, y: v.y },
          attackerWorld: null,
          seed: seed * 7919,
          killBlowDamage: (seed % 4) * 0.2,
          recentDamageRate: (seed % 3) * 0.2,
        });
        const p = b.pieces;
        expect(p.length, `${id} seed ${seed}: pieces`).toBeGreaterThanOrEqual(2);
        expect(p.length, `${id} seed ${seed}: pieces`).toBeLessThanOrEqual(3);
        for (const q of p) biggest = Math.max(biggest, q.area / area);
        for (let i = 0; i < p.length; i++) {
          for (let j = i + 1; j < p.length; j++) {
            const a = p[i]!, c = p[j]!;
            const dx = c.x - a.x, dy = c.y - a.y, l = Math.hypot(dx, dy);
            const rel = ((c.vx + c.kickVx - a.vx - a.kickVx) * dx + (c.vy + c.kickVy - a.vy - a.kickVy) * dy) / l;
            slowest = Math.min(slowest, rel / kind.radius);
          }
        }
      }
      console.log(`[subcap-read] ${id}: largest piece ${(biggest * 100).toFixed(0)} % of the hull; slowest pair parts at ${slowest.toFixed(2)} radii/s = ${(slowest * kind.radius).toFixed(1)} u/s (${opened(slowest, d, 1).toFixed(2)} radii in 1 s)`);
      expect(biggest, `${id}: largest piece, fraction of the hull area`).toBeLessThanOrEqual(0.6);
      expect(slowest, `${id}: slowest pair of piece centres parting, radii/s`).toBeGreaterThanOrEqual(3);
    });
  }
});

/** Hostile film review 2026-11-15 (heavy-beam slice of a missile frigate,
 *  take 7): the halves flew apart at ~2.5 ship lengths a second, then stopped
 *  dead ~3 s later (spacing constant from then on): an explosion, then
 *  frozen. The cut kill took the un-cut break-up's kick (`separateScale` 240,
 *  ~177 u/s apart) and damping (0.6/s, at rest in ~3 s). A clean slice parts
 *  gently and the halves keep drifting: the profile's `cut*` numbers. */
describe('a sub-cap slice kill parts gently and keeps drifting (beam take 7)', () => {
  const kindId = 'missile-frigate' as const;
  const kind = getShipKind(kindId);
  const R = kind.radius;
  function slice(seed: number) {
    const pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    return buildWreckPieces({
      kindId, pose, killWorld: { x: -500, y: 0 }, attackerWorld: null, seed, killBlowDamage: 0.3, recentDamageRate: 0.5,
      cutKind: 'slice', cutAng: hullLocalCutAngle(pose, { x: 1, y: 0 }), cutW: HEAVY_BEAM_WIDTH / shipShapeScale(kind),
    });
  }

  it('the two halves part at 0.3-1 radius/s, not ~3.7', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const b = slice(seed);
      expect(b.pieces.length, `seed ${seed}`).toBe(2);
      const [p, q] = b.pieces as [typeof b.pieces[0], typeof b.pieces[0]];
      const rel = Math.hypot(p.kickVx - q.kickVx, p.kickVy - q.kickVy);
      expect(rel / R, `seed ${seed}: parting speed (radii/s)`).toBeLessThanOrEqual(1);
      expect(rel / R, `seed ${seed}: still visibly parting`).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('the halves still drift 6 s after the kill (gentle damping), and keep opening', () => {
    const body = wreckBodyParams(kindId, true);
    for (let seed = 1; seed <= 6; seed++) {
      const b = slice(seed);
      const [p, q] = b.pieces as [typeof b.pieces[0], typeof b.pieces[0]];
      for (const piece of [p, q]) {
        const v = Math.hypot(piece.kickVx, piece.kickVy);
        expect(v * Math.exp(-body.linearDamping * 6), `seed ${seed}: still above the settle speed at 6 s`).toBeGreaterThan(body.settleSpeed);
      }
      const rel = Math.hypot(p.kickVx - q.kickVx, p.kickVy - q.kickVy);
      // The gap still widens by >= 1/2 radius between 3 s and 8 s after the kill.
      const grow = opened(rel, body.linearDamping, 8) - opened(rel, body.linearDamping, 3);
      expect(grow / R, `seed ${seed}: gap growth 3-8 s (radii)`).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('an un-cut sub-cap break-up keeps its own kick and damping', () => {
    expect(wreckBodyParams(kindId)).toEqual(wreckBodyParams(kindId, false));
    expect(wreckBodyParams(kindId).linearDamping).toBeCloseTo(0.6, 9);
    expect(wreckBodyParams('battleship', true)).toEqual(wreckBodyParams('battleship'));
  });
});
