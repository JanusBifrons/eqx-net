import { describe, expect, it } from 'vitest';
import { wreckField, hullsInChunk, wreckFieldHullFracture, wreckFieldKinds, rockFieldBlocker, circleTouchesPolygon, type WreckField, type WreckFieldOpts } from './wreckFieldLayout.js';
import { CHUNK_SIZE, chunkOf, rockKey, slicedField } from './fieldLayout.js';
import { cutFieldOpts } from './chunkStreamer.js';
import { wreckPieceGeometry } from '../destruction/wreckPieces.js';
import { wreckKindAllowed } from '../destruction/wreckKindAllowed.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const SIDES = ['ashen-league', 'vel-concord'] as const;
const typical = (seed = 'thornfield', extra: Partial<WreckFieldOpts> = {}): WreckField =>
  wreckField({ seed, x: 0, y: 0, sides: SIDES, ...extra });

function overlaps(f: WreckField): number {
  let n = 0;
  for (let i = 0; i < f.hulls.length; i++) for (let j = i + 1; j < f.hulls.length; j++) {
    const a = f.hulls[i]!, b = f.hulls[j]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) < a.footprint + b.footprint) n++;
  }
  return n;
}

describe('wreckFieldLayout', () => {
  it('is deterministic: same seed, identical hull list; another seed differs', () => {
    const a = typical(), b = typical();
    expect(JSON.stringify(a.hulls)).toBe(JSON.stringify(b.hulls));
    expect(JSON.stringify(typical('other').hulls)).not.toBe(JSON.stringify(a.hulls));
  });

  it('places a mid-size field: capitals, sub-caps and fighters in core and trails, owned by a side', () => {
    for (const seed of ['thornfield', 'a', 'b', 'c']) {
      const f = typical(seed);
      const caps = f.hulls.filter((h) => getShipKind(h.kindId).sizeClass === 'capital').length;
      expect(caps).toBeGreaterThanOrEqual(2);
      expect(f.hulls.length).toBeGreaterThan(40);
      expect(f.hulls.some((h) => h.zone === 'trail')).toBe(true);
      for (const h of f.hulls) {
        expect(SIDES).toContain(h.owner);
        expect(wreckKindAllowed(h.kindId, true, true)).toBe(true);
      }
      expect(new Set(f.hulls.map((h) => h.owner)).size).toBe(2);
    }
  });

  it('only picks kinds the room wrecks', () => {
    const f = typical('thornfield', { capitalWrecksOn: false });
    expect(f.hulls.length).toBeGreaterThan(0);
    for (const h of f.hulls) expect(wreckKindAllowed(h.kindId, false, true)).toBe(true);
    expect(wreckFieldKinds(true, true).subcaps).not.toContain('havok');
  });

  it('hull footprints never overlap', () => {
    for (const seed of ['thornfield', 'a', 'b', 'c', 'd']) expect(overlaps(typical(seed))).toBe(0);
  });

  it('keeps footprints out of clearings', () => {
    const clearings = [{ x: 0, y: 0, r: 8000 }, { x: 15_000, y: -5000, r: 4000 }];
    const f = typical('thornfield', { clearings });
    for (const h of f.hulls) for (const k of clearings) expect(Math.hypot(h.x - k.x, h.y - k.y)).toBeGreaterThanOrEqual(k.r + h.footprint);
  });

  it('never overlaps rocks when given the rock field', () => {
    // A small rock field (30 km radius) at the origin; the wreck field's core
    // reaches into its rim.
    const rocks = { ...cutFieldOpts('rocks-x'), radius: 30_000 };
    const at = { x: 40_000, y: 0 };
    const free = typical('thornfield', at);
    const f = typical('thornfield', { ...at, blocked: rockFieldBlocker(rocks) });
    // An independent cut over the whole wreck field's box.
    const R = 100_000;
    const cut = slicedField({ seed: rocks.seed, battleshipLength: rocks.battleshipLength, fighterLength: rocks.fighterLength, radius: rocks.radius, view: { x0: at.x - R, y0: at.y - R, x1: at.x + R, y1: at.y + R } });
    const hits = (w: WreckField): number => w.hulls.filter((h) => cut.some((r) => circleTouchesPolygon(h.x, h.y, h.footprint, r.verts))).length;
    expect(hits(free)).toBeGreaterThan(0); // the case is real
    expect(hits(f)).toBe(0);
    expect(overlaps(f)).toBe(0);
  });

  it('hullsInChunk partitions the list exactly, slots and keys match', () => {
    const f = typical();
    const seen = new Set<number>();
    let total = 0;
    for (const [, list] of f.byChunk) {
      const { cx, cy } = list[0]!;
      const got = hullsInChunk(f, cx, cy);
      expect(got).toBe(list); // precomputed, no copy
      got.forEach((h, i) => {
        expect(chunkOf(h.x, h.y)).toEqual({ cx, cy });
        expect(h.slot).toBe(i);
        expect(h.key).toBe(rockKey(cx, cy, i));
        expect(seen.has(h.key)).toBe(false);
        seen.add(h.key);
      });
      total += got.length;
    }
    expect(total).toBe(f.hulls.length);
    expect(hullsInChunk(f, 120, 120)).toHaveLength(0);
  });

  it('prints hulls and estimated pieces per chunk for a typical field', () => {
    const rows: string[] = [];
    for (const seed of ['thornfield', 'a', 'b']) {
      const f = typical(seed);
      const pieces = new Map<number, number>();
      let totalPieces = 0;
      for (const h of f.hulls) {
        const n = wreckPieceGeometry(wreckFieldHullFracture(h)).length;
        expect(n).toBeGreaterThan(0);
        totalPieces += n;
        const k = rockKey(h.cx, h.cy, 0);
        pieces.set(k, (pieces.get(k) ?? 0) + n);
      }
      const hullCounts = [...f.byChunk.values()].map((l) => l.length);
      // Worst 5×5 chunk ring (the streamer's wake ring around one ship).
      let ringHulls = 0, ringPieces = 0;
      for (const [, list] of f.byChunk) {
        const { cx, cy } = list[0]!;
        let h = 0, p = 0;
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
          h += hullsInChunk(f, cx + dx, cy + dy).length;
          p += pieces.get(rockKey(cx + dx, cy + dy, 0)) ?? 0;
        }
        ringHulls = Math.max(ringHulls, h); ringPieces = Math.max(ringPieces, p);
      }
      const byClass = { cap: 0, sub: 0, ftr: 0 };
      for (const h of f.hulls) { const k = getShipKind(h.kindId); if (k.sizeClass === 'capital') byClass.cap++; else if (k.radius >= 28) byClass.sub++; else byClass.ftr++; }
      rows.push(`${seed.padEnd(10)} hulls ${f.hulls.length} (cap ${byClass.cap} sub ${byClass.sub} ftr ${byClass.ftr}, dropped ${f.dropped}) pieces ${totalPieces} | chunks ${f.byChunk.size} (${CHUNK_SIZE} u) | per chunk: hulls max ${Math.max(...hullCounts)} mean ${(f.hulls.length / f.byChunk.size).toFixed(1)}, pieces max ${Math.max(...pieces.values())} mean ${(totalPieces / f.byChunk.size).toFixed(1)} | worst 5x5 ring: hulls ${ringHulls} pieces ${ringPieces}`);
    }
    console.log(`wreck field per chunk:\n${rows.join('\n')}`);
  });
});
