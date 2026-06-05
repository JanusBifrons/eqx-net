/**
 * Locks the catalogue-indexing contract of the local player's per-mount
 * aim (the latent index bug fix). `ShipRenderState.mountAngles` is read
 * catalogue-indexed by both the beam renderer and the turret sprites;
 * the local writer MUST index it the same way. These tests use an active
 * slot that is a SUBSET / REORDER of the catalogue mounts — the exact
 * regime where slot-local indexing (the old bug) diverges from
 * catalogue indexing. A slot-local implementation FAILS the
 * "subset slot writes at the catalogue index" case.
 */
import { describe, it, expect } from 'vitest';
import { tickLocalMountAngles } from './localMountAim';
import type { WeaponMount } from '@shared-types/shipKinds';

function mk(id: string, over: Partial<WeaponMount> = {}): WeaponMount {
  return {
    id,
    localX: 0,
    localY: 0,
    baseAngle: 0,
    arcMin: -Math.PI,
    arcMax: Math.PI,
    rotationSpeed: 100, // fast: one big-dt tick snaps to the desired bearing
    weaponId: 'hitscan',
    ...over,
  };
}

// Catalogue order: [a, b, c]. A target straight to the +x side of a ship
// at the origin facing forward (angle 0) needs a non-zero mount-local
// bearing (≈ +π/2 in this convention), so an aiming mount ends up != 0.
const A = mk('a');
const B = mk('b');
const C = mk('c');
const CATALOGUE = [A, B, C];
const TARGET = { x: 100, y: 0 };

describe('tickLocalMountAngles', () => {
  it('subset active slot {c}: the aim angle lands at the CATALOGUE index (2), not slot-local index (0)', () => {
    const out = [0, 0, 0];
    tickLocalMountAngles(out, CATALOGUE, new Set(['c']), TARGET, 0, 0, 0, 1);
    // c (catalogue index 2) aims → non-zero.
    expect(out[2]).not.toBe(0);
    // a, b (not in the active slot) slew to base (0 → stays 0).
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    // The bug this guards: slot-local indexing would have written c's
    // angle at index 0 and left index 2 at 0.
    expect(out[0]).toBe(0);
  });

  it('reordered active slot {c,a}: each id maps to its own catalogue index', () => {
    const out = [0, 0, 0];
    tickLocalMountAngles(out, CATALOGUE, new Set(['c', 'a']), TARGET, 0, 0, 0, 1);
    expect(out[0]).not.toBe(0); // a aims
    expect(out[1]).toBe(0);     // b idle
    expect(out[2]).not.toBe(0); // c aims
    // a and c see the same geometry (both at local 0,0), so identical angle.
    expect(out[0]).toBeCloseTo(out[2]!, 10);
  });

  it('full slot (every catalogue id): behaviour-identical to "aim all" (the single-slot ships today)', () => {
    const out = [0, 0, 0];
    tickLocalMountAngles(out, CATALOGUE, new Set(['a', 'b', 'c']), TARGET, 0, 0, 0, 1);
    expect(out[0]).not.toBe(0);
    expect(out[1]).not.toBe(0);
    expect(out[2]).not.toBe(0);
  });

  it('no target: every mount slews back to base (0)', () => {
    const out = [0.5, -0.3, 0.9];
    tickLocalMountAngles(out, CATALOGUE, new Set(['a', 'b', 'c']), null, 0, 0, 0, 1);
    expect(out).toEqual([0, 0, 0]);
  });

  it('a fixed mount (arc 0, speed 0) stays at base even when in the active slot', () => {
    const fixedC = mk('c', { arcMin: 0, arcMax: 0, rotationSpeed: 0 });
    const out = [0, 0, 0];
    tickLocalMountAngles(out, [A, B, fixedC], new Set(['c']), TARGET, 0, 0, 0, 1);
    expect(out[2]).toBe(0);
  });
});
