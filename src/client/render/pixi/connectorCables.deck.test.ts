/**
 * Base platforms slice 12 — the renderer draws a deck link's cable as the core
 * seam path (`flattenLinkCable` with the deck flag, invariant 15: the same
 * code the server's `canConnect` rule is built on), y flipped to Pixi space.
 */
import { describe, it, expect } from 'vitest';
import { LinkCableCache } from './connectorCables.js';
import { CABLE_CURVE_FLOATS, CABLE_CURVE_SEGMENTS, CABLE_NO_SOCKET, flattenLinkCable, makeCableBox } from '../../../core/structures/cableCurve.js';
import type { GridNode } from '../../../core/structures/Grid.js';
import type { SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { HEX_DIRS } from '../../../core/hex/hex.js';
import { deckHexCentreInto } from '../../../core/hex/plates.js';
import { blankGridNode } from '../../structures/mirrorToGridNode.js';

function node(kind: string, x: number, y: number, isConnector: boolean): GridNode {
  const n = blankGridNode();
  n.kind = kind; n.x = x; n.y = y; n.rot = 0; n.isConnector = isConnector;
  return n;
}
const pose = (n: GridNode): SwarmRenderState => ({ x: n.x, y: n.y, angle: 0, radius: 40, shipKind: n.kind }) as unknown as SwarmRenderState;

describe('LinkCableCache on a deck (slice 12)', () => {
  const d = HEX_DIRS[2]!;
  const p = deckHexCentreInto(d.q, d.r, { x: 0, y: 0 });
  const con = node('connector', 0, 0, true), solar = node('solar', p.x, p.y, false);
  const out = new Float64Array(CABLE_CURVE_FLOATS);
  const box = makeCableBox();

  it('draws the core seam path, y flipped', () => {
    const cache = new LinkCableCache();
    cache.deck = true;
    const c = cache.get(1, pose(solar), CABLE_NO_SOCKET, pose(con), CABLE_NO_SOCKET);
    flattenLinkCable(solar, CABLE_NO_SOCKET, con, CABLE_NO_SOCKET, out, box, true);
    expect(c.n).toBe(CABLE_CURVE_SEGMENTS + 1);
    for (let i = 0; i <= CABLE_CURVE_SEGMENTS; i++) {
      expect(c.poly[i * 2]).toBe(out[i * 2]);
      expect(c.poly[i * 2 + 1]).toBe(-out[i * 2 + 1]!);
    }
    // Not the straight line: an interior point is off the centre-to-centre line.
    const mid = Math.floor(CABLE_CURVE_SEGMENTS / 2);
    const cross = (c.poly[mid * 2]! * -p.y) - (c.poly[mid * 2 + 1]! * p.x);
    expect(Math.abs(cross)).toBeGreaterThan(1);
  });

  it('re-flattens when the deck flag changes', () => {
    const cache = new LinkCableCache();
    cache.deck = true;
    cache.get(1, pose(solar), CABLE_NO_SOCKET, pose(con), CABLE_NO_SOCKET);
    const f = cache.flattens;
    cache.get(1, pose(solar), CABLE_NO_SOCKET, pose(con), CABLE_NO_SOCKET);
    expect(cache.flattens).toBe(f);
    cache.deck = false;
    const c = cache.get(1, pose(solar), CABLE_NO_SOCKET, pose(con), CABLE_NO_SOCKET);
    expect(cache.flattens).toBe(f + 1);
    flattenLinkCable(solar, CABLE_NO_SOCKET, con, CABLE_NO_SOCKET, out, box);
    for (let i = 0; i <= CABLE_CURVE_SEGMENTS; i++) expect(c.poly[i * 2]).toBe(out[i * 2]);
  });
});
