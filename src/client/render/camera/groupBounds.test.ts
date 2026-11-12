/**
 * capital-lineup take (2026-11-12, room `showcase-capitals`): `frame all`
 * left the base out. Measured in a browser: the director's group bounds held
 * 16 sprites before the opening cue and 15 after it (minY -5,900 → -4,858):
 * the base structure's sprite was hidden by the renderer's off-screen
 * structure culling, and the scan skipped hidden sprites. So the framing only
 * included what was already on screen.
 */
import { describe, it, expect } from 'vitest';
import { GroupBoundsScanner, inFrameGroup, type FramedSprite } from './groupBounds';

function sprite(x: number, y: number, size: number, visible = true): FramedSprite {
  return { x, y, width: size, height: size, visible };
}

describe('frame group bounds', () => {
  const kinds = new Map<string, number>([
    ['swarm-1', 1], // a capital
    ['swarm-9', 2], // the base, culled off screen
    ['swarm-4', 1], // a drone on its warp run (hidden)
  ]);
  const sprites = new Map<string, FramedSprite>([
    ['pilot', sprite(0, 4000, 40)],
    ['swarm-1', sprite(0, 0, 400)],
    ['swarm-9', sprite(2000, 5500, 600, false)],
    ['swarm-4', sprite(-9000, 0, 40, false)],
  ]);

  it('"all" includes a structure the renderer hid off screen', () => {
    const out = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const n = new GroupBoundsScanner(kinds).scan(sprites, 'all', out);
    expect(n).toBe(3);
    expect(out.maxY).toBe(5800); // the base's far edge
    expect(out.maxX).toBe(2300);
  });

  it('a hidden ship (warping out) stays out', () => {
    const out = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    new GroupBoundsScanner(kinds).scan(sprites, 'all', out);
    expect(out.minX).toBe(-200); // not -9020
  });

  it('group filters keep their meaning', () => {
    expect(inFrameGroup('structures', 'swarm-9', 2, false)).toBe(true);
    expect(inFrameGroup('drones', 'swarm-9', 2, true)).toBe(false);
    expect(inFrameGroup('ships', 'pilot', undefined, true)).toBe(true);
    expect(inFrameGroup('ships', 'swarm-1', 1, true)).toBe(false);
    expect(inFrameGroup('drones', 'swarm-4', 1, false)).toBe(false);
    const out = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    expect(new GroupBoundsScanner(kinds).scan(sprites, 'structures', out)).toBe(1);
  });
});
