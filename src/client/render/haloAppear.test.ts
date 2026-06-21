/**
 * Equinox Phase-5 audit (2026-06-21) — halo glyph appear fade (replaces the
 * off-screen "fly-in" the user reported as "I STILL see the halo radar popping
 * in!"). A first-visible glyph now snaps to its ring target and EASES in via this
 * fade instead of flying in from the corner.
 */
import { describe, it, expect } from 'vitest';
import { haloAppearFadeStep, HALO_APPEAR_FADE_MS } from './haloAppear.js';

describe('haloAppearFadeStep', () => {
  it('eases from 0 toward 1 over HALO_APPEAR_FADE_MS', () => {
    // Half the fade window → ~0.5 opaque (a smooth ease-in, not an instant pop).
    expect(haloAppearFadeStep(0, HALO_APPEAR_FADE_MS / 2)).toBeCloseTo(0.5, 5);
  });

  it('clamps to 1 (never over-shoots, idempotent once opaque)', () => {
    expect(haloAppearFadeStep(0, HALO_APPEAR_FADE_MS * 10)).toBe(1);
    expect(haloAppearFadeStep(1, 16)).toBe(1);
  });

  it('clamps to ≥ 0 for a non-advancing frame', () => {
    expect(haloAppearFadeStep(0, 0)).toBe(0);
    expect(haloAppearFadeStep(0.3, 0)).toBeCloseTo(0.3, 5);
  });

  it('a zero/negative fade window means "instantly opaque" (fade disabled)', () => {
    expect(haloAppearFadeStep(0, 16, 0)).toBe(1);
  });
});
