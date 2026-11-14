/**
 * Lock for `FleetOverlay` (RTS slice 13a): ONE Graphics for the whole overlay
 * (draw-call budget), rings per selected own ship, the drag box, a fading
 * order flash, and hidden when there is nothing to draw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { FleetOverlay, ORDER_FLASH_MS, type OrderFlash } from './FleetOverlay.js';

vi.mock('pixi.js', () => {
  class FakeGraphics {
    visible = true;
    clear = vi.fn().mockReturnThis();
    circle = vi.fn().mockReturnThis();
    rect = vi.fn().mockReturnThis();
    fill = vi.fn().mockReturnThis();
    stroke = vi.fn().mockReturnThis();
    destroy = vi.fn();
  }
  class FakeContainer {
    children: unknown[] = [];
    addChild(c: unknown): void { this.children.push(c); }
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

type G = { visible: boolean; clear: ReturnType<typeof vi.fn>; circle: ReturnType<typeof vi.fn>; rect: ReturnType<typeof vi.fn> };
const gfxOf = (o: FleetOverlay): G => (o as unknown as { gfx: G }).gfx;

const m = {
  localPlayerId: 'me',
  ships: new Map([['me', { x: 10, y: 20, angle: 0 }]]),
  lingeringShips: new Map([['hull-1', { x: -5, y: 5, angle: 0, ownerPlayerId: 'me' }]]),
} as unknown as RenderMirror;

const identity = (x: number, y: number, out: { x: number; y: number }): void => { out.x = x; out.y = y; };
const noFlash = (): OrderFlash => ({ x: 0, y: 0, attack: false, t0: -1 });

describe('FleetOverlay', () => {
  let parent: { addChild: ReturnType<typeof vi.fn> };
  let ov: FleetOverlay;

  beforeEach(() => {
    parent = { addChild: vi.fn() };
    ov = new FleetOverlay(parent as never);
  });

  it('adds exactly one Graphics to its parent', () => {
    expect(parent.addChild).toHaveBeenCalledTimes(1);
  });

  it('is hidden with nothing selected, no box and no flash', () => {
    ov.update(m, new Set(), null, noFlash(), 1000, identity, 1);
    expect(gfxOf(ov).visible).toBe(false);
  });

  it('draws one ring per resolvable selected ship at its projected (pixi y-down) pose', () => {
    ov.update(m, new Set(['me', 'hull-1', 'gone']), null, noFlash(), 1000, identity, 1);
    const g = gfxOf(ov);
    expect(g.visible).toBe(true);
    expect(ov.lastRingCount).toBe(2);
    expect(g.circle.mock.calls[0]!.slice(0, 2)).toEqual([10, -20]);
    expect(g.circle.mock.calls[1]!.slice(0, 2)).toEqual([-5, -5]);
  });

  it('draws the drag box in screen space', () => {
    ov.update(m, new Set(), { x0: 50, y0: 40, x1: 10, y1: 100 }, noFlash(), 1000, identity, 1);
    const g = gfxOf(ov);
    expect(g.visible).toBe(true);
    expect(g.rect).toHaveBeenCalledWith(10, 40, 40, 60);
  });

  it('shows the order flash for ORDER_FLASH_MS, then hides', () => {
    const flash: OrderFlash = { x: 3, y: 4, attack: true, t0: 1000 };
    ov.update(m, new Set(), null, flash, 1000 + ORDER_FLASH_MS / 2, identity, 1);
    expect(gfxOf(ov).visible).toBe(true);
    expect(gfxOf(ov).circle.mock.calls[0]!.slice(0, 2)).toEqual([3, -4]);
    ov.update(m, new Set(), null, flash, 1000 + ORDER_FLASH_MS + 1, identity, 1);
    expect(gfxOf(ov).visible).toBe(false);
  });

  it('clears and redraws every frame while visible (single Graphics)', () => {
    const sel = new Set(['me']);
    ov.update(m, sel, null, noFlash(), 1000, identity, 1);
    ov.update(m, sel, null, noFlash(), 1016, identity, 1);
    expect(gfxOf(ov).clear).toHaveBeenCalledTimes(2);
  });
});
