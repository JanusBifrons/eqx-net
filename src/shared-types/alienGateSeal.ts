/**
 * Teleporter redesign A3 — the Ancients' gate's seal. The gate has no posts:
 * its outermost Astrolabe ring is the edge. Through the last seconds before a
 * jump (the SEALED phase, the iris's existing timing) that ring closes into a
 * solid circle, so nobody gets in or out; the rest of the time nothing at the
 * gate blocks a ship.
 *
 * The circle is a closed polygon of `ALIEN_GATE_SEAL_SPANS` chords whose
 * corners sit on the outer ring's outer edge. This file is the ONE source for
 * the ring's size (the Astrolabe rig reads it, `alienGateAstrolabe.ts`), the
 * seal's iris spans (the server's walls and the client's derived walls,
 * through `padIrisSpanLocal`; #15), the ride area (`onPad`) and the closing
 * push (`padPushDir`). Pure; no allocation after module load (#14).
 */

/** The outer Astrolabe ring's centre-line radius and band width (world units,
 *  1600-wide gate; taste from the approved B mock-up). */
export const ALIEN_GATE_OUTER_RING_RADIUS = 780;
export const ALIEN_GATE_OUTER_RING_WIDTH = 76;

/** The seal polygon's corners sit on the outer ring's outer edge. */
export const ALIEN_GATE_SEAL_RADIUS = ALIEN_GATE_OUTER_RING_RADIUS + ALIEN_GATE_OUTER_RING_WIDTH / 2;

/** Chords round the seal: 32 keeps the sag inside the ring under 4 units
 *  (R · (1 − cos(π / 32)) ≈ 3.9) and is a multiple of 4, so a quarter turn
 *  maps the polygon onto itself. */
export const ALIEN_GATE_SEAL_SPANS = 32;

/** Distance from the centre to the middle of each chord (the polygon's
 *  apothem): a ship whose centre is inside it is inside the seal. */
export const ALIEN_GATE_SEAL_APOTHEM = ALIEN_GATE_SEAL_RADIUS * Math.cos(Math.PI / ALIEN_GATE_SEAL_SPANS);

/** Corner k at [2k], [2k + 1] (local frame), built once. */
const CORNERS: Float64Array = (() => {
  const out = new Float64Array(ALIEN_GATE_SEAL_SPANS * 2);
  for (let k = 0; k < ALIEN_GATE_SEAL_SPANS; k++) {
    const a = (2 * Math.PI * k) / ALIEN_GATE_SEAL_SPANS;
    out[2 * k] = ALIEN_GATE_SEAL_RADIUS * Math.cos(a);
    out[2 * k + 1] = ALIEN_GATE_SEAL_RADIUS * Math.sin(a);
  }
  return out;
})();

/** Seal chord `i` (local frame): corner i to corner i + 1, the last back to
 *  the first, so the spans close exactly. Writes `out`. */
export function alienGateSealSpan(i: number, out: { ax: number; ay: number; bx: number; by: number }): void {
  const n = ALIEN_GATE_SEAL_SPANS;
  const a = ((i % n) + n) % n;
  const b = (a + 1) % n;
  out.ax = CORNERS[2 * a]!;
  out.ay = CORNERS[2 * a + 1]!;
  out.bx = CORNERS[2 * b]!;
  out.by = CORNERS[2 * b + 1]!;
}
