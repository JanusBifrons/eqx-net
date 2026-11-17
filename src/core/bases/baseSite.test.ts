import { describe, expect, it } from 'vitest';
import { chooseBaseSite, grownExtent, nearestClearPoint, type BaseExtent } from './baseSite.js';
import { growBase } from './growBase.js';
import { baseProfileFor, contextForSector, hashString } from './baseProfile.js';
import { GALAXY_SECTORS } from '../galaxy/galaxy.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';

const OPTS = { halfExtent: 5000, margin: 200, step: 250, seed: 7 };
const SMALL: BaseExtent = { x0: -1000, x1: 1000, y0: -500, y1: 500 };

function inside(site: { x: number; y: number }, ext: BaseExtent, half: number): boolean {
  return site.x + ext.x0 >= -half && site.x + ext.x1 <= half && site.y + ext.y0 >= -half && site.y + ext.y1 <= half;
}

describe('chooseBaseSite (T1)', () => {
  it('packs flush: finds a slot between two blockers narrower than the grid can hit, and the high sector edges', () => {
    // A 3530 band across the sector; the base fits only for a Capital y in
    // -15..15, which no 250 grid row hits; the flush sites do.
    const hard = [
      { x: 0, y: 3000, hw: 6000, hh: 1235 }, // bottom edge 1765
      { x: 0, y: -3000, hw: 6000, hh: 1235 }, // top edge -1765
    ];
    const band = { x0: -1000, x1: 1000, y0: -1550, y1: 1550 }; // 3100 + 400 margin into a 3530 band
    const site = chooseBaseSite(band, hard, [], OPTS);
    expect(site).not.toBeNull();
    expect(site!.y + band.y0 - OPTS.margin).toBeGreaterThanOrEqual(-1765 - 1e-6);
    expect(site!.y + band.y1 + OPTS.margin).toBeLessThanOrEqual(1765 + 1e-6);
    // The high x edge is reachable exactly (the grid alone stops short).
    const free = chooseBaseSite(SMALL, [{ x: -3000, y: 0, hw: 2000, hh: 6000 }], [], { ...OPTS, step: 333 });
    expect(free!.x + SMALL.x1).toBeCloseTo(5000 - OPTS.margin, 6);
  });

  it('counts a dock\x27s landing pad in the grown extent', () => {
    const e = grownExtent([{ kind: 'freight_dock', x: 0, y: 0 }]);
    expect(e).toEqual({ x0: -500, x1: 500, y0: -200, y1: 710 });
    const flipped = grownExtent([{ kind: 'freight_dock', x: 0, y: 0, rot: 180 }]);
    expect(flipped).toEqual({ x0: -500, x1: 500, y0: -710, y1: 200 });
  });

  it('fits the base inside the sector, as far from the origin (spawn) as it can', () => {
    const site = chooseBaseSite(SMALL, [], [], OPTS)!;
    expect(inside(site, SMALL, 5000 - 200)).toBe(true);
    // A corner: both axes pushed to the edge.
    expect(Math.abs(site.x)).toBeGreaterThan(3000);
    expect(Math.abs(site.y)).toBeGreaterThan(3500);
  });

  it('never touches a hard blocker (a saved player structure or parked hull)', () => {
    // Block every corner region; the base must find space elsewhere.
    const hard = [
      { x: 3500, y: 3500, hw: 1500, hh: 1500 }, { x: -3500, y: 3500, hw: 1500, hh: 1500 },
      { x: 3500, y: -3500, hw: 1500, hh: 1500 }, { x: -3500, y: -3500, hw: 1500, hh: 1500 },
    ];
    const site = chooseBaseSite(SMALL, hard, [], OPTS)!;
    expect(site).not.toBeNull();
    for (const b of hard) {
      const hit = site.x + SMALL.x0 < b.x + b.hw && site.x + SMALL.x1 > b.x - b.hw
        && site.y + SMALL.y0 < b.y + b.hh && site.y + SMALL.y1 > b.y - b.hh;
      expect(hit).toBe(false);
    }
  });

  it('prefers fewer asteroids, and reports the ones it overlaps so they can be cleared', () => {
    // Asteroids everywhere except one band; a clear site exists.
    const soft = [];
    for (let x = -4500; x <= 4500; x += 600) for (let y = -4500; y <= 1500; y += 600) soft.push({ x, y, r: 80 });
    const site = chooseBaseSite(SMALL, [], soft, OPTS)!;
    expect(site.overlapped).toHaveLength(0);
    expect(site.y).toBeGreaterThan(1500);
  });

  it('returns null when the base cannot fit at all', () => {
    expect(chooseBaseSite({ x0: -6000, x1: 6000, y0: -10, y1: 10 }, [], [], OPTS)).toBeNull();
    expect(chooseBaseSite(SMALL, [{ x: 0, y: 0, hw: 5000, hh: 5000 }], [], OPTS)).toBeNull();
  });

  it('is deterministic for a seed', () => {
    expect(chooseBaseSite(SMALL, [], [], OPTS)).toEqual(chooseBaseSite(SMALL, [], [], OPTS));
  });

  it('every real galaxy sector base fits its sector (empty sector)', () => {
    for (const s of GALAXY_SECTORS) {
      const seed = hashString(s.key);
      const grown = growBase(baseProfileFor(contextForSector(s.key), seed), seed, s.features);
      const ext = grownExtent(grown.placements);
      const site = chooseBaseSite(ext, [], [], { ...OPTS, halfExtent: SECTOR_PLAYABLE_HALF_EXTENT, seed });
      expect(site, `${s.key} base must fit`).not.toBeNull();
    }
  });
});

describe('nearestClearPoint (T1 spawn clearance)', () => {
  it('leaves a clear point alone and moves one out of a box', () => {
    const boxes = [{ x: 0, y: 0, hw: 300, hh: 300 }];
    expect(nearestClearPoint(1000, 0, boxes, 60)).toEqual({ x: 1000, y: 0 });
    const p = nearestClearPoint(0, 0, boxes, 60);
    const dx = Math.max(Math.abs(p.x) - 300, 0), dy = Math.max(Math.abs(p.y) - 300, 0);
    expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(60);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(600);
  });
});

describe('chooseBaseSite centred on a solar-system pocket (Phase 4)', () => {
  it('searches round the given centre and stays inside its square', () => {
    const ext = { x0: -400, x1: 400, y0: -300, y1: 300 };
    const site = chooseBaseSite(ext, [], [], { halfExtent: 5000, margin: 250, step: 250, seed: 3, centreX: 120_000, centreY: -60_000 })!;
    expect(site).not.toBeNull();
    expect(Math.abs(site.x - 120_000)).toBeLessThanOrEqual(5000);
    expect(Math.abs(site.y + 60_000)).toBeLessThanOrEqual(5000);
  });
});
