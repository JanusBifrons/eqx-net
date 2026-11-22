/**
 * Structure break-up: a structure piece's cut glow is an EDGE on the piece,
 * as a ship's is at its size. In-game stills of structure deaths showed (1)
 * the simple glow as wide flat orange slabs on the base Capital (its width
 * was 0.1 × the wreck radius with no ceiling: ~33 u on a 332 u Capital,
 * where no ship's simple glow is ever over ~11 u), and (2) dark bands
 * hanging off the pieces over the starfield (the simple glow straddles the
 * cut, half of it outside the piece's face: on a ship a hairline over the
 * neighbour, on a structure a wide band over the opening gap).
 * Ships' glow geometry stays exactly as it was (golden sums below).
 */
import { describe, expect, it } from 'vitest';
import { WreckArtState, WreckPieceSprite } from './wreckArt.js';
import { rebuildWreckPieces } from '../../../core/destruction/wreckDescriptorGeometry.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { structureWreckSource } from '../../../core/destruction/wreckSource.js';
import { shipHullOutline } from '../../../core/geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../../shared-types/shipKinds.js';
import { WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor } from '../../../shared-types/messages/wreckDescriptor.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieces.js';

const DEATH_TICK = 100;

function spritesOf(desc: WreckDescriptor, source: ReturnType<typeof structureWreckSource> | null) {
  const pieces = rebuildWreckPieces(desc);
  const state = new WreckArtState();
  const info = state.infoFor(desc, pieces, 0, { x: 0, y: 0, angle: 0 }, DEATH_TICK, 1000);
  return pieces.map((p, i) => ({ p, s: new WreckPieceSprite(p, desc.parentKind, null, info, i, null, null, source) }));
}

function structureDesc(k: string, seed: number): { desc: WreckDescriptor; src: ReturnType<typeof structureWreckSource> } {
  const src = structureWreckSource({ k });
  const v = src.outline[0]!;
  return {
    src,
    desc: {
      wreckId: 1, parentKind: WRECK_STRUCTURE_PARENT_KIND, structure: { k }, seed,
      killX: v[0] * 0.5, killY: v[1] * 0.5, killBlowDamage: 0.5, recentDamageRate: 0.2, snapChance: 0,
      algoVersion: FRACTURE_ALGO_VERSION, deathTick: DEATH_TICK,
    },
  };
}

const inRing = (ring: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean => {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const p = ring[a]!, q = ring[b]!;
    if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
  }
  return inside;
};
const segDist = (x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / l2)) : 0;
  return Math.hypot(x - a.x - ex * t, y - a.y - ey * t);
};
/** Distance from body-local math-up (x, y) to the piece's nearest outline / cut edge. */
function outlineDist(p: WreckPieceGeometry, x: number, y: number, cutOnly: boolean): number {
  const o = p.outline, n = o.length;
  let best = Infinity;
  for (let i = 0; i < n; i++) if (!cutOnly || p.cutEdges[i]) best = Math.min(best, segDist(x, y, o[i]!, o[(i + 1) % n]!));
  return best;
}

/** Every glow vertex of every piece (body-local, math-up) with its piece. */
function glowVerts(all: Array<{ p: WreckPieceGeometry; s: WreckPieceSprite }>): Array<{ p: WreckPieceGeometry; x: number; y: number }> {
  const out: Array<{ p: WreckPieceGeometry; x: number; y: number }> = [];
  for (const { p, s } of all) {
    const m = s.glowMesh();
    if (m === null) continue;
    for (let i = 0; i < m.positions.length; i += 2) out.push({ p, x: m.positions[i]!, y: -m.positions[i + 1]! });
  }
  return out;
}

/** The widest simple glow any ship draws: 0.1 × the largest simple-glow
 *  (sub-capital) hull, robot-nexus 110 u. */
const SHIP_SIMPLE_MAX_W = 0.1 * 110;

describe('structure pieces: the cut glow is an edge clipped to the piece', () => {
  for (const k of ['capital', 'turret', 'freight_dock']) {
    it(`${k}: every simple-glow vertex lies on its piece (none in the gap or past the hull)`, () => {
      for (const seed of [3, 17, 31]) {
        const { desc, src } = structureDesc(k, seed);
        const all = spritesOf(desc, src);
        for (const { s } of all) s.update(1000 + 500, 0);
        const verts = glowVerts(all);
        expect(verts.length, `${k} s${seed}: some glow`).toBeGreaterThan(0);
        for (const { p, x, y } of verts) {
          const ok = inRing(p.outline, x, y) || outlineDist(p, x, y, false) <= 1e-3;
          expect(ok, `${k} s${seed} (${x.toFixed(1)}, ${y.toFixed(1)}): on the piece`).toBe(true);
        }
        for (const { s } of all) s.destroy({ children: true });
      }
    });

    it(`${k}: the band is no wider than a ship's simple glow at its widest`, () => {
      for (const seed of [3, 17, 31]) {
        const { desc, src } = structureDesc(k, seed);
        const all = spritesOf(desc, src);
        for (const { s } of all) s.update(1000 + 500, 0);
        let reach = 0;
        for (const { p, x, y } of glowVerts(all)) reach = Math.max(reach, outlineDist(p, x, y, true));
        // Each face carries its half of the line (as the full glow's).
        expect(reach, `${k} s${seed}`).toBeLessThanOrEqual(SHIP_SIMPLE_MAX_W / 2 + 1e-3);
        for (const { s } of all) s.destroy({ children: true });
      }
    });
  }
});

describe('structure pieces: the simple glow is sized by the structure, as a ship by its own', () => {
  // A turret (r ~89) or connector (r 32) must get a ship-of-its-size line.
  // Round-2 stills: a turret's pieces drew the 11 u cap, because the width
  // was taken from the wreck's piece extent (5 wedges reach ~1.6 × r).
  for (const k of ['turret', 'connector']) {
    it(`${k}: each face's band ≤ half the share of its own radius`, () => {
      for (const seed of [3, 17, 31]) {
        const { desc, src } = structureDesc(k, seed);
        const all = spritesOf(desc, src);
        for (const { s } of all) s.update(1000 + 500, 0);
        let reach = 0;
        for (const { p, x, y } of glowVerts(all)) reach = Math.max(reach, outlineDist(p, x, y, true));
        expect(reach, `${k} s${seed}`).toBeLessThanOrEqual(Math.max(4.5, 0.1 * src.radius) / 2 + 1e-3);
        expect(reach, `${k} s${seed}: still a visible line`).toBeGreaterThan(1);
        for (const { s } of all) s.destroy({ children: true });
      }
    });
  }
});

describe('ship pieces: the simple glow is byte-identical', () => {
  /** Sum of |position| × (index + 1) over every glow vertex: a cheap,
   *  order-sensitive fingerprint of the geometry (recorded before the
   *  structure fix). */
  function fingerprint(kind: ShipKindId, seed: number): number {
    const hull = shipHullOutline(getShipKind(kind));
    const v = hull[0]!;
    const desc: WreckDescriptor = {
      wreckId: 1, parentKind: kind, seed, killX: v[0] * 0.4, killY: v[1] * 0.4, killBlowDamage: 0.5,
      recentDamageRate: 0.2, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, deathTick: DEATH_TICK,
    };
    const all = spritesOf(desc, null);
    let sum = 0, j = 0;
    for (const { s } of all) {
      s.update(1000 + 300, 0);
      const m = s.glowMesh();
      if (m !== null) for (let i = 0; i < m.positions.length; i++) sum += Math.abs(m.positions[i]!) * (++j);
      s.destroy({ children: true });
    }
    return sum;
  }
  const GOLDEN: Array<[ShipKindId, number, number]> = [
    ['scout', 5, 3413.293025060557],
    ['missile-frigate', 9, 9573.748879790306],
    ['robot-nexus', 13, 25290.970839500427],
    ['trader-hauler', 21, 14431.19910249114],
    ['destroyer', 7, 720874318.606168],
  ];
  for (const [kind, seed, want] of GOLDEN) {
    it(`${kind} s${seed}`, () => {
      expect(fingerprint(kind, seed)).toBe(want);
    });
  }
});
