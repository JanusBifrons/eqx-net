/**
 * Lock for `SelectionBracket` (structures follow-up Item B4, invariant #14).
 *
 * Asserts the single-pooled-Graphics + dirty-flag discipline:
 *  - one Graphics for the whole component (single selection)
 *  - geometry rebuilt ONLY when the bracket size (entity radius) changes;
 *    position-only frames do NOT call clear()
 *  - resolves the live pose from the mirror by id (ship / swarm-N / wreck)
 *  - returns false (and hides) when the entity vanishes or id is null
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { SelectionBracket } from './SelectionBracket.js';

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
  return { ships: new Map(), swarm: new Map(), wrecks: new Map(), localPlayerId: null, ...over } as RenderMirror;
}

function gfxOf(b: SelectionBracket): { clear: ReturnType<typeof vi.fn>; x: number; y: number; visible: boolean } {
  return (b as unknown as { gfx: { clear: ReturnType<typeof vi.fn>; x: number; y: number; visible: boolean } }).gfx;
}

describe('SelectionBracket', () => {
  let parent: { addChild: ReturnType<typeof vi.fn> };
  let bracket: SelectionBracket;

  beforeEach(() => {
    parent = { addChild: vi.fn() };
    bracket = new SelectionBracket(parent as never);
  });

  it('null id hides the bracket and reports not-present', () => {
    const present = bracket.update(mirror({}), null);
    expect(present).toBe(false);
    expect(gfxOf(bracket).visible).toBe(false);
  });

  it('resolves a ship pose (pixiY = -gameY) and reports present', () => {
    const m = mirror({ ships: new Map([['p1', { x: 100, y: 200, angle: 0, vx: 0, vy: 0, kind: 'fighter' }]]) as never });
    const present = bracket.update(m, 'p1');
    expect(present).toBe(true);
    const g = gfxOf(bracket);
    expect(g.visible).toBe(true);
    expect(g.x).toBe(100);
    expect(g.y).toBe(-200); // Y flip
  });

  it('resolves a structure by swarm-<id>', () => {
    const sw = { x: 5, y: 7, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 5, prevY: 7, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0, radius: 50, kind: 2, sleeping: false, lastUpdateTick: 0 };
    const m = mirror({ swarm: new Map([[42, sw]]) as never });
    const present = bracket.update(m, 'swarm-42');
    expect(present).toBe(true);
    expect(gfxOf(bracket).x).toBe(5);
  });

  it('reports not-present + hides when the entity has vanished', () => {
    const m = mirror({ ships: new Map([['p1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'fighter' }]]) as never });
    expect(bracket.update(m, 'p1')).toBe(true);
    // Entity gone next frame.
    const empty = mirror({});
    expect(bracket.update(empty, 'p1')).toBe(false);
    expect(gfxOf(bracket).visible).toBe(false);
  });

  it('dirty flag: position-only frames do NOT rebuild geometry', () => {
    const ship = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'fighter' };
    const m = mirror({ ships: new Map([['p1', ship]]) as never });
    bracket.update(m, 'p1');
    const g = gfxOf(bracket);
    const clearsAfterFirst = g.clear.mock.calls.length;
    expect(clearsAfterFirst).toBe(1); // first paint rebuilt once

    // Move the ship (size unchanged) → should reposition but NOT clear again.
    ship.x = 999;
    ship.y = -123;
    bracket.update(m, 'p1');
    expect(g.clear.mock.calls.length).toBe(clearsAfterFirst); // no extra rebuild
    expect(g.x).toBe(999);
    expect(g.y).toBe(123); // -(-123)
  });

  it('dirty flag: a size change DOES rebuild geometry', () => {
    const small = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'scout' }; // radius 10
    const big = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'heavy' };
    const m1 = mirror({ ships: new Map([['p1', small]]) as never });
    bracket.update(m1, 'p1');
    const g = gfxOf(bracket);
    const after1 = g.clear.mock.calls.length;
    // Select a bigger ship under the same id slot → different half-size.
    const m2 = mirror({ ships: new Map([['p1', big]]) as never });
    bracket.update(m2, 'p1');
    expect(g.clear.mock.calls.length).toBeGreaterThan(after1);
  });
});
