/**
 * Solar-system sector pockets (plan prancy-squishing-donut Phase 4): checked
 * on every real galaxy sector.
 */
import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, GALAXY_FACTIONS, getNeighbours, getSector, axialToPixel } from './galaxy.js';
import { sectorSites, nearestSite, SOLAR_HALF_EXTENT, POCKET_MIN_GAP, POCKET_MAX_GAP, pocketPadPair, POCKET_PAD_CHANCE, sectorCutField, sectorWreckField, warpDropPoint, FIELD_CLEARING_MARGIN, BELT_CLEARING_MARGIN, fieldClearingRadius } from './sectorSites.js';
import { cutFieldOpts, fieldRocksInBox } from '../terrain/chunkStreamer.js';
import { slicedFieldLanes } from '../terrain/fieldLayout.js';
import { rockFieldBlocker, wreckField } from '../terrain/wreckFieldLayout.js';

describe('sectorSites', () => {
  it('is deterministic per sector key', () => {
    for (const s of GALAXY_SECTORS) expect(sectorSites(s.key)).toEqual(sectorSites(s.key));
    expect(sectorSites('nowhere')).toEqual([]);
  });

  for (const sector of GALAXY_SECTORS) {
    it(`${sector.key}: home at the origin, a gate per neighbour, pockets 50-150 km apart, in bounds`, () => {
      const sites = sectorSites(sector.key);
      expect(sites[0]).toMatchObject({ id: 'home', kind: 'home', x: 0, y: 0 });
      // One gate pocket per neighbour, facing it.
      const gates = sites.filter((s) => s.kind === 'gate');
      const neighbours = getNeighbours(sector.key);
      expect(gates.map((g) => g.neighbour).sort()).toEqual(neighbours.map((n) => n.key).sort());
      for (const g of gates) {
        const a = axialToPixel(sector.hex, 1), b = axialToPixel(getSector(g.neighbour!)!.hex, 1);
        const want = Math.atan2(-(b.y - a.y), b.x - a.x), got = Math.atan2(g.y, g.x);
        expect(Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)))).toBeLessThan(0.01);
      }
      // Every kind beyond home and gates is present: belt(s), base, combat.
      for (const k of ['belt', 'base', 'combat'] as const) expect(sites.some((s) => s.kind === k), k).toBe(true);
      // Spacing + bounds.
      for (const s of sites) {
        expect(Math.abs(s.x) + s.r).toBeLessThanOrEqual(SOLAR_HALF_EXTENT);
        expect(Math.abs(s.y) + s.r).toBeLessThanOrEqual(SOLAR_HALF_EXTENT);
        let nearest = Infinity;
        for (const o of sites) {
          if (o === s) continue;
          const d = Math.hypot(o.x - s.x, o.y - s.y);
          nearest = Math.min(nearest, d);
          if (s.kind !== 'gate' || o.kind !== 'gate') expect(d, `${s.id}↔${o.id}`).toBeGreaterThanOrEqual(POCKET_MIN_GAP);
        }
        if (s.kind !== 'gate') expect(nearest, `${s.id} isolated`).toBeLessThanOrEqual(POCKET_MAX_GAP);
      }
    });
  }

  it('nearestSite finds the closest pocket of a kind', () => {
    const sites = sectorSites('sol-prime');
    expect(nearestSite(sites, 10, 10)?.id).toBe('home');
    const belt = sites.find((s) => s.kind === 'belt')!;
    expect(nearestSite(sites, belt.x + 100, belt.y, 'belt')?.id).toBe(belt.id);
  });
});

describe('alien gate site search at solar-system extents', () => {
  it('searches a window around the ideal site, not the whole ±200,000 u sector', async () => {
    const { alienGateCandidates } = await import('./alienGates.js');
    const site = { neighbour: 'x', x: 170_000, y: 20_000 };
    const c = alienGateCandidates(site, 800, 200_000);
    // The whole-sector grid was ~2.56 M candidates per gate (boot time + heap).
    expect(c.length).toBeLessThan(30_000);
    expect(c[0]).toEqual({ x: 170_000, y: 20_000 });
    for (const p of c) expect(Math.abs(p.x)).toBeLessThanOrEqual(200_000 - 800);
  });
  it('is unchanged for today’s 5,000 u sectors (the window covers them)', async () => {
    const { alienGateCandidates } = await import('./alienGates.js');
    const c = alienGateCandidates({ neighbour: 'x', x: 4100, y: 0 }, 800, 5000);
    const lim = Math.floor((5000 - 800) / 250) * 250;
    expect(c.length).toBe(((2 * lim) / 250 + 1) ** 2 + 1);
  });
});

describe('pocketCentre', () => {
  it('is the sector origin when solar-system sectors are off, the pocket when on', async () => {
    const { pocketCentre } = await import('./sectorSites.js');
    expect(pocketCentre('sol-prime', 'combat', false)).toEqual({ x: 0, y: 0 });
    const combat = sectorSites('sol-prime').find((s) => s.kind === 'combat')!;
    expect(pocketCentre('sol-prime', 'combat', true)).toEqual({ x: combat.x, y: combat.y });
    expect(pocketCentre('nowhere', 'combat', true)).toEqual({ x: 0, y: 0 });
  });
});

describe('pocketPadPair (wrap-up W1b: rare transit pads)', () => {
  it('is deterministic, links home to one belt/base/battle pocket, pads inside each pocket', () => {
    for (const s of GALAXY_SECTORS) {
      const p = pocketPadPair(s.key);
      expect(pocketPadPair(s.key)).toEqual(p);
      if (p === null) continue;
      expect(p.a.kind).toBe('home');
      expect(['belt', 'base', 'combat']).toContain(p.b.kind);
      expect(Math.hypot(p.ax - p.a.x, p.ay - p.a.y)).toBeLessThan(p.a.r);
      expect(Math.hypot(p.bx - p.b.x, p.by - p.b.y)).toBeLessThan(p.b.r);
    }
  });

  it('is rare: some systems have none, and none has more than one pair', () => {
    const withPads = GALAXY_SECTORS.filter((s) => pocketPadPair(s.key) !== null).length;
    expect(withPads).toBeGreaterThan(0);
    expect(withPads).toBeLessThan(GALAXY_SECTORS.length);
    expect(withPads / GALAXY_SECTORS.length).toBeLessThanOrEqual(POCKET_PAD_CHANCE + 0.25);
  });
});

describe('sectorCutField (macro terrain F4)', () => {
  const marked = GALAXY_SECTORS.filter((s) => s.features.includes('asteroid'));
  const clear = GALAXY_SECTORS.filter((s) => !s.features.includes('asteroid'));

  it('every asteroid-marked sector has one field; no other sector has one', () => {
    expect(marked.length).toBeGreaterThan(0);
    for (const s of marked) expect(sectorCutField(s.key, true), s.key).not.toBeNull();
    for (const s of clear) expect(sectorCutField(s.key, true), s.key).toBeNull();
    expect(sectorCutField('no-such-sector', true)).toBeNull();
  });

  it('is off with solar-system sectors off', () => {
    for (const s of marked) expect(sectorCutField(s.key, false)).toBeNull();
  });

  it('is stable per sector and has a distinct versioned seed', () => {
    const seeds = new Set<string>();
    for (const s of marked) {
      const f = sectorCutField(s.key, true)!;
      expect(sectorCutField(s.key, true)).toEqual(f);
      expect(f.seed).toMatch(/^galaxy:.+:v[0-9]+$/);
      expect(f.seed.length).toBeLessThanOrEqual(64); // welcome schema cap
      seeds.add(f.seed);
    }
    expect(seeds.size).toBe(marked.length);
  });

  it('clears every belt, base and battle pocket; gates are outside the field', () => {
    for (const s of marked) {
      const f = sectorCutField(s.key, true)!;
      for (const site of sectorSites(s.key)) {
        const has = f.clearings.some((c) => c.x === site.x && c.y === site.y && c.r === fieldClearingRadius(site));
        if (site.kind === 'gate') expect(has, site.id).toBe(false);
        else expect(has, `${s.key} ${site.id}`).toBe(true);
      }
    }
  });

  it('belts clear by BELT_CLEARING_MARGIN, bases and battle zones by FIELD_CLEARING_MARGIN', () => {
    expect(fieldClearingRadius({ kind: 'belt', r: 4000 })).toBe(4000 + BELT_CLEARING_MARGIN);
    expect(fieldClearingRadius({ kind: 'base', r: 4000 })).toBe(4000 + FIELD_CLEARING_MARGIN);
  });

  // The phone's view round a ship at the closest zoom-out is about ±3 km by
  // ±1.4 km: the wall must be in it, the ship must not be in a rock.
  it('every warp to a pocket, in every field, drops you in open space; at a belt, in sight of the rock wall', () => {
    const bad: string[] = [];
    for (const s of marked) {
      const f = sectorCutField(s.key, true)!;
      const opts = { ...cutFieldOpts(f.seed), clearings: f.clearings };
      for (const site of sectorSites(s.key).filter((p) => p.kind !== 'gate' && p.kind !== 'home')) {
        // Arrive from the home side, as a warp from home would.
        const drop = warpDropPoint(site, 0, 0);
        const rocks = fieldRocksInBox(opts, drop.x - 8000, drop.y - 8000, drop.x + 8000, drop.y + 8000);
        const gap = Math.min(Infinity, ...rocks.map((r) => Math.hypot(r.x - drop.x, r.y - drop.y) - r.radius));
        if (gap < 200) bad.push(`${s.key} ${site.id}: rock ${Math.round(gap)} u from the drop`);
        // A belt in a lane looks down the lane: its walls are half a lane off.
        const lane = slicedFieldLanes({ seed: opts.seed, battleshipLength: opts.battleshipLength })
          .find((ln) => Math.abs((drop.x - ln.o.x) * ln.n.x + (drop.y - ln.o.y) * ln.n.y) < ln.half);
        const view = lane ? lane.half : 3000;
        if (site.kind === 'belt' && !(gap < view)) bad.push(`${s.key} ${site.id}: no rock in view (${Math.round(gap)} u)`);
      }
    }
    expect(bad).toEqual([]);
  }, 180_000);
});

describe('sectorWreckField (wreck fields F3, slice 8)', () => {
  const marked = GALAXY_SECTORS.filter((s) => s.features.includes('wrecks'));

  it('every wrecks-marked sector, and only those, gets one field; off with solar sectors off', () => {
    expect(marked.length).toBeGreaterThan(0);
    for (const s of GALAXY_SECTORS) expect(sectorWreckField(s.key, true) !== null, s.key).toBe(s.features.includes('wrecks'));
    for (const s of marked) expect(sectorWreckField(s.key, false)).toBeNull();
    expect(sectorWreckField('no-such-sector', true)).toBeNull();
  });

  it('sits on the battle pocket, keeps every pocket open, and is stable', () => {
    for (const s of marked) {
      const f = sectorWreckField(s.key, true)!;
      expect(sectorWreckField(s.key, true)).toEqual(f);
      expect(f.seed).toBe(s.key); // the layout hashes `wrecks:<seed>`
      const combat = sectorSites(s.key).find((p) => p.kind === 'combat')!;
      expect({ x: f.x, y: f.y }, s.key).toEqual({ x: combat.x, y: combat.y });
      expect(f.clearings).toEqual(sectorSites(s.key).map((p) => ({ x: p.x, y: p.y, r: fieldClearingRadius(p) })));
    }
  });

  it('sides: own region vs the most common other neighbour region, else a seeded rival power', () => {
    const powers = new Set(GALAXY_FACTIONS.map((f) => f.id));
    for (const s of marked) {
      const [own, rival] = sectorWreckField(s.key, true)!.sides;
      expect(own).toBe(s.region);
      expect(rival).not.toBe(s.region);
      expect(powers.has(rival), rival).toBe(true);
      const others = getNeighbours(s.key).filter((n) => n.region !== s.region).map((n) => n.region);
      if (others.length > 0) {
        const c = (r: string): number => others.filter((o) => o === r).length;
        expect(c(rival)).toBe(Math.max(...others.map(c)));
      }
    }
  });

  // Printed, not asserted beyond "most hulls placed": the hull counts each
  // galaxy field lays out, around its pockets and (rock sectors) its rocks.
  it('lays out in every marked sector, off the rocks where the sector has a field', () => {
    for (const s of marked) {
      const f = sectorWreckField(s.key, true)!;
      const cut = sectorCutField(s.key, true);
      const field = wreckField({ ...f, ...(cut ? { blocked: rockFieldBlocker(cutFieldOpts(cut.seed, cut.clearings)) } : {}) });
      const sides = new Set(field.hulls.map((h) => h.owner));
      console.log(`[wreck fields] ${s.key}${cut ? ' (+rocks)' : ''}: ${field.hulls.length} hulls, ${field.dropped} dropped, sides ${f.sides.join(' vs ')}`);
      expect(field.hulls.length, s.key).toBeGreaterThan(field.dropped);
      for (const side of sides) expect(f.sides).toContain(side);
      for (const h of field.hulls) for (const c of f.clearings) expect(Math.hypot(h.x - c.x, h.y - c.y), `${s.key} hull in a clearing`).toBeGreaterThanOrEqual(c.r);
    }
  }, 180_000);
});
