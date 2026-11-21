/** Warp-to destinations (wrap-up plan W1a; warp route check S3). */
import { describe, expect, it } from 'vitest';
import { sectorSites, isWarpDropPoint, warpDropPoint } from '../../core/galaxy/sectorSites';
import { warpStopMargin, WARP_MIN_DISTANCE } from '../../core/galaxy/warpTarget';
import type { CoarseFieldMap } from '../../core/nav/coarseField';
import type { WarpStructureFootprint, WarpStructureSource } from '../../core/nav/warpLineStop';
import { getShipKind } from '../../shared-types/shipKinds';
import { formatKm, WARP_FAR_KM, warpDestinations, warpStateLabel, type WarpRouteInputs } from './warpDestinations';

describe('warpDestinations', () => {
  it('lists every pocket, nearest first, with drop points the server accepts', () => {
    const sites = sectorSites('sol-prime');
    const d = warpDestinations('sol-prime', 0, 0);
    expect(d).toHaveLength(sites.length);
    for (let i = 1; i < d.length; i++) expect(d[i]!.distKm).toBeGreaterThanOrEqual(d[i - 1]!.distKm);
    // (The pocket the ship is in has no rim to drop at; it can't be picked.)
    for (const x of d) if (!x.here) expect(isWarpDropPoint('sol-prime', x.dropX, x.dropY, true)).toBe(true);
  });

  it('marks the pocket the ship is in, names gates by their system, groups far ones', () => {
    const d = warpDestinations('sol-prime', 0, 0);
    const home = d.find((x) => x.kind === 'home')!;
    expect(home.here).toBe(true);
    expect(home.distKm).toBe(0);
    const gate = d.find((x) => x.kind === 'gate');
    if (gate) expect(gate.label).toMatch(/ gate$/);
    for (const x of d) expect(x.far).toBe(x.distKm > WARP_FAR_KM);
  });

  it('formats distances', () => {
    expect(formatKm(0.4)).toBe('<1 km');
    expect(formatKm(52.6)).toBe('53 km');
  });
});

/** Array-backed structure source. */
class Boxes implements WarpStructureSource {
  constructor(private readonly list: WarpStructureFootprint[]) {}
  get count(): number { return this.list.length; }
  footprint(i: number, out: WarpStructureFootprint): void { Object.assign(out, this.list[i]!); }
}
const box = (x: number, y: number, half: number): WarpStructureFootprint => ({ x, y, halfW: half, halfH: half, boxes: undefined });
/** A field whose rock body is the square of half-size `half` round (cx, cy). */
const rockAt = (cx: number, cy: number, half: number): CoarseFieldMap =>
  ({ solidRadius: 1e9, solidAt: (x: number, y: number) => Math.abs(x - cx) <= half && Math.abs(y - cy) <= half }) as unknown as CoarseFieldMap;

describe('warpDestinations: warp targets (route check S3)', () => {
  const KEY = 'sol-prime';
  const home = sectorSites(KEY).find((s) => s.kind === 'home')!;
  // The ship 40 km east of the home pocket's rim; home's rim point faces it.
  const P = { x: home.x + home.r + 40_000, y: home.y };
  const R = warpDropPoint(home, P.x, P.y);
  const mid = { x: (P.x + R.x) / 2, y: (P.y + R.y) / 2 };
  const margin = warpStopMargin(getShipKind('fighter'));
  const homeOf = (route: WarpRouteInputs | null) => warpDestinations(KEY, P.x, P.y, route).find((d) => d.id === 'home')!;

  it('a clear line targets the drop point', () => {
    const d = homeOf({ field: null, structures: new Boxes([]), margin });
    expect(d.state).toBe('clear');
    expect(d.blocker).toBeNull();
    expect(d.reachable).toBe(true);
    expect(d.targetX).toBe(d.dropX);
    expect(d.targetY).toBe(d.dropY);
    expect(warpStateLabel(d)).toBeNull();
  });

  it('a structure in the way: the near side is the destination, its distance is shown', () => {
    const d = homeOf({ field: null, structures: new Boxes([box(mid.x, mid.y, 500)]), margin });
    expect(d.state).toBe('near');
    expect(d.blocker).toBe('structure');
    expect(d.reachable).toBe(true);
    expect(d.targetX).toBeCloseTo(mid.x + 500 + margin, 3);
    expect(d.distKm).toBeCloseTo(Math.hypot(d.targetX - P.x, d.targetY - P.y) / 1000, 6);
    expect(warpStateLabel(d)).toBe('near side · structure in the way');
  });

  it('the asteroid field in the way names the field', () => {
    const d = homeOf({ field: rockAt(mid.x, mid.y, 2000), structures: new Boxes([]), margin });
    expect(d.state).toBe('near');
    expect(d.blocker).toBe('field');
    expect(d.targetX).toBeGreaterThan(mid.x + 2000);
    expect(warpStateLabel(d)).toBe('near side · asteroid field in the way');
  });

  it('whichever comes first names the reason', () => {
    const structFirst = homeOf({ field: rockAt(mid.x, mid.y, 2000), structures: new Boxes([box(mid.x + 8000, mid.y, 500)]), margin });
    expect(structFirst.blocker).toBe('structure');
    const fieldFirst = homeOf({ field: rockAt(mid.x, mid.y, 2000), structures: new Boxes([box(mid.x - 8000, mid.y, 500)]), margin });
    expect(fieldFirst.blocker).toBe('field');
  });

  it('a near side too close stays listed, greyed with the reason', () => {
    const d = homeOf({ field: null, structures: new Boxes([box(P.x - WARP_MIN_DISTANCE / 2 - margin, P.y, 100)]), margin });
    expect(d.state).toBe('blocked');
    expect(d.reachable).toBe(false);
    expect(warpStateLabel(d)).toBe("can't warp there · too close");
    expect(warpDestinations(KEY, P.x, P.y).length).toBe(sectorSites(KEY).length);
  });

  it('reuses the list and its records between recomputes', () => {
    const out = warpDestinations(KEY, P.x, P.y, null, []);
    const first = out.slice();
    const again = warpDestinations(KEY, P.x + 10, P.y, null, out);
    expect(again).toBe(out);
    for (const r of again) expect(first).toContain(r);
  });
});
