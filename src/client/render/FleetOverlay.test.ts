/**
 * Lock for `FleetOverlay` (RTS slice 13a): ONE Graphics for the whole overlay
 * (draw-call budget), the drag box, a fading order flash, the hold cue, and
 * hidden when there is nothing to draw. Selected ships are marked by
 * `SelectionBracket`, never here (RTS Part A: one selection, one marker).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { FleetOverlay, HOLD_RING_MS, ORDER_FLASH_MS, type OrderFlash } from './FleetOverlay.js';

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
  ships: new Map([['me', { x: 10, y: 20, angle: 0 }], ['hull-1', { x: -5, y: 5, angle: 0, ownerPlayerId: 'me', isActive: false }]]),
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
    ov.update(m, new Set(), null, noFlash(), 1000, identity);
    expect(gfxOf(ov).visible).toBe(false);
  });

  it('draws no ship marker of its own: selected ships alone leave it hidden (RTS Part A, one marker = SelectionBracket)', () => {
    ov.update(m, new Set(['me', 'hull-1']), null, noFlash(), 1000, identity);
    const g = gfxOf(ov);
    expect(g.visible).toBe(false);
    expect(g.circle).not.toHaveBeenCalled();
  });

  it('draws the drag box in screen space', () => {
    ov.update(m, new Set(), { x0: 50, y0: 40, x1: 10, y1: 100 }, noFlash(), 1000, identity);
    const g = gfxOf(ov);
    expect(g.visible).toBe(true);
    expect(g.rect).toHaveBeenCalledWith(10, 40, 40, 60);
  });

  it('shows the order flash for ORDER_FLASH_MS, then hides', () => {
    const flash: OrderFlash = { x: 3, y: 4, attack: true, t0: 1000 };
    ov.update(m, new Set(), null, flash, 1000 + ORDER_FLASH_MS / 2, identity);
    expect(gfxOf(ov).visible).toBe(true);
    expect(gfxOf(ov).circle.mock.calls[0]!.slice(0, 2)).toEqual([3, -4]);
    ov.update(m, new Set(), null, flash, 1000 + ORDER_FLASH_MS + 1, identity);
    expect(gfxOf(ov).visible).toBe(false);
  });

  it('clears and redraws every frame while visible (single Graphics)', () => {
    const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
    ov.update(m, new Set(), box, noFlash(), 1000, identity);
    ov.update(m, new Set(), box, noFlash(), 1016, identity);
    expect(gfxOf(ov).clear).toHaveBeenCalledTimes(2);
  });

  it('draws the hold-to-box cue as an expanding ring at the finger, with nothing else on', () => {
    ov.update(m, new Set(), null, noFlash(), 1000, identity, { x: 70, y: 80, armedMs: 0 });
    const g = gfxOf(ov);
    expect(g.visible).toBe(true);
    expect(ov.lastHoldCue).toBe(true);
    const r0 = g.circle.mock.calls[0]![2] as number;
    expect(g.circle.mock.calls[0]!.slice(0, 2)).toEqual([70, 80]);
    ov.update(m, new Set(), null, noFlash(), 1100, identity, { x: 70, y: 80, armedMs: HOLD_RING_MS });
    const r1 = g.circle.mock.calls[1]![2] as number;
    expect(r1).toBeGreaterThan(r0);
    // capped once fully grown
    ov.update(m, new Set(), null, noFlash(), 1200, identity, { x: 70, y: 80, armedMs: HOLD_RING_MS * 5 });
    expect(g.circle.mock.calls[2]![2]).toBe(r1);
    ov.update(m, new Set(), null, noFlash(), 1300, identity, null);
    expect(g.visible).toBe(false);
    expect(ov.lastHoldCue).toBe(false);
  });
});
