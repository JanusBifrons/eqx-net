/**
 * Test kit (wreck fields 11): how full a wreck field looks on a phone, for the
 * tests that print counts (`wreckFieldLayout.test.ts`, `sectorSites.test.ts`).
 * Not used by the game.
 */
import { wreckPieceGeometry } from '../destruction/wreckPieces.js';
import { hullsInChunk, wreckFieldHullFracture, type WreckField } from './wreckFieldLayout.js';

/** A sideways Pixel 7's view (world u): at the default zoom 0.354 and at the
 *  zoom-out floor 0.15. */
export const PHONE_VIEWS = { default: { w: 2600, h: 1160 }, floor: { w: 6100, h: 2750 } } as const;

/** Pieces each hull breaks into (the loaded count), by hull key. */
export function hullPieceCounts(f: WreckField): Map<number, number> {
  const out = new Map<number, number>();
  for (const h of f.hulls) out.set(h.key, wreckPieceGeometry(wreckFieldHullFracture(h)).length);
  return out;
}

export interface ScreenStats { hullsMean: number; hullsWorst: number; piecesMean: number; piecesWorst: number; empty: number; samples: number }

/** Hulls (footprint touching the view) and their pieces in a `w` x `h` view,
 *  sampled on a grid of view centres across the core disc. */
export function screenStats(f: WreckField, pieces: ReadonlyMap<number, number>, coreRadius: number, w: number, h: number, step = 500): ScreenStats {
  let n = 0, hs = 0, ps = 0, hw = 0, pw = 0, empty = 0;
  for (let x = -coreRadius; x <= coreRadius; x += step) for (let y = -coreRadius; y <= coreRadius; y += step) {
    if (x * x + y * y > coreRadius * coreRadius) continue;
    const vx = f.x + x, vy = f.y + y;
    let hc = 0, pc = 0;
    for (const hull of f.hulls) {
      const dx = Math.max(0, Math.abs(hull.x - vx) - w / 2), dy = Math.max(0, Math.abs(hull.y - vy) - h / 2);
      if (dx * dx + dy * dy < hull.footprint * hull.footprint) { hc++; pc += pieces.get(hull.key) ?? 0; }
    }
    n++; hs += hc; ps += pc; hw = Math.max(hw, hc); pw = Math.max(pw, pc); if (hc === 0) empty++;
  }
  return { hullsMean: hs / n, hullsWorst: hw, piecesMean: ps / n, piecesWorst: pw, empty, samples: n };
}

/** The worst 5 x 5 chunk ring (the streamer's wake ring round one ship):
 *  hulls and pieces, and its centre chunk. */
export function worstRing(f: WreckField, pieces: ReadonlyMap<number, number>): { hulls: number; pieces: number; cx: number; cy: number } {
  let best = { hulls: 0, pieces: 0, cx: 0, cy: 0 };
  const centres = new Set<string>();
  for (const [, list] of f.byChunk) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) centres.add(`${list[0]!.cx + dx},${list[0]!.cy + dy}`);
  for (const c of centres) {
    const [cx, cy] = c.split(',').map(Number) as [number, number];
    let hc = 0, pc = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      for (const hull of hullsInChunk(f, cx + dx, cy + dy)) { hc++; pc += pieces.get(hull.key) ?? 0; }
    }
    if (pc > best.pieces) best = { hulls: hc, pieces: pc, cx, cy };
  }
  return best;
}

/** One printed line: screen stats at both zooms. */
export function screenLine(f: WreckField, pieces: ReadonlyMap<number, number>, coreRadius: number): string {
  const s = (v: { w: number; h: number }): string => {
    const r = screenStats(f, pieces, coreRadius, v.w, v.h);
    return `hulls mean ${r.hullsMean.toFixed(1)} worst ${r.hullsWorst}, pieces mean ${r.piecesMean.toFixed(1)} worst ${r.piecesWorst}, empty ${r.empty}/${r.samples}`;
  };
  return `default screen: ${s(PHONE_VIEWS.default)} | floor screen: ${s(PHONE_VIEWS.floor)}`;
}
