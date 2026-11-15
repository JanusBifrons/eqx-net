/**
 * The wreck glow's colour curves (pure, alloc-free): the cut-edge glow over
 * its age (`wreckGlowAt`), per tint (a crack's molten orange, a weapon's
 * kill cut in its own colour, a subdued splinter), and the sub-capital
 * simple glow over its life (`simpleGlowAt`). Split out of wreckArt.ts,
 * which bakes these into the glow textures and draws them.
 * Detail: docs/architecture/capital-destruction.md "Cut glow colours".
 */
import { EDGE_CUT } from '../../../core/destruction/fractureHull.js';
import { HEAVY_BEAM_COLOR } from '../beamStyles.js';

/** The cut edges are a dull ember here (s)... (money-shot review: it was
 *  still bright orange at 4.5 s; review 2026-11-13: still saturated orange
 *  ~3 s after the kill. Now white-hot only at the crack front, orange for
 *  about half a second, a red ember by ~2 s, dark by 4.5 s.) */
export const WRECK_GLOW_EMBER_S = 1.8;
/** ...and dark from here on (s); the glow stroke is then destroyed. */
export const WRECK_GLOW_END_S = 4.5;
/** A crack's soft halo reaches this many times its core. */
export const GLOW_HALO_MUL = 3;

// ── The glow curve ────────────────────────────────────────────────────────

export interface WreckGlow { color: number; alpha: number }

/** Keyframes: time (s), colour, alpha. Colour and alpha only ever fall. The
 *  white-hot stage is short (0.12 s), so a crack is orange a stretch behind
 *  its tip and the white-hot head racing along it stands out (review
 *  2026-11-13: no visible head: the crack behind it was as white). Past the
 *  ember it is a faint dark grey-brown scorch, never black (filmed v3 takes
 *  2026-11-13: the old near-black 0x501404 / 0x200804 tail read as a black
 *  "char" band across every opening gap). */
const GLOW_T = [0, 0.12, 0.6, WRECK_GLOW_EMBER_S, 2.2, 3, WRECK_GLOW_END_S];
const GLOW_C = [0xfff2c8, 0xffa040, 0xff6a18, 0xa82c08, 0x5a4a40, 0x4a3c34, 0x3a2f2a];
const GLOW_A = [1, 1, 0.92, 0.55, 0.25, 0.14, 0];
/** The soft halo (3× the core) only while the edge glows: gone by this age
 *  (s), so a cooled edge keeps just the thin core as its scorch. */
const HALO_FADE_FROM_S = 0.6;
const HALO_GONE_S = WRECK_GLOW_EMBER_S + 0.2;

export function lerpColor(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

// ── Glow tints: a weapon's kill cut burns in its own colour ──────────────

/** A crack (every cut but a weapon's kill cut): the molten curve as is. */
export const GLOW_TINT_CRACK = 0;
/** The heavy beam's slice line (`EDGE_CUT` on a `slice` kill): the beam's
 *  violet where it burned through, then the same ember and scorch. */
export const GLOW_TINT_SLICE = 1;
/** The railgun's channel walls (`EDGE_CUT` on a `channel` kill): white-hot
 *  metal where the slug punched through, then the same ember and scorch. */
export const GLOW_TINT_CHANNEL = 2;
/** A splinter crack of a weapon's kill cut (every non-`EDGE_CUT` edge of a
 *  wreck with a `cutKind`, full glow only): the crack curve, subdued so the
 *  cut reads first (owner 2026-11-15: keep the X of splinters, tone their
 *  glow down). `SPLINTER_GLOW_ALPHA` × a crack's alpha, `SPLINTER_GLOW_WIDTH_MUL`
 *  × its width, dark by `SPLINTER_GLOW_END_S`. */
export const GLOW_TINT_SPLINTER = 3;
/** Tints baked into the glow textures (one row block each). */
export const WRECK_GLOW_TINTS = 4;
/** A weapon's kill cut is the hero of the break-up (owner, filmed review
 *  2026-11-15: the slice read as a 1–2 px violet hairline beside white-yellow
 *  splinter cracks, and no violet was left once the beam stopped). So a
 *  tinted edge has its OWN curve, not the crack curve re-coloured: full
 *  brightness in the weapon's colour for `CUT_GLOW_HOLD_S`, then it cools
 *  through a hot-metal ember to the same dark scorch, always at least
 *  as bright as a crack of the same age. Keyframes per tint (index 0, the
 *  crack, uses `GLOW_T/C/A`).
 *  - Slice: the beam's pale core at the instant of the cut, the beam's
 *    violet held ~1.5 s, then burnt metal cooling as hot metal does: an
 *    orange ember at once (by 1.75 s: a long violet → orange blend reads as
 *    a pink step), deep red by ~3.4 s, a brown scorch, dark (hostile reviews
 *    2026-11-15: beam take 6, a violet ember cooling straight to dark; beam
 *    take 8, a rose/coral step BEFORE the orange, backwards for metal).
 *  - Channel: white-hot held, then it cools like struck metal (yellow-white,
 *    orange ember, deep red, scorch, dark).
 *  The ember is a stage of its own, clearly showing to ~3.4 s (second film
 *  review 2026-11-15: the old ember, a dark 0x7428a8 at 2.3 s falling to a
 *  0.32-alpha grey-violet at 3 s, read as dark ~2.3 s after the kill, with
 *  no violet ember seen); the scorch fades out over the last second. */
export const CUT_GLOW_HOLD_S = 1.5;
const SLICE_PALE = lerpColor(0xffffff, HEAVY_BEAM_COLOR, 0.45);
/** Splinter (`GLOW_TINT_SPLINTER`): alpha × this, width × the next, dark by
 *  the last (s), a short life on the crack curve's colours. */
export const SPLINTER_GLOW_ALPHA = 0.45;
export const SPLINTER_GLOW_WIDTH_MUL = 0.5;
export const SPLINTER_GLOW_END_S = 2.6;
const CUT_T: readonly (readonly number[])[] = [
  GLOW_T,
  [0, 0.12, CUT_GLOW_HOLD_S, 1.75, 2.6, 3.4, 4.0, WRECK_GLOW_END_S],
  [0, 0.12, CUT_GLOW_HOLD_S, 2.0, 2.7, 3.4, 4.0, WRECK_GLOW_END_S],
  [0, 0.08, 0.35, 1.0, 1.6, 2.1, SPLINTER_GLOW_END_S],
];
const CUT_C: readonly (readonly number[])[] = [
  GLOW_C,
  [SLICE_PALE, HEAVY_BEAM_COLOR, HEAVY_BEAM_COLOR, 0xff8a28, 0xf2581a, 0xb01e0c, 0x50322a, 0x3a2f2a],
  [0xffffff, 0xf4f2ff, 0xf4f2ff, 0xffd890, 0xff7a28, 0xb0280e, 0x50322a, 0x3a2f2a],
  GLOW_C,
];
const CUT_A: readonly (readonly number[])[] = [
  GLOW_A,
  [1, 1, 1, 0.98, 0.92, 0.72, 0.3, 0],
  [1, 1, 1, 0.95, 0.82, 0.55, 0.25, 0],
  GLOW_A.map((a) => a * SPLINTER_GLOW_ALPHA),
];
/** A tinted cut's glow core is this many times a crack's width: the cut
 *  reads as the widest, brightest line on the wreck. Baked into the glow
 *  mesh at build (one mesh per piece still). */
export const CUT_GLOW_WIDTH_MUL = 2.5;
/** The slice's core is wider still (hostile film review 2026-11-15, beam
 *  take 8: its hot edge was a thin ~6–7 px pale line, not molten metal). The
 *  channel keeps `CUT_GLOW_WIDTH_MUL` (its walls already read as slabs when
 *  wider). Still held to the drawn hull and the piece (`insideWidth`). */
export const SLICE_GLOW_WIDTH_MUL = 2.8;
/** A tinted cut's soft halo reaches this many times ITS core (a crack's:
 *  `GLOW_HALO_MUL`, 3). At 3 × the 2.5 × core it was a flat slab ~150 u
 *  deep on a heavy cruiser, filmed as four violet "bevels" instead of a
 *  glowing edge (review 2026-11-15). */
const CUT_HALO_CORE_MUL = 1.6;
/** The soft halo of a tinted cut: brighter than a crack's (× alpha), held
 *  with the colour and gone by the end of its ember. */
const CUT_HALO_A = 0.45;
const CUT_HALO_FADE_FROM_S = CUT_GLOW_HOLD_S;
const CUT_HALO_GONE_S = 3.4;
/** The simple (sub-capital) glow: the tint holds over this life fraction
 *  (past the end of its orange stage), and is gone by the end of its red. */
const SIMPLE_TINT_HOT = 0.1;
const SIMPLE_TINT_HOLD = 0.5;
const SIMPLE_TINT_GONE = 0.85;

/** The glow tint of an edge: `EDGE_CUT` edges of a cut kill take the
 *  weapon's tint; every other edge (and any edge of a kill without a cut)
 *  keeps the crack curve. Pure. */
export function glowTintOf(edgeKind: number | undefined, cutKind: 'slice' | 'channel' | undefined): number {
  if (cutKind === undefined) return GLOW_TINT_CRACK;
  if (edgeKind !== EDGE_CUT) return GLOW_TINT_SPLINTER;
  return cutKind === 'slice' ? GLOW_TINT_SLICE : GLOW_TINT_CHANNEL;
}

/** A weapon's kill cut (slice or channel), not a crack or a splinter. Pure. */
export function isKillCutTint(tint: number): boolean {
  return tint === GLOW_TINT_SLICE || tint === GLOW_TINT_CHANNEL;
}

/** The core strip width multiplier for a glow tint (1 for a crack, 0.5 for
 *  a splinter, 2.5 for a channel, 2.8 for a slice). Pure. */
export function glowWidthMul(tint: number): number {
  if (tint === GLOW_TINT_SPLINTER) return SPLINTER_GLOW_WIDTH_MUL;
  if (tint === GLOW_TINT_SLICE) return SLICE_GLOW_WIDTH_MUL;
  return tint === GLOW_TINT_CHANNEL ? CUT_GLOW_WIDTH_MUL : 1;
}

/** The halo strip's reach as a multiple of the tint's core. Pure. */
export function glowHaloMul(tint: number): number {
  return isKillCutTint(tint) ? CUT_HALO_CORE_MUL : GLOW_HALO_MUL;
}

/** The (simple glow) tint colour: C0 at the cut, C1 once hot. */
const TINT_C0: readonly number[] = [0, SLICE_PALE, 0xffffff];
const TINT_C1: readonly number[] = [0, HEAVY_BEAM_COLOR, 0xf4f2ff];

/** Blend `out.color` toward `tint`'s colour (C0 → C1 by `hot`, 0..1) by
 *  `heat` (1 = all tint, 0 = the base curve). */
function applyTint(out: WreckGlow, tint: number, hot: number, heat: number): void {
  if (!isKillCutTint(tint) || !(heat > 0)) return;
  const c = lerpColor(TINT_C0[tint]!, TINT_C1[tint]!, Math.min(1, Math.max(0, hot)));
  out.color = lerpColor(out.color, c, Math.min(1, heat));
}

/** The cut-edge glow `ageS` seconds after death (pure, alloc-free). `tint`
 *  (`glowTintOf`) picks the curve: a crack's molten orange, or a weapon's
 *  kill cut, held in its colour longer and brighter (`CUT_T/C/A`). Every
 *  curve ends dark at `WRECK_GLOW_END_S`. */
export function wreckGlowAt(ageS: number, out: WreckGlow, tint = GLOW_TINT_CRACK): WreckGlow {
  const T = CUT_T[tint] ?? GLOW_T, C = CUT_C[tint] ?? GLOW_C, A = CUT_A[tint] ?? GLOW_A;
  const last = T.length - 1;
  if (!(ageS < T[last]!)) { out.color = C[last]!; out.alpha = 0; return out; }
  if (ageS <= 0) { out.color = C[0]!; out.alpha = A[0]!; return out; }
  let i = 0;
  while (ageS > T[i + 1]!) i++;
  const t = (ageS - T[i]!) / (T[i + 1]! - T[i]!);
  out.color = lerpColor(C[i]!, C[i + 1]!, t);
  out.alpha = A[i]! + (A[i + 1]! - A[i]!) * t;
  return out;
}

/** The soft halo's alpha share (× the core's) for `tint` at `ageS`: only
 *  while the edge glows, so a cooled edge keeps just its thin scorch. */
export function haloShare(ageS: number, tint: number): number {
  const cut = isKillCutTint(tint);
  const a = cut ? CUT_HALO_A : 0.3;
  const from = cut ? CUT_HALO_FADE_FROM_S : HALO_FADE_FROM_S;
  const gone = cut ? CUT_HALO_GONE_S : HALO_GONE_S;
  return a * Math.max(0, Math.min(1, (gone - ageS) / (gone - from)));
}

// ── The simple glow (sub-capital) ─────────────────────────────────────────

/** The simple glow's curve over its life (0..1 of `fx.glowSeconds`): one
 *  warm orange, held, then fading through red to dark, the same for every
 *  kind. Hostile review 2026-11-13: squeezing the capital curve into 1 s
 *  gave a white flash, ~0.4 s of orange and a faint ember, and read as a
 *  different colour on different art. No white stage: the ship's own death
 *  explosion is the flash. Round 3 (2026-11-13): the review saw no red
 *  stage (0xc8400c read as dim orange), so the middle is now a clear red,
 *  still bright, before it cools to dark. */
const SIMPLE_T = [0, 0.3, 0.55, 0.7, 1];
const SIMPLE_C = [0xff8a2a, 0xff7a20, 0xe8200c, 0xb01808, 0x300804];
const SIMPLE_A = [1, 1, 0.9, 0.7, 0];

/** The simple glow at `frac` of its life (pure, alloc-free); `tint` as in
 *  `wreckGlowAt`, over the simple curve's orange and red stages. */
export function simpleGlowAt(frac: number, out: WreckGlow, tint = GLOW_TINT_CRACK): WreckGlow {
  const last = SIMPLE_T.length - 1;
  if (!(frac < 1)) { out.color = SIMPLE_C[last]!; out.alpha = 0; return out; }
  if (!(frac > 0)) {
    out.color = SIMPLE_C[0]!; out.alpha = SIMPLE_A[0]!;
    applyTint(out, tint, 0, 1);
    return out;
  }
  let i = 0;
  while (frac > SIMPLE_T[i + 1]!) i++;
  const t = (frac - SIMPLE_T[i]!) / (SIMPLE_T[i + 1]! - SIMPLE_T[i]!);
  out.color = lerpColor(SIMPLE_C[i]!, SIMPLE_C[i + 1]!, t);
  out.alpha = SIMPLE_A[i]! + (SIMPLE_A[i + 1]! - SIMPLE_A[i]!) * t;
  const heat = frac <= SIMPLE_TINT_HOLD ? 1 : (SIMPLE_TINT_GONE - frac) / (SIMPLE_TINT_GONE - SIMPLE_TINT_HOLD);
  applyTint(out, tint, frac / SIMPLE_TINT_HOT, heat);
  return out;
}
