/**
 * Lock for the patrol pick preview (RTS slice 14b): with nothing selected it
 * still draws on the ONE Graphics, a closed loop through the picked points
 * (projected with the y flip), a dot per point and line-drawn numbers (no
 * Text objects).
 */
import { describe, it, expect, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { FleetOverlay, type OrderFlash } from './FleetOverlay.js';
import { createFleetPickState, pickAddPoint, pickStart } from './input/fleetPick.js';

vi.mock('pixi.js', () => {
  class FakeGraphics {
    visible = true;
    clear = vi.fn().mockReturnThis();
    circle = vi.fn().mockReturnThis();
    rect = vi.fn().mockReturnThis();
    fill = vi.fn().mockReturnThis();
    stroke = vi.fn().mockReturnThis();
    moveTo = vi.fn().mockReturnThis();
    lineTo = vi.fn().mockReturnThis();
    destroy = vi.fn();
  }
  class FakeContainer {
    addChild(): void { /* noop */ }
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

type Fn = ReturnType<typeof vi.fn>;
type G = { visible: boolean; moveTo: Fn; lineTo: Fn; stroke: Fn; circle: Fn; fill: Fn };
const gfxOf = (o: FleetOverlay): G => (o as unknown as { gfx: G }).gfx;

const m = { localPlayerId: 'me', ships: new Map() } as unknown as RenderMirror;
const identity = (x: number, y: number, out: { x: number; y: number }): void => { out.x = x; out.y = y; };
const noFlash = (): OrderFlash => ({ x: 0, y: 0, attack: false, t0: -1 });

function run(o: FleetOverlay, pick: ReturnType<typeof createFleetPickState> | null): void {
  o.update(m, new Set(), null, noFlash(), 0, identity, 1, null, null, pick);
}

describe('FleetOverlay — patrol pick preview', () => {
  it('draws the closed route, a dot and a number per point', () => {
    const o = new FleetOverlay({ addChild: () => {} } as never);
    const g = gfxOf(o);
    const pick = createFleetPickState();
    pickStart(pick, 'patrol');
    pickAddPoint(pick, 10, 20);
    pickAddPoint(pick, 100, -40);
    pickAddPoint(pick, 50, 60);
    run(o, pick);
    expect(g.visible).toBe(true);
    expect(o.lastPickPoints).toBe(3);
    // Loop starts at the LAST point (pixi y = -game y), then visits all three.
    expect(g.moveTo).toHaveBeenCalledWith(50, -60);
    expect(g.lineTo).toHaveBeenCalledWith(10, -20);
    expect(g.lineTo).toHaveBeenCalledWith(100, 40);
    expect(g.lineTo).toHaveBeenCalledWith(50, -60);
    // One dot per point.
    const dots = g.circle.mock.calls.filter((c) => c[2] === 4);
    expect(dots.map((c) => [c[0], c[1]])).toEqual([[10, -20], [100, 40], [50, -60]]);
    // Route stroke + dots fill + numbers stroke.
    expect(g.stroke).toHaveBeenCalledTimes(2);
    expect(g.fill).toHaveBeenCalledTimes(1);
  });

  it('a single point draws a dot (no loop); a two-digit number draws both digits', () => {
    const o = new FleetOverlay({ addChild: () => {} } as never);
    const g = gfxOf(o);
    const pick = createFleetPickState();
    pickStart(pick, 'patrol');
    pickAddPoint(pick, 0, 0);
    run(o, pick);
    expect(g.circle).toHaveBeenCalledTimes(1);
    expect(g.stroke).toHaveBeenCalledTimes(1); // the number only
    for (let i = 0; i < 11; i++) pickAddPoint(pick, i * 50, 0);
    g.moveTo.mockClear();
    run(o, pick);
    expect(o.lastPickPoints).toBe(12);
    // "8" is all 7 segments; "12" is 2 + 5 = 7 segments; the loop adds 1 moveTo.
    expect(g.moveTo.mock.calls.length).toBeGreaterThan(12 * 2);
  });

  it('hidden when no pick, an escort pick, or an empty route', () => {
    const o = new FleetOverlay({ addChild: () => {} } as never);
    const g = gfxOf(o);
    run(o, null);
    expect(g.visible).toBe(false);
    const pick = createFleetPickState();
    pickStart(pick, 'patrol');
    run(o, pick);
    expect(g.visible).toBe(false);
    pickStart(pick, 'escort');
    run(o, pick);
    expect(g.visible).toBe(false);
    expect(o.lastPickPoints).toBe(0);
  });
});
