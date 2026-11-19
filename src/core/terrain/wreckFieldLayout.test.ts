import { describe, expect, it } from 'vitest';
import { wreckField, hullsInChunk, wreckFieldHullFracture, wreckFieldKinds, rockFieldBlocker, circleTouchesPolygon, type WreckField, type WreckFieldOpts } from './wreckFieldLayout.js';
import { CHUNK_SIZE, chunkOf, rockKey, slicedField } from './fieldLayout.js';
import { cutFieldOpts } from './chunkStreamer.js';
import { wreckPieceGeometry } from '../destruction/wreckPieces.js';
import { wreckKindAllowed } from '../destruction/wreckKindAllowed.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { hullPieceCounts, screenLine, worstRing } from './wreckFieldTestKit.js';
import { WRECK_FIELD } from './wreckFieldLayout.js';

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

  it('wreck fields 13 "more big wrecks": sub-caps outnumber fighters, mostly missile frigates; capitals mostly destroyers and cruisers', () => {
    const tally: Record<string, number> = {};
    let sub = 0, ftr = 0;
    for (const seed of ['thornfield', 'a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      for (const h of typical(seed).hulls) {
        const k = getShipKind(h.kindId);
        tally[h.kindId] = (tally[h.kindId] ?? 0) + 1;
        if (k.sizeClass !== 'capital') { if (k.radius >= WRECK_FIELD.subcapMinRadius) sub++; else ftr++; }
      }
    }
    expect(sub).toBeGreaterThan(ftr);
    const n = (id: string): number => tally[id] ?? 0;
    expect(n('missile-frigate')).toBeGreaterThan(n('heavy') + n('gunship'));
    const small = n('destroyer') + n('light-cruiser') + n('heavy-cruiser') + n('heavy-cruiser-beam');
    const big = n('battlecruiser') + n('battlecruiser-lance') + n('battleship') + n('battleship-rail') + n('barge');
    expect(small).toBeGreaterThan(big);
  });

  it('wreck fields 13: a capital lies in the field (centre within capitalOverhang footprints of the core rim), even round a big clearing', () => {
    const fields = [typical('thornfield'), typical('a'), typical('b', { clearings: [{ x: 0, y: 0, r: 3000 }] }), wreckField({ seed: 'look', x: 60_000, y: 0, sides: SIDES, blocked: rockFieldBlocker(cutFieldOpts('look', undefined)) })];
    let caps = 0;
    for (const f of fields) for (const h of f.hulls) {
      if (getShipKind(h.kindId).sizeClass !== 'capital') continue;
      caps++;
      expect(Math.hypot(h.x - f.x, h.y - f.y), `${f.seed} ${h.kindId}`).toBeLessThanOrEqual(WRECK_FIELD.coreRadius + h.footprint * WRECK_FIELD.capitalOverhang);
    }
    expect(caps).toBeGreaterThan(0);
  });

  it('wreck fields 14: an arrival spot stays clear, with wrecks seated round it on every side of a phone view', () => {
    const spots = [0, 1, 2, 3].map((i) => ({ x: Math.cos(i * Math.PI / 2) * 3000, y: Math.sin(i * Math.PI / 2) * 3000, r: 300 }));
    const plain = typical('thornfield', { clearings: [{ x: 0, y: 0, r: 1800 }] });
    const f = typical('thornfield', { clearings: [{ x: 0, y: 0, r: 1800 }], arrivals: spots });
    // The same hulls, only placed differently.
    expect(f.hulls.length + f.dropped).toBe(plain.hulls.length + plain.dropped);
    for (const s of spots) {
      for (const h of f.hulls) expect(Math.hypot(h.x - s.x, h.y - s.y)).toBeGreaterThanOrEqual(s.r + h.footprint);
      // Its seated hulls lie in the box round it, on most of its sides (the
      // quarters the box's diagonals cut).
      const seated = f.hulls.filter((h) => Math.abs(h.x - s.x) <= WRECK_FIELD.arrivalHalfW && Math.abs(h.y - s.y) <= WRECK_FIELD.arrivalHalfH);
      expect(seated.length).toBeGreaterThanOrEqual(WRECK_FIELD.arrivalHulls);
      const sides = new Set(seated.map((h) => Math.round(Math.atan2((h.y - s.y) / WRECK_FIELD.arrivalHalfH, (h.x - s.x) / WRECK_FIELD.arrivalHalfW) / (Math.PI / 2)) & 3));
      expect(sides.size).toBeGreaterThanOrEqual(3);
    }
    // No arrivals: the layout is unchanged by the option's absence.
    expect(typical('thornfield', { clearings: [{ x: 0, y: 0, r: 1800 }], arrivals: [] }).hulls).toEqual(plain.hulls);
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
    // Wreck fields 11: how full a sideways phone screen is, across the core.
    const lines = ['thornfield', 'a', 'b'].map((seed) => {
      const f = typical(seed), p = hullPieceCounts(f), ring = worstRing(f, p);
      return `${seed.padEnd(10)} ${screenLine(f, p, WRECK_FIELD.coreRadius)} | worst ring ${ring.pieces} pieces (${ring.hulls} hulls) at chunk (${ring.cx}, ${ring.cy})`;
    });
    console.log(`wreck field per phone screen:\n${lines.join('\n')}`);
  });
});
