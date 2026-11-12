/**
 * Owner decision 2026-11-12: "Add bow features to the hull generator for
 * every capital: anchor gear, breakwater, deck fittings, a forward
 * fire-control top. Every view of every capital improves." A close-up clip
 * showed the battleship's bow as a plain grey wedge with a few hairline
 * plating bands: the generator put every part amidships and the forge only
 * plated the bow.
 *
 * Locks, for every capital kind (each class, styles A/B/C):
 *  - the forge's plan carries anchor gear, a breakwater, deck fittings and
 *    plating seams (and a director where the gap before the bridge holds one);
 *  - bow fittings sit forward of turret A's keep-out and inside the hull;
 *  - nothing touches a turret ring or a gunhouse's swept circle;
 *  - the plan is the same every time (seeded by kind id);
 *  - the forge stamps the plan into the hull's height field.
 */
import { describe, it, expect } from 'vitest';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { CAPITAL_STYLE_VARIANTS } from '../../../shared-types/shipKinds/capitals/index.js';
import { forgeShip, shipParts } from './fields.js';
import { insidePoly } from './raster.js';
import { distToFeature, featureOutline, halfWidthAt, planBowFeatures, type BowFeatureKind } from './bowDetail.js';

const CAPITALS = Object.values(CAPITAL_STYLE_VARIANTS).flat();
const plan = (id: string) => planBowFeatures(id, shipParts(getShipKind(id)));
const has = (kinds: readonly BowFeatureKind[], k: BowFeatureKind): boolean => kinds.includes(k);

describe('capital bow detail', () => {
  it('covers all fifteen capital kinds', () => {
    expect(CAPITALS).toHaveLength(15);
  });

  it.each(CAPITALS)('%s: anchor gear, breakwater, fittings and seams', (id) => {
    const kinds = plan(id).features.map((f) => f.kind);
    for (const k of ['hawse', 'anchor', 'chain', 'windlass', 'wildcat', 'breakwater', 'bollard', 'fairlead', 'ventilator', 'hatch', 'jackstaff', 'seam'] as const) {
      expect(has(kinds, k), `${id} lacks ${k}`).toBe(true);
    }
    // Mirrored gear comes in pairs.
    for (const k of ['hawse', 'anchor', 'chain', 'breakwater'] as const) expect(kinds.filter((x) => x === k).length, k).toBe(2);
  });

  it.each(CAPITALS)('%s: a forward director ahead of the bridge', (id) => {
    const p = plan(id);
    const tiers = shipParts(getShipKind(id)).filter((q) => q.role === 'superstructure')
      .map((q) => ({ pts: q.pts, front: Math.min(...q.pts.map(([, y]) => y)) }))
      .sort((a, c) => a.front - c.front);
    const nextFront = tiers.find((t) => t.front > tiers[0]!.front + 1)!.front;
    const dir = p.features.filter((f) => f.kind === 'director' || f.kind === 'rangefinder');
    expect(dir.map((f) => f.kind).sort()).toEqual(['director', 'rangefinder']);
    for (const d of dir) {
      expect(d.y).toBeGreaterThan(p.bowEndY);
      const pts = featureOutline(d);
      // On open deck before the bridge face, or on the bridge's forward step
      // (inside the lowest tier, ahead of the next tier up).
      const onDeck = pts.every(([, y]) => y < tiers[0]!.front);
      const onStep = pts.every(([x, y]) => insidePoly(tiers[0]!.pts, x, y) && y < nextFront);
      expect(onDeck || onStep, `${d.kind} at ${d.y.toFixed(0)}`).toBe(true);
    }
  });

  it.each(CAPITALS)('%s: bow fittings sit forward of turret A, inside the hull', (id) => {
    const p = plan(id);
    const hull = shipParts(getShipKind(id)).find((q) => q.role === 'hull')!.pts;
    for (const f of p.features) {
      for (const [x, y] of featureOutline(f)) {
        expect(Math.abs(x), `${f.kind} at ${f.x.toFixed(0)},${f.y.toFixed(0)} leaves the hull`).toBeLessThanOrEqual(halfWidthAt(hull, y));
        if (f.kind !== 'director' && f.kind !== 'rangefinder') {
          expect(y, `${f.kind} aft of the bow`).toBeLessThanOrEqual(p.bowEndY);
          expect(y).toBeGreaterThanOrEqual(p.stemY);
        }
      }
    }
  });

  it.each(CAPITALS)('%s: nothing over a turret ring or under a gunhouse', (id) => {
    const p = plan(id);
    expect(p.keepOuts.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of p.features) for (const k of p.keepOuts) if (distToFeature(f, k.x, k.y) < k.r) hits.push(`${f.kind}@${f.x.toFixed(0)},${f.y.toFixed(0)} × ${k.id}`);
    expect(hits).toEqual([]);
  });

  it.each(CAPITALS)('%s: deterministic', (id) => {
    expect(plan(id)).toEqual(plan(id));
  });

  it('non-capital kinds get no bow plan', () => {
    expect(plan('fighter').features).toEqual([]);
  });

  it.each(['battleship', 'heavy-cruiser'])('%s: the forge stamps the plan into the hull', (id) => {
    const ppu = 0.25;
    const f = forgeShip(id, { ppu });
    expect(f.bow).toEqual(plan(id).features);
    // Raised fittings stand above the plain plating beside them.
    const g = f.g;
    const at = (x: number, y: number): number => f.height[Math.round(y * g.ppu + g.oy) * g.w + Math.round(x * g.ppu + g.ox)]!;
    const wl = f.bow!.find((q) => q.kind === 'windlass')!;
    expect(at(wl.x, wl.y)).toBeGreaterThan(at(wl.x + wl.hw * 3, wl.y) + p0(wl.hh));
  });
});

/** A small floor on the windlass's rise (world units). */
function p0(hh: number): number { return hh * 0.2; }
