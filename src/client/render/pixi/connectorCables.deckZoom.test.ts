/**
 * Smoke-test bug (2026-11-27): zoomed out, the cables between deck plates
 * swelled into wide pale bands over the plates. The cable look keeps a
 * screen-pixel floor (`MIN_PX`), so its world width grew without bound as
 * the camera pulled back. A deck seam cable lies in a plate seam: it scales
 * with the plates like the deck it is part of, never wider than at 1x. A
 * cable across open space (no deck) keeps its floor.
 */
import { describe, expect, it } from 'vitest';
import { LinkCableCache, drawSocketCableBody, drawSocketCableFlow } from './connectorCables.js';
import { CABLE_NO_SOCKET } from '../../../core/structures/cableCurve.js';
import type { SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { HEX_DIRS } from '../../../core/hex/hex.js';
import { deckHexCentreInto, plateCentreWorldInto } from '../../../core/hex/plates.js';
import { connectorVisualInto, type ConnectorVisual } from './connectorVisual.js';
import type { LinePath } from './connectorLineLooks.js';

/** Records each stroke's width and the points stroked. */
class FakePath {
  widths: number[] = [];
  minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
  moveTo(x: number, y: number): this { return this.pt(x, y); }
  lineTo(x: number, y: number): this { return this.pt(x, y); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this { this.pt(cx, cy); return this.pt(x, y); }
  closePath(): this { return this; }
  fill(): this { return this; }
  stroke(s: { width: number }): this { this.widths.push(s.width); return this; }
  private pt(x: number, y: number): this {
    if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y; if (y > this.maxY) this.maxY = y;
    return this;
  }
  get g(): LinePath { return this as unknown as LinePath; }
  get widest(): number { return Math.max(...this.widths); }
}

const pose = (kind: string, x: number, y: number): SwarmRenderState =>
  ({ x, y, angle: 0, radius: 40, shipKind: kind }) as unknown as SwarmRenderState;

// A solar on a connector's plate: its deck link runs along the seams.
const d = HEX_DIRS[2]!;
const p = deckHexCentreInto(d.q, d.r, { x: 0, y: 0 });
const A = pose('solar', p.x, p.y), B = pose('connector', 0, 0);

function cable(deck: boolean) {
  const cache = new LinkCableCache();
  cache.deck = deck;
  return cache.get(1, A, CABLE_NO_SOCKET, B, CABLE_NO_SOCKET);
}
function body(deck: boolean, scale: number): FakePath {
  const f = new FakePath();
  drawSocketCableBody(f.g, cable(deck), scale, 40, 40);
  return f;
}
function flowing(): ConnectorVisual {
  return connectorVisualInto({ color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 }, 1e12, 1e12, 1, 0, 'minerals');
}
function flow(deck: boolean, scale: number): FakePath {
  const f = new FakePath();
  drawSocketCableFlow(f.g, cable(deck), flowing(), true, scale, 5_000, 'minerals', 40, 40);
  return f;
}

describe('deck seam cables zoomed out (smoke-test bug: swollen cables)', () => {
  it('the body is no wider in the world zoomed out than at 1x', () => {
    const near = body(true, 1);
    for (const s of [0.25, 0.1, 0.04]) {
      const far = body(true, s);
      expect(far.widest, 'scale ' + s).toBeLessThanOrEqual(near.widest + 1e-9);
      // Nothing it draws spreads further over the plates either.
      expect(far.maxX - far.minX, 'scale ' + s).toBeLessThanOrEqual(near.maxX - near.minX + 1e-6);
      expect(far.maxY - far.minY, 'scale ' + s).toBeLessThanOrEqual(near.maxY - near.minY + 1e-6);
    }
  });

  it('the flow on it is no wider zoomed out than at 1x', () => {
    const near = flow(true, 1);
    expect(near.widths.length).toBeGreaterThan(0);
    expect(flow(true, 0.04).widest).toBeLessThanOrEqual(near.widest + 1e-9);
  });

  it('a plate-to-plate link (connector to connector) is a seam cable too', () => {
    const q = plateCentreWorldInto(1, 0, { x: 0, y: 0 });
    const cache = new LinkCableCache();
    cache.deck = true;
    expect(cache.get(2, B, CABLE_NO_SOCKET, pose('connector', q.x, q.y), CABLE_NO_SOCKET).seam).toBe(true);
    cache.deck = false;
    expect(cache.get(2, B, CABLE_NO_SOCKET, pose('connector', q.x, q.y), CABLE_NO_SOCKET).seam).toBe(false);
  });

  it('a cable off a deck keeps its screen floor (unchanged)', () => {
    expect(body(false, 0.04).widest).toBeGreaterThan(body(false, 1).widest * 2);
  });
});
