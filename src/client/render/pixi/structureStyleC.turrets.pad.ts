/**
 * Style C turrets family: the armoured gun pad every turret base stands on
 * (structureStyleC.turrets.ts, the small guns; structureStyleC.turretsHeavy.ts,
 * the missile turret and mine layer). Its own file so both drawer files share
 * one pad without importing each other.
 */
import { RIVET, SLAB, SLAB_DARK, SOOT, core, glow, grime, ngon, poly, wornStripe, type Pts, type StyleCtx } from './structureStyleKit.js';

/** Blue trim (the Capital / refinery / pylon trim) lit, and its dead glass. */
export const TRIM = 0x7fd4ff;
export const TRIM_DEAD = 0x142430;

/** The dark well under the gun ring, × R. The small guns' ring is R × 0.442
 *  (`turretLayout.ts`), so the well shows a dark lip round it. */
export const TURRET_WELL = 0.5;

/** The armoured octagon pad (`r` × R): the pad slab, a raised collar, a bolt
 *  ring, the dark well (`well` × R, drawn LAST) and blue trim lamps on the pad
 *  rim. The collar and bolt ring sit just outside the well (+0.16 R, +0.08 R).
 *  Returns the pad outline. */
export function gunPad(c: StyleCtx, R: number, r: number, salt: number, well = TURRET_WELL): Pts {
  const trim = c.live ? TRIM : TRIM_DEAD;
  const pad = core(c, ngon(0, 0, r * R, 8, Math.PI / 8), SLAB, 18, Math.PI / 2);
  grime(c, -0.7 * R, -0.7 * R, 1.4 * R, 1.4 * R, 6, salt);
  wornStripe(c, pad, Math.PI / 2, 0.72 * R, 0.07 * R, salt + 1);
  // Blue trim lamps on the rim, at the eight octagon corners.
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4, rr = (r - 0.09) * R;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    glow(c, ngon(x, y, 0.035 * R, 8), trim, 0.9);
    if (i % 2 === 0) c.lit(x, y, 0.03 * R, trim);
  }
  // The raised armour collar and its bolt ring.
  poly(c, ngon(0, 0, (well + 0.16) * R, 8, Math.PI / 8), SLAB_DARK, 'metal', 24, 0.05 * R, { roof: [2, 0.05 * R] });
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6, rr = (well + 0.08) * R;
    poly(c, ngon(Math.cos(a) * rr, Math.sin(a) * rr, 0.024 * R, 6), RIVET, 'metal', 26, 0.5);
  }
  // The dark well the gun ring sits in.
  poly(c, ngon(0, 0, well * R, 16), SOOT, 'metal', -3, 0.03 * R);
  return pad;
}
