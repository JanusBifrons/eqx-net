/**
 * Lock for `SelectionBracket`: THE selection marker (structures follow-up
 * Item B4; RTS Part A: one selection concept, invariant #14).
 *
 *  - one screen-space Graphics for every selected entity (one draw call)
 *  - the same bracket around EVERY selected ship, plus the focus when it is
 *    not one of them; never a second marker for the focus
 *  - resolves live poses from the mirror by id (ship / swarm-N / parked hull)
 *  - the focus anchor (`lastWorldX/Y`) for the details panel; `resolveFocus`
 *    reports false (so the caller clears the focus) when the entity is gone
 *  - a bracket keeps a minimum on-screen size at far zoom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { MIN_HALF_PX, SelectionBracket } from './SelectionBracket.js';

vi.mock('pixi.js', () => {
  class FakeContainer {
    x = 0;
    y = 0;
    visible = true;
    children: unknown[] = [];
    addChild(c: unknown): void { this.children.push(c); }
    destroy(_opts?: unknown): void { /* noop */ }
  }
  class FakeGraphics extends FakeContainer {
    clear = vi.fn().mockReturnThis();
    moveTo = vi.fn().mockReturnThis();
    lineTo = vi.fn().mockReturnThis();
    stroke = vi.fn().mockReturnThis();
    destroy = vi.fn();
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

type FakeGfx = {
  clear: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  visible: boolean;
};

function mirror(over: Partial<RenderMirror>): RenderMirror {
  return { ships: new Map(), swarm: new Map(), localPlayerId: null, ...over } as RenderMirror;
}
function gfxOf(b: SelectionBracket): FakeGfx {
  return (b as unknown as { gfx: FakeGfx }).gfx;
}
/** Identity projection: pixi-world (x, -gameY) in = screen out. */
const project = (wx: number, wy: number, out: { x: number; y: number }): void => { out.x = wx; out.y = wy; };
const ship = (x: number, y: number, extra: Record<string, unknown> = {}) => ({ x, y, angle: 0, vx: 0, vy: 0, kind: 'fighter', ...extra });

describe('SelectionBracket', () => {
  let bracket: SelectionBracket;

  beforeEach(() => {
    bracket = new SelectionBracket({ addChild: vi.fn() } as never);
  });

  it('nothing selected: hidden, nothing drawn', () => {
    bracket.draw(mirror({}), new Set(), null, project, 1);
    expect(gfxOf(bracket).visible).toBe(false);
    expect(bracket.lastMarkerCount).toBe(0);
  });

  it('draws the SAME bracket around every selected ship, in one stroke', () => {
    const m = mirror({ ships: new Map([['a', ship(0, 0)], ['b', ship(100, 50)]]) as never });
    bracket.draw(m, new Set(['a', 'b']), 'a', project, 1);
    const g = gfxOf(bracket);
    expect(g.visible).toBe(true);
    expect(bracket.lastMarkerCount).toBe(2); // the focus (a) is not drawn twice
    expect(g.moveTo).toHaveBeenCalledTimes(8); // 4 corners × 2 ships
    expect(g.stroke).toHaveBeenCalledTimes(1);
  });

  it('a focus outside the ship selection (inspecting a drone) gets the same bracket', () => {
    const sw = { x: 5, y: 7, radius: 50, kind: 1 };
    const m = mirror({ swarm: new Map([[42, sw]]) as never });
    bracket.draw(m, new Set(), 'swarm-42', project, 1);
    expect(bracket.lastMarkerCount).toBe(1);
    expect(bracket.lastMarkerId).toBe('swarm-42');
    expect(bracket.lastMarker).toEqual({ x: 5, y: -7 }); // pixiY = -gameY
  });

  it('skips ids that left the mirror; hides when none resolve', () => {
    bracket.draw(mirror({}), new Set(['gone']), null, project, 1);
    expect(bracket.lastMarkerCount).toBe(0);
    expect(gfxOf(bracket).visible).toBe(false);
  });

  it('keeps a minimum on-screen size at far zoom', () => {
    const m = mirror({ ships: new Map([['a', ship(0, 0)]]) as never });
    bracket.draw(m, new Set(['a']), null, project, 0.01);
    const g = gfxOf(bracket);
    // First corner starts at (x - half, y - half + arm): half = MIN_HALF_PX.
    const [x0] = g.moveTo.mock.calls[0] as [number, number];
    expect(x0).toBeCloseTo(-MIN_HALF_PX);
  });

  it('resolveFocus: a parked hull resolves from the one ship list; the anchor sits above it', () => {
    const m = mirror({ ships: new Map([['hull-1', ship(11, 22, { ownerPlayerId: 'o1', isActive: false })]]) as never });
    expect(bracket.resolveFocus(m, 'hull-1')).toBe(true);
    expect(bracket.lastWorldX).toBe(11);
    expect(bracket.lastWorldY!).toBeLessThan(-22);
  });

  it('resolveFocus: false + no anchor when the focus is gone or null', () => {
    const m = mirror({ ships: new Map([['p1', ship(0, 0)]]) as never });
    expect(bracket.resolveFocus(m, 'p1')).toBe(true);
    expect(bracket.resolveFocus(mirror({}), 'p1')).toBe(false);
    expect(bracket.lastWorldX).toBeNull();
    expect(bracket.resolveFocus(m, null)).toBe(false);
    expect(bracket.lastWorldY).toBeNull();
  });

  // Phone bug: a selected Shipyard (960x600 footprint, 567 u bounding radius)
  // got a radius SQUARE: as wide as the yard but nearly twice as tall. The
  // bracket must hug the structure's (quarter-turn) footprint box, as the pick does.
  describe('structures: the bracket hugs the footprint box, not the bounding radius', () => {
    const yard = (angle: number) => ({ x: -1488, y: -405, radius: 567, kind: 2, shipKind: 'shipyard', angle });
    function drawnBox(b: SelectionBracket): { x0: number; x1: number; y0: number; y1: number } {
      const g = gfxOf(b);
      const pts = [...g.moveTo.mock.calls, ...g.lineTo.mock.calls] as [number, number][];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }

    it('a Shipyard at default rotation: wide box, 960 x 600 plus the pad', () => {
      const m = mirror({ swarm: new Map([[7, yard(0)]]) as never });
      bracket.draw(m, new Set(), 'swarm-7', project, 1);
      const box = drawnBox(bracket);
      expect(box.x1 - box.x0).toBeCloseTo(960 + 16);
      expect(box.y1 - box.y0).toBeCloseTo(600 + 16);
      expect((box.x0 + box.x1) / 2).toBeCloseTo(-1488);
      expect((box.y0 + box.y1) / 2).toBeCloseTo(405); // pixiY = -gameY
    });

    it('a quarter-turned Shipyard: the box swaps axes', () => {
      const m = mirror({ swarm: new Map([[7, yard(Math.PI / 2)]]) as never });
      bracket.draw(m, new Set(), 'swarm-7', project, 1);
      const box = drawnBox(bracket);
      expect(box.x1 - box.x0).toBeCloseTo(600 + 16);
      expect(box.y1 - box.y0).toBeCloseTo(960 + 16);
    });

    it('resolveFocus: the panel anchor sits on the footprint top, not the radius', () => {
      const m = mirror({ swarm: new Map([[7, yard(0)]]) as never });
      expect(bracket.resolveFocus(m, 'swarm-7')).toBe(true);
      expect(bracket.lastWorldHalf).toBeCloseTo(300 + 8);
      expect(bracket.lastWorldY).toBeCloseTo(405 - 308);
    });
  });
});
