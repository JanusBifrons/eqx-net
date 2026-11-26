/**
 * Base platforms slice 24 — a deck base is sited by its plate extent, on a
 * plate centre, and the rock under its whole deck is cleared. Flag off, the
 * site search is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { isConnectorKind } from '../../shared-types/structureKinds.js';
import { plateCentreAtWorldInto } from '../hex/plateSet.js';
import { DECK_HEX_FLAT, DECK_HEX_SIZE } from '../hex/plates.js';
import { chooseBaseSite, deckExtent, grownExtent, type SiteBox, type SiteCircle } from './baseSite.js';
import { growBase } from './growBase.js';
import { deckBaseOriginInto } from './growDeck.js';
import type { BaseProfile } from './baseProfile.js';

const PROFILE: BaseProfile = { tier: 'settlement', role: 'refinery', ownerFaction: 'traders', wealth: 16_000, levelCap: 2, fenced: true };
const OPTS = { halfExtent: 30_000, margin: 250, step: 250, seed: 11 };

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** A seeded rock field: rocks on a jittered 1500 u grid over the search box. */
function rockField(): SiteCircle[] {
  const out: SiteCircle[] = [];
  let s = 12345;
  const rnd = (): number => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
  for (let x = -29_000; x <= 29_000; x += 1500) {
    for (let y = -29_000; y <= 29_000; y += 1500) out.push({ x: x + rnd() * 600, y: y + rnd() * 600, r: 120 + rnd() * 200 });
  }
  return out;
}

describe('chooseBaseSite deck option (base platforms 24)', () => {
  const grown = growBase(PROFILE, 7, [], { deck: true });

  it('the deck extent covers every plate (7 whole hexes each) and the buildings', () => {
    const e = deckExtent(grown.placements);
    const g = grownExtent(grown.placements);
    expect(e.x0).toBeLessThanOrEqual(g.x0); expect(e.x1).toBeGreaterThanOrEqual(g.x1);
    expect(e.y0).toBeLessThanOrEqual(g.y0); expect(e.y1).toBeGreaterThanOrEqual(g.y1);
    const PI = { i: 0, j: 0 };
    for (const p of grown.placements) {
      if (!isConnectorKind(p.kind) || !plateCentreAtWorldInto(p.x, p.y, PI)) continue;
      // A plate's 7 hexes reach a hex step plus half a hex across (x) and
      // 1.5 hex sizes + a hex size down (y) from its centre.
      expect(p.x - DECK_HEX_FLAT * 1.5).toBeGreaterThanOrEqual(e.x0 - 1e-6);
      expect(p.x + DECK_HEX_FLAT * 1.5).toBeLessThanOrEqual(e.x1 + 1e-6);
      expect(p.y - DECK_HEX_SIZE * 2.5).toBeGreaterThanOrEqual(e.y0 - 1e-6);
      expect(p.y + DECK_HEX_SIZE * 2.5).toBeLessThanOrEqual(e.y1 + 1e-6);
    }
  });

  it('picks a plate centre; the whole plate extent is reserved and its rocks are returned to clear', () => {
    const ext = deckExtent(grown.placements);
    const soft = rockField();
    const hard: SiteBox[] = [{ x: 0, y: 0, hw: 4000, hh: 4000 }];
    const site = chooseBaseSite(ext, hard, soft, { ...OPTS, deck: true })!;
    expect(site).not.toBeNull();
    const PI = { i: 0, j: 0 };
    expect(plateCentreAtWorldInto(site.x, site.y, PI), 'site on the plate lattice').toBe(true);
    // The seeder's lattice snap leaves it where it is (no shift after siting).
    expect(deckBaseOriginInto(site.x, site.y, { x: 0, y: 0 })).toEqual({ x: site.x, y: site.y });
    // Every rock touching the plate extent (plus margin) is cleared; none left.
    const cleared = new Set(site.overlapped);
    const x0 = site.x + ext.x0 - OPTS.margin, x1 = site.x + ext.x1 + OPTS.margin;
    const y0 = site.y + ext.y0 - OPTS.margin, y1 = site.y + ext.y1 + OPTS.margin;
    soft.forEach((c, i) => {
      const dx = Math.max(x0 - c.x, 0, c.x - x1), dy = Math.max(y0 - c.y, 0, c.y - y1);
      if (dx * dx + dy * dy < c.r * c.r) expect(cleared.has(i), `rock ${i} on the deck`).toBe(true);
    });
    expect(site.overlapped.length).toBeGreaterThan(0);
    // Inside the search square, clear of the hard box.
    expect(site.x + ext.x0 - OPTS.margin).toBeGreaterThanOrEqual(-OPTS.halfExtent);
    expect(site.x + ext.x1 + OPTS.margin).toBeLessThanOrEqual(OPTS.halfExtent);
    expect(x1 <= -4000 || x0 >= 4000 || y1 <= -4000 || y0 >= 4000).toBe(true);
    // Every plate of the base, moved to the site, stays on the world lattice.
    for (const p of grown.placements) {
      if (isConnectorKind(p.kind) && plateCentreAtWorldInto(p.x, p.y, PI)) {
        expect(plateCentreAtWorldInto(site.x + p.x, site.y + p.y, PI)).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    const ext = deckExtent(grown.placements);
    const a = chooseBaseSite(ext, [], rockField(), { ...OPTS, deck: true });
    const b = chooseBaseSite(ext, [], rockField(), { ...OPTS, deck: true });
    expect(a).toEqual(b);
  });

  it('flag off: the site search is unchanged', () => {
    const flat = growBase(PROFILE, 7, []);
    const ext = grownExtent(flat.placements);
    const soft = rockField();
    const hard: SiteBox[] = [{ x: 0, y: 0, hw: 4000, hh: 4000 }, { x: 15_000, y: -9000, hw: 2500, hh: 3000 }];
    const sites = [
      chooseBaseSite(ext, hard, soft, OPTS),
      chooseBaseSite(ext, hard, soft, { ...OPTS, deck: false }),
      chooseBaseSite(ext, [], soft, { ...OPTS, halfExtent: 9000, seed: 3 }),
      chooseBaseSite(ext, hard, [], { ...OPTS, within: { x: 8000, y: 8000, r: 9000 } }),
    ];
    for (const s of sites) expect(s).not.toBeNull();
    expect(sites.map((s) => fnv(JSON.stringify(s)))).toEqual(FINGERPRINTS);
  });

  // Slice 25: a dense (asteroid-field) base reserves a smaller deck, so the
  // same site in the same field clears fewer rocks.
  it('a dense base is sited by its smaller dense deck and clears no more rock', () => {
    const dense = growBase(PROFILE, 7, [], { deck: true, dense: true });
    const area = (e: { x0: number; x1: number; y0: number; y1: number }): number => (e.x1 - e.x0) * (e.y1 - e.y0);
    const de = deckExtent(dense.placements), se = deckExtent(grown.placements);
    expect(area(de)).toBeLessThan(area(se));
    const soft = rockField();
    const within = { x: 0, y: 0, r: 12_000 };
    const ds = chooseBaseSite(de, [], soft, { ...OPTS, within, deck: true });
    const ss = chooseBaseSite(se, [], soft, { ...OPTS, within, deck: true });
    expect(ds).not.toBeNull();
    expect(ss).not.toBeNull();
    const PI = { i: 0, j: 0 };
    expect(plateCentreAtWorldInto(ds!.x, ds!.y, PI)).toBe(true);
    console.log(`dense deck ${Math.round(area(de) / 1e6)} Mu² clears ${ds!.overlapped.length} rocks; sparse ${Math.round(area(se) / 1e6)} Mu² clears ${ss!.overlapped.length}`);
    expect(ds!.overlapped.length).toBeLessThanOrEqual(ss!.overlapped.length);
  });
});

/** Taken with the spike tip's `baseSite.ts` before slice 24. */
const FINGERPRINTS = ['e27b058', 'e27b058', 'a598701c', '59b5708a'];
