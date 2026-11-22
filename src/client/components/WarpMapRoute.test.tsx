/**
 * The picked warp's route on the system map (warp route check, map landing
 * ring): a near-side pick draws a solid line to the landing point, a landing
 * ring there and the rest of the line to the pocket dashed (blocked); a clear
 * pick draws the dashed line with no landing ring. The record is the one the
 * Go button sends (`warpDestinations` with a structure on the line).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { sectorSites, warpDropPoint } from '../../core/galaxy/sectorSites';
import { warpStopMargin } from '../../core/galaxy/warpTarget';
import type { WarpStructureFootprint, WarpStructureSource } from '../../core/nav/warpLineStop';
import { getShipKind } from '../../shared-types/shipKinds';
import { SOLAR_HALF_EXTENT } from '../../core/galaxy/sectorSites';
import { warpDestinations } from './warpDestinations';
import { WarpMapRoute } from './WarpMapRoute';

class Boxes implements WarpStructureSource {
  constructor(private readonly list: WarpStructureFootprint[]) {}
  get count(): number { return this.list.length; }
  footprint(i: number, out: WarpStructureFootprint): void { Object.assign(out, this.list[i]!); }
}

const KEY = 'sol-prime';
const home = sectorSites(KEY).find((s) => s.kind === 'home')!;
const P = { x: home.x + home.r + 40_000, y: home.y };
const R = warpDropPoint(home, P.x, P.y);
const mid = { x: (P.x + R.x) / 2, y: (P.y + R.y) / 2 };
const margin = warpStopMargin(getShipKind('fighter'));
const homeWith = (list: WarpStructureFootprint[]) =>
  warpDestinations(KEY, P.x, P.y, { field: null, structures: new Boxes(list), margin }).find((d) => d.id === 'home')!;
const draw = (sel: ReturnType<typeof homeWith>) =>
  render(<svg><WarpMapRoute sel={sel} shipX={P.x} shipY={P.y} h={SOLAR_HALF_EXTENT} /></svg>);
const num = (el: Element, a: string): number => Number(el.getAttribute(a));

describe('WarpMapRoute', () => {
  it('near side: solid line to the landing point, a ring there, the rest dashed and dimmed', () => {
    const d = homeWith([{ x: mid.x, y: mid.y, halfW: 500, halfH: 500, boxes: undefined }]);
    expect(d.state).toBe('near');
    draw(d);
    const ring = screen.getByTestId('warp-map-landing').querySelector('circle')!;
    expect(num(ring, 'cx')).toBeCloseTo(d.targetX);
    expect(num(ring, 'cy')).toBeCloseTo(-d.targetY);
    const solid = screen.getByTestId('warp-map-solid');
    expect(solid.getAttribute('stroke-dasharray')).toBeNull();
    expect(num(solid, 'x1')).toBe(P.x);
    expect(num(solid, 'x2')).toBeCloseTo(d.targetX);
    expect(num(solid, 'y2')).toBeCloseTo(-d.targetY);
    const blocked = screen.getByTestId('warp-map-blocked');
    expect(blocked.getAttribute('stroke-dasharray')).not.toBeNull();
    expect(num(blocked, 'opacity')).toBeLessThan(1);
    expect(num(blocked, 'x1')).toBeCloseTo(d.targetX);
    expect(num(blocked, 'x2')).toBeCloseTo(d.dropX);
    expect(num(blocked, 'y2')).toBeCloseTo(-d.dropY);
  });

  it('clear: the dashed line to the drop point, no landing ring, no blocked segment', () => {
    const d = homeWith([]);
    expect(d.state).toBe('clear');
    draw(d);
    expect(screen.queryByTestId('warp-map-landing')).toBeNull();
    expect(screen.queryByTestId('warp-map-blocked')).toBeNull();
    const line = screen.getByTestId('warp-map-line').querySelector('line')!;
    expect(line.getAttribute('stroke-dasharray')).not.toBeNull();
    expect(num(line, 'x2')).toBeCloseTo(d.dropX);
  });
});
