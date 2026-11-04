import { describe, it, expect } from 'vitest';
import { easeTo, exhaustTint, exhaustTrailTex, ExhaustRing, flameShape, flameTex, type FlameShape } from './engineFx.js';

const alphaAt = (i: { w: number; data: Uint8ClampedArray }, x: number, y: number): number => i.data[(y * i.w + x) * 4 + 3]!;

describe('engine exhaust textures', () => {
  it('the flame is brightest on the axis near the mouth and fades to the tip and edges', () => {
    const t = flameTex(128, 32);
    const mid = 16;
    expect(alphaAt(t, 10, mid)).toBeGreaterThan(200);
    expect(alphaAt(t, 120, mid)).toBeLessThan(alphaAt(t, 60, mid));
    expect(alphaAt(t, 127, mid)).toBeLessThan(20);
    expect(alphaAt(t, 10, 0)).toBeLessThan(alphaAt(t, 10, mid) / 3);
  });

  it('the core flame is narrower than the outer flame', () => {
    const outer = flameTex(128, 32, 0), core = flameTex(128, 32, 1);
    expect(alphaAt(core, 20, 9)).toBeLessThan(alphaAt(outer, 20, 9));
  });

  it('the ribbon is bright at the head and gone at the tail', () => {
    const t = exhaustTrailTex(128, 16);
    expect(alphaAt(t, 4, 8)).toBeGreaterThan(200);
    expect(alphaAt(t, 127, 8)).toBeLessThan(5);
  });
});

describe('engine exhaust maths', () => {
  it('flames grow with thrust and again with boost; idle keeps a pilot flame', () => {
    const o: FlameShape = { len: 0, wid: 0, alpha: 0 };
    const idle = flameShape(4, 0, 0, 0, o).len;
    const thrust = flameShape(4, 1, 0, 0, o).len;
    const boost = flameShape(4, 1, 1, 0, o).len;
    expect(idle).toBeGreaterThan(0);
    expect(thrust).toBeGreaterThan(idle * 3);
    expect(boost).toBeGreaterThan(thrust * 1.8);
  });

  it('eases frame-rate free', () => {
    let a = 0, b = 0;
    for (let i = 0; i < 60; i++) a = easeTo(a, 1, 1 / 60, 0.2);
    for (let i = 0; i < 30; i++) b = easeTo(b, 1, 1 / 30, 0.2);
    expect(a).toBeCloseTo(b, 10);
  });

  it('tints blend thrust orange to boost blue', () => {
    expect(exhaustTint(0xff0000, 0x0000ff, 0)).toBe(0xff0000);
    expect(exhaustTint(0xff0000, 0x0000ff, 1)).toBe(0x0000ff);
    expect(exhaustTint(0xff0000, 0x0000ff, 0.5)).toBe(0x800080);
  });

  it('the ring keeps the newest first and repeats the oldest past the end', () => {
    const r = new ExhaustRing(3);
    r.push(1, 10); r.push(2, 20); r.push(3, 30); r.push(4, 40);
    expect(r.length).toBe(3);
    expect([r.x(0), r.x(1), r.x(2), r.x(5)]).toEqual([4, 3, 2, 2]);
    expect(r.y(0)).toBe(40);
  });
});
