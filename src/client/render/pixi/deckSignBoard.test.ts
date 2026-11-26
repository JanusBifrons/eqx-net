/**
 * Junction sign boards: one board opens over a junction near the local ship
 * (on screen), stays open inside the close radius, collapses past it, and
 * rebuilds its rows when the base changes. Pixi is stubbed (node env).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pixi.js', () => {
  class Node {
    children: unknown[] = [];
    visible = true; alpha = 1; x = 0; y = 0; rotation = 0; label = '';
    scale = { x: 1, set(v: number): void { this.x = v; } };
    addChild(...c: unknown[]): void { this.children.push(...c); }
    destroy(): void {}
  }
  class Graphics extends Node {
    clear(): this { return this; }
    rect(): this { return this; }
    roundRect(): this { return this; }
    circle(): this { return this; }
    poly(): this { return this; }
    moveTo(): this { return this; }
    lineTo(): this { return this; }
    fill(): this { return this; }
    stroke(): this { return this; }
  }
  class Text extends Node {
    text = '';
    anchor = { set: (): void => {} };
    get width(): number { return this.text.length * 7; }
  }
  class TextStyle { constructor(public opts: Record<string, unknown>) {} }
  return { Container: Node, Graphics, Text, TextStyle };
});

import { Container } from 'pixi.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '@core/contracts/IRenderer';
import { DECK_HEX_FLAT, deckHexCentreInto } from '../../../core/hex/plates.js';
import type { Camera } from '../worker/Camera.js';
import { DeckSignBoard, SIGN_CLOSE_RADIUS, SIGN_OPEN_RADIUS, SIGN_SAFE_INSET, SIGN_SHIP_KEEPOUT, placeBoard, readSignsFlag } from './deckSignBoard.js';
import { resetRoadJoins, syncRoadJoins } from './roadJoins.js';

const Y_ROADS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [2, 0], [3, 0], [-1, 1], [-2, 2], [0, -1], [0, -2]];
const BIG = new Float64Array([-1e6, -1e6, 1e6, 1e6]);

function deck(): RenderMirror {
  const structures = new Map<number, StructureRenderState>();
  const swarm = new Map<number, SwarmRenderState>();
  const m = { deckPlates: { version: 1, count: 0, ij: new Int32Array(0), deck: true }, localPlayerId: 'me', ships: new Map(), structures, swarm } as unknown as RenderMirror;
  Y_ROADS.forEach(([q, r], i) => put(m, i + 1, 'road', q, r));
  put(m, 100, 'refinery', 3, -1); // 2 steps down the east arm
  return m;
}
function put(m: RenderMirror, id: number, kind: string, q: number, r: number): void {
  const p = deckHexCentreInto(q, r, { x: 0, y: 0 });
  m.structures!.set(id, { mirror: false } as unknown as StructureRenderState);
  m.swarm!.set(id, { x: p.x, y: p.y, angle: Math.PI / 6, shipKind: kind } as unknown as SwarmRenderState);
}
function shipAt(m: RenderMirror, x: number, y: number): void {
  m.ships.set('me', { x, y } as never);
}

describe('deck sign board', () => {
  let board: DeckSignBoard;
  let mirror: RenderMirror;
  let now = 0;
  const tick = (ms = 50, bounds: Float64Array = BIG): void => { now += ms; board.update(mirror, false, now, bounds); };
  beforeEach(() => {
    resetRoadJoins();
    mirror = deck();
    syncRoadJoins(mirror.structures, mirror.swarm);
    board = new DeckSignBoard(new Container(), { scale: { x: 0.5 } } as unknown as Camera, true);
    now = 0;
  });

  it('reads ?signs=on only', () => {
    expect(readSignsFlag('?room=a&signs=on')).toBe(true);
    expect(readSignsFlag('?signs=off')).toBe(false);
    expect(readSignsFlag('')).toBe(false);
    expect(SIGN_CLOSE_RADIUS).toBeGreaterThan(SIGN_OPEN_RADIUS);
  });

  it('expands near a junction, holds inside the close radius, collapses past it', () => {
    shipAt(mirror, 0.5 * DECK_HEX_FLAT, 0);
    for (let i = 0; i < 6; i++) tick();
    expect(board.openness()).toBe(1);
    expect(board.rowCount()).toBe(1); // east arm: the refinery
    shipAt(mirror, 1.6 * DECK_HEX_FLAT, 0); // between open and close radius
    tick();
    expect(board.openness()).toBe(1);
    shipAt(mirror, 3 * DECK_HEX_FLAT, 0);
    tick();
    expect(board.openness()).toBeGreaterThan(0);
    expect(board.openness()).toBeLessThan(1);
    for (let i = 0; i < 6; i++) tick();
    expect(board.openness()).toBe(0);
    expect(board.rowCount()).toBe(0);
  });

  it('does not open from outside the open radius, off screen, or off the deck', () => {
    shipAt(mirror, 1.6 * DECK_HEX_FLAT, 0);
    for (let i = 0; i < 4; i++) tick();
    expect(board.openness()).toBe(0);
    shipAt(mirror, 0, 0);
    const offScreen = new Float64Array([1e5, 1e5, 2e5, 2e5]);
    for (let i = 0; i < 4; i++) tick(50, offScreen);
    expect(board.openness()).toBe(0);
    mirror.deckPlates!.deck = false;
    for (let i = 0; i < 4; i++) tick();
    expect(board.openness()).toBe(0);
  });

  it('rebuilds its rows when a building is added while open', () => {
    shipAt(mirror, 0, 0);
    for (let i = 0; i < 6; i++) tick();
    expect(board.rowCount()).toBe(1);
    put(mirror, 101, 'smelter', -2, 1); // 1 step down the 120° arm
    tick();
    expect(board.rowCount()).toBe(2);
  });

  it('keeps the board inside the safe rect when the junction is near the view edge', () => {
    shipAt(mirror, 0, 0);
    const edge = new Float64Array([-100, -2000, 4000, 2000]); // junction (0,0) hugs the left edge
    for (let i = 0; i < 6; i++) tick(50, edge);
    const a = board.boardAnchor();
    expect(a.x).toBeGreaterThan(-100 + 4100 * SIGN_SAFE_INSET[0]);
    expect(a.y).toBeLessThanOrEqual(2000 - 4000 * SIGN_SAFE_INSET[3]);
  });

  it('never covers the ship at the view centre', () => {
    const b = [0, 0, 1000, 400]; // phone-shaped view, ship at (500, 200)
    const out = new Float64Array(2);
    // Junction low and just left of centre: the plain clamp would land on the ship.
    placeBoard(450, 380, 250, 100, 450, b, out);
    const kw = 1000 * SIGN_SHIP_KEEPOUT[0], kh = 400 * SIGN_SHIP_KEEPOUT[1];
    const clear = out[0] + 125 <= 500 - kw || out[0] - 125 >= 500 + kw || out[1] <= 200 - kh || out[1] - 100 >= 200 + kh;
    expect(clear).toBe(true);
    expect(out[0]).toBeLessThan(500); // the junction's side
  });

  it('a disabled board never opens', () => {
    const off = new DeckSignBoard(new Container(), { scale: { x: 1 } } as unknown as Camera, false);
    shipAt(mirror, 0, 0);
    off.update(mirror, false, 0, BIG);
    off.update(mirror, false, 500, BIG);
    expect(off.openness()).toBe(0);
  });
});
