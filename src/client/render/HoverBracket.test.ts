/**
 * Lock for `HoverBracket` (WS-10 / R2.4) — the lighter sibling of
 * `SelectionBracket` drawn around the desktop-hovered entity.
 *
 * Mirrors `SelectionBracket.test.ts`: single pooled Graphics + dirty-flag
 * discipline (invariant #14), pose resolution by id (ship / swarm-N /
 * lingering), hide + report-not-present when the entity is null or gone. This is
 * cheap insurance for the bracket's own behaviour; the pointer→pick→bracket
 * WIRING is locked by the `hover-outline.spec.ts` E2E (the seam the bug lives at).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { HoverBracket } from './HoverBracket.js';

vi.mock('pixi.js', () => {
  class FakeContainer {
    x = 0;
    y = 0;
    visible = true;
    children: unknown[] = [];
    addChild(c: unknown): void { this.children.push(c); }
    removeChild(c: unknown): void {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
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

function mirror(over: Partial<RenderMirror>): RenderMirror {
  return { ships: new Map(), swarm: new Map(), localPlayerId: null, ...over } as RenderMirror;
}

function gfxOf(b: HoverBracket): { clear: ReturnType<typeof vi.fn>; x: number; y: number; visible: boolean } {
  return (b as unknown as { gfx: { clear: ReturnType<typeof vi.fn>; x: number; y: number; visible: boolean } }).gfx;
}

describe('HoverBracket', () => {
  let parent: { addChild: ReturnType<typeof vi.fn> };
  let bracket: HoverBracket;

  beforeEach(() => {
    parent = { addChild: vi.fn() };
    bracket = new HoverBracket(parent as never);
  });

  it('null id hides the outline and reports not-present', () => {
    expect(bracket.update(mirror({}), null)).toBe(false);
    expect(gfxOf(bracket).visible).toBe(false);
  });

  it('resolves a ship pose (pixiY = -gameY) and reports present', () => {
    const m = mirror({ ships: new Map([['p1', { x: 100, y: 200, angle: 0, vx: 0, vy: 0, kind: 'fighter' }]]) as never });
    expect(bracket.update(m, 'p1')).toBe(true);
    const g = gfxOf(bracket);
    expect(g.visible).toBe(true);
    expect(g.x).toBe(100);
    expect(g.y).toBe(-200);
  });

  it('resolves a structure by swarm-<id>', () => {
    const sw = { x: 5, y: 7, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 5, prevY: 7, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0, radius: 50, kind: 2, sleeping: false, lastUpdateTick: 0 };
    const m = mirror({ swarm: new Map([[42, sw]]) as never });
    expect(bracket.update(m, 'swarm-42')).toBe(true);
    expect(gfxOf(bracket).x).toBe(5);
  });

  it('resolves a lingering hull from mirror.lingeringShips', () => {
    const m = mirror({
      lingeringShips: new Map([['linger-1', { x: 11, y: 22, angle: 0, vx: 0, vy: 0, kind: 'fighter', ownerPlayerId: 'o1' }]]) as never,
    });
    expect(bracket.update(m, 'linger-1')).toBe(true);
    expect(gfxOf(bracket).x).toBe(11);
  });

  it('reports not-present + hides when the entity has vanished', () => {
    const m = mirror({ ships: new Map([['p1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'fighter' }]]) as never });
    expect(bracket.update(m, 'p1')).toBe(true);
    expect(bracket.update(mirror({}), 'p1')).toBe(false);
    expect(gfxOf(bracket).visible).toBe(false);
  });

  it('dirty flag: position-only frames do NOT rebuild geometry; a size change does', () => {
    const ship = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'fighter' };
    const m = mirror({ ships: new Map([['p1', ship]]) as never });
    bracket.update(m, 'p1');
    const g = gfxOf(bracket);
    const afterFirst = g.clear.mock.calls.length;
    expect(afterFirst).toBe(1);
    // Move only → reposition, no rebuild.
    ship.x = 999;
    bracket.update(m, 'p1');
    expect(g.clear.mock.calls.length).toBe(afterFirst);
    expect(g.x).toBe(999);
    // A different-size entity under the same id → rebuild.
    const m2 = mirror({ ships: new Map([['p1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'heavy' }]]) as never });
    bracket.update(m2, 'p1');
    expect(g.clear.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
