/**
 * Lock for FleetOverlay order lines (RTS slice 15a): for SELECTED ships only,
 * a line to the move destination, to the attack target's CURRENT pose
 * (resolved from the mirror), to the escorted ship, and the patrol loop; one
 * stroke per colour on the single Graphics; capped at MAX_ORDER_SEGMENTS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FleetOverlayShip, RenderMirror } from '@core/contracts/IRenderer';
import { FleetOverlay, MAX_ORDER_SEGMENTS, resolveEntityPos, type OrderFlash } from './FleetOverlay.js';

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
type G = { visible: boolean; moveTo: Fn; lineTo: Fn; stroke: Fn; circle: Fn };
const gfxOf = (o: FleetOverlay): G => (o as unknown as { gfx: G }).gfx;

const m = {
  localPlayerId: 'me',
  ships: new Map([['me', { x: 10, y: 20, angle: 0 }], ['enemy', { x: 300, y: 40, angle: 0 }]]),
  lingeringShips: new Map([['hull-1', { x: -5, y: 5, angle: 0, ownerPlayerId: 'me' }]]),
  swarm: new Map([[42, { x: 7, y: -9 }]]),
} as unknown as RenderMirror;

const identity = (x: number, y: number, out: { x: number; y: number }): void => { out.x = x; out.y = y; };
const noFlash = (): OrderFlash => ({ x: 0, y: 0, attack: false, t0: -1 });
const orders = (...ships: FleetOverlayShip[]): Map<string, FleetOverlayShip> => new Map(ships.map((s) => [s.id, s]));
const base = (id: string): FleetOverlayShip => ({ id, squadId: null, orderKind: null });

describe('resolveEntityPos', () => {
  const out = { x: 0, y: 0 };
  it('resolves ships, lingering hulls and swarm-<n> ids', () => {
    expect(resolveEntityPos(m, 'enemy', out)).toBe(true);
    expect(out).toEqual({ x: 300, y: 40 });
    expect(resolveEntityPos(m, 'hull-1', out)).toBe(true);
    expect(out).toEqual({ x: -5, y: 5 });
    expect(resolveEntityPos(m, 'swarm-42', out)).toBe(true);
    expect(out).toEqual({ x: 7, y: -9 });
  });
  it('is false for unknown or malformed ids', () => {
    expect(resolveEntityPos(m, 'nobody', out)).toBe(false);
    expect(resolveEntityPos(m, 'swarm-9', out)).toBe(false);
    expect(resolveEntityPos(m, 'swarm-4x', out)).toBe(false);
  });
});

describe('FleetOverlay order lines', () => {
  let ov: FleetOverlay;
  beforeEach(() => {
    ov = new FleetOverlay({ addChild: vi.fn() } as never);
  });
  const run = (sel: string[], o: Map<string, FleetOverlayShip> | null): G => {
    ov.update(m, new Set(sel), null, noFlash(), 1000, identity, 1, null, o);
    return gfxOf(ov);
  };

  it('draws a move line from the ship to its destination (pixi y-down) plus a dest dot', () => {
    const g = run(['me'], orders({ ...base('me'), orderKind: 'move', destX: 100, destY: 50 }));
    expect(g.moveTo).toHaveBeenCalledWith(10, -20);
    expect(g.lineTo).toHaveBeenCalledWith(100, -50);
    expect(g.circle).toHaveBeenCalledWith(100, -50, expect.any(Number));
    expect(ov.lastOrderSegments).toBe(2);
  });

  it("draws an attack line to the target's CURRENT mirror pose, stroked red", () => {
    const g = run(['hull-1'], orders({ ...base('hull-1'), orderKind: 'attack', targetId: 'enemy' }));
    expect(g.moveTo).toHaveBeenCalledWith(-5, -5);
    expect(g.lineTo).toHaveBeenCalledWith(300, -40);
    const colors = g.stroke.mock.calls.map((c) => (c[0] as { color: number }).color);
    expect(colors).toContain(0xff5a4a);
    expect(ov.lastOrderSegments).toBe(1);
  });

  it('skips an attack line whose target is not in the mirror', () => {
    run(['me'], orders({ ...base('me'), orderKind: 'attack', targetId: 'gone' }));
    expect(ov.lastOrderSegments).toBe(0);
  });

  it('draws the patrol route as a closed loop', () => {
    const route: [number, number][] = [[0, 0], [100, 0], [100, 100]];
    const g = run(['me'], orders({ ...base('me'), route }));
    expect(g.moveTo).toHaveBeenCalledWith(100, -100); // starts at the last waypoint
    expect(g.lineTo.mock.calls).toEqual([[0, -0], [100, -0], [100, -100]]);
    expect(ov.lastOrderSegments).toBe(3);
  });

  it('draws an escort line to the escorted ship', () => {
    const g = run(['hull-1'], orders({ ...base('hull-1'), escortId: 'me' }));
    expect(g.lineTo).toHaveBeenCalledWith(10, -20);
    expect(ov.lastOrderSegments).toBe(1);
  });

  it('draws nothing for ships that are not selected', () => {
    const g = run(['hull-1'], orders({ ...base('me'), orderKind: 'move', destX: 1, destY: 1 }));
    expect(g.lineTo).not.toHaveBeenCalled();
    expect(ov.lastOrderSegments).toBe(0);
  });

  it('uses one stroke per colour beyond the ring stroke', () => {
    const g = run(['me', 'hull-1'], orders(
      { ...base('me'), orderKind: 'move', destX: 100, destY: 50 },
      { ...base('hull-1'), orderKind: 'attack', targetId: 'swarm-42' },
    ));
    // rings + friendly lines + attack lines
    expect(g.stroke).toHaveBeenCalledTimes(3);
  });

  it('caps total segments at MAX_ORDER_SEGMENTS', () => {
    const route: [number, number][] = [];
    for (let i = 0; i < MAX_ORDER_SEGMENTS * 2; i++) route.push([i, i]);
    const g = run(['me', 'hull-1'], orders({ ...base('me'), route }, { ...base('hull-1'), route }));
    expect(ov.lastOrderSegments).toBe(MAX_ORDER_SEGMENTS);
    expect(g.lineTo).toHaveBeenCalledTimes(MAX_ORDER_SEGMENTS);
  });

  it('no orders model draws only rings (back-compat)', () => {
    const g = run(['me'], null);
    expect(g.lineTo).not.toHaveBeenCalled();
    expect(ov.lastRingCount).toBe(1);
  });
});
