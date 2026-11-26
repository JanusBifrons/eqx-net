/**
 * Cable cover mask: with a new edge look, deck power cables that run under a
 * lit fence beam hide their cradles, clamps and lashings (they poked out past
 * the beam). End collars still draw; an empty mask draws every station.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { drawCablePathBody, setCableCover, type CablePath, type LinePath } from './connectorLineLooks.js';

class Rec {
  verbs = 0;
  moveTo(): this { this.verbs++; return this; }
  lineTo(): this { this.verbs++; return this; }
  quadraticCurveTo(): this { this.verbs++; return this; }
  stroke(): this { return this; }
  get g(): LinePath { return this as unknown as LinePath; }
}

function line(ax: number, ay: number, bx: number, by: number): CablePath {
  const len = Math.hypot(bx - ax, by - ay);
  return { poly: Float64Array.of(ax, ay, bx, by), cum: Float64Array.of(0, len), n: 2, len };
}

function verbs(path: CablePath): number {
  const r = new Rec();
  drawCablePathBody(r.g, path, 1, 20, 20, true);
  return r.verbs;
}

afterEach(() => setCableCover([], 0, 0));

describe('cable cover mask', () => {
  const path = line(0, 0, 600, 0);

  it('an empty mask draws the full body', () => {
    setCableCover([], 0, 0);
    const full = verbs(path);
    setCableCover(Float64Array.of(0, 500, 600, 500), 1, 6); // a beam far away
    expect(verbs(path)).toBe(full);
  });

  it('a lit beam over the cable drops its cradles and lashings, keeping collars', () => {
    const full = verbs(path);
    setCableCover(Float64Array.of(0, 0, 600, 0), 1, 6);
    const covered = verbs(path);
    expect(covered).toBeLessThan(full);
    // Collars and the strands remain.
    expect(covered).toBeGreaterThan(0);
    // Every hidden station is already gone: a second beam hides nothing more.
    setCableCover(Float64Array.of(0, 0, 600, 0, 0, 1, 600, 1), 2, 6);
    expect(verbs(path)).toBe(covered);
  });

  it('a beam over half the cable hides only that half', () => {
    const full = verbs(path);
    setCableCover(Float64Array.of(0, 0, 600, 0), 1, 6);
    const all = verbs(path);
    setCableCover(Float64Array.of(0, 0, 300, 0), 1, 6);
    const half = verbs(path);
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(all);
  });
});
