/**
 * Base platforms — the deck floor's plating texture (`?deckTex=`), drawn into
 * the shared plate `GraphicsContext` of `structureDeckPlates.ts`.
 *
 * Not a texture system of its own: the detail is flat kit polygons (the
 * Machined style kit, `structureStyleKit.ts`: palette, `rng`, `strip`,
 * `stripe`, `ngon`) painted into the plate's one cached context, the same way
 * the rig parts paint kit polygons flat (`structureRigLook.ts`). Built once
 * per (look, variant); a plate is still ONE `Graphics`, only positioned.
 *
 * Looks: `plain` = the flat slice-14 floor; `a` (default) = hull plating,
 * each hex cut into three rhombus plates, each plate into four panels;
 * `b` = deck planking, hex-aligned planks with butt joints. Both: per-panel
 * tone, recessed panel lines, bolt heads, faint grime and scuffs, and a worn
 * hazard ring plus guide chevrons round the plate's middle hex (the
 * connector yard). Subtle on purpose: buildings, cables and ships stay on top.
 *
 * Variety without per-plate art: {@link DECK_VARIANTS} seeded contexts, and
 * each plate turned by a multiple of 60° (the 7-hex plate maps onto itself,
 * so seams and outline are unchanged). Both picked by a hash of (i, j).
 * No light direction is drawn (no bevel highlights), so a turned plate still
 * agrees with its neighbours.
 *
 * Pixi space (y down), plate centre hex at the origin.
 *
 * One geometry source (lit deck, `?deckLit=on`): the look is drawn as kit
 * `poly()` calls into a `StyleCtx` ({@link deckHexPolys}), each with its
 * material (panels: metal plate with a lift; grooves: lift < 0; bolts; the
 * hazard ring and chevrons: paint; wear: faint marks). The vector painter
 * ({@link drawDeckHexTexture}) fills those polygons flat, in order, exactly
 * as before; the lit bake (`structureDeckLitArt.ts`) stamps the same
 * polygons bar the yard paint, which the lit plate draws as crisp vector on
 * top (`part`, {@link DeckHexPart}): at the bake's ~2.4 u a texel its ends
 * stair-step.
 */
import type { GraphicsContext } from 'pixi.js';
import {
  HAZARD, RUST, SOOT, STENCIL, mixColor, ngon, poly, rng, strip, stripe, type PolyOp, type Pt, type Pts, type StyleCtx,
} from './structureStyleKit.js';

/** Deck floor look: `plain` (flat), `a` (hull plating), `b` (planking). */
export type DeckTex = 'plain' | 'a' | 'b';

/** The floor every player sees (owner look trial: `?deckTex=plain` = today). */
export const DEFAULT_DECK_TEX: DeckTex = 'a';

/** `?deckTex=plain|a|b`; absent or unknown = {@link DEFAULT_DECK_TEX}. */
export function readDeckTex(search: string): DeckTex {
  const m = /[?&]deckTex=(plain|a|b)\b/.exec(search);
  return m ? (m[1] as DeckTex) : DEFAULT_DECK_TEX;
}

/** Seeded plate contexts per textured look. */
export const DECK_VARIANTS = 3;

/** Panel tone range (fraction toward the light / dark tone). */
const TONE = 0.1;
const TONE_LIGHT = 0x46505d;
const TONE_DARK = 0x141920;
/** Recessed panel lines (world units; a deck hex is 1300 u flat to flat). */
const GROOVE = 0x1a1f27;
const GROOVE_MAJOR_W = 16;
const GROOVE_MINOR_W = 9;
const BOLT = 0x4a525d;
const BOLT_R = 11;

/** A plate's variant and its turn (multiples of 60°), from its lattice
 *  index. Deterministic, allocation-free. */
export function deckPlatePick(i: number, j: number): { variant: number; turns: number } {
  const h = hash2(i, j);
  return { variant: h % DECK_VARIANTS, turns: (h >>> 8) % 6 };
}

function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function flat(pts: Pts): number[] {
  const out: number[] = [];
  for (const [x, y] of pts) out.push(x, y);
  return out;
}

/** Materials (the lit bake reads them; the vector painter only the colour
 *  and alpha): lift and bevel in world units. */
const PANEL = { lift: 2, bevel: 4 } as const;
const GROOVE_CUT = { lift: -1.5, bevel: 2 } as const;
const BOLT_HEAD = { lift: 1.5, bevel: 3 } as const;
const PAINT = { lift: 0.2, bevel: 1 } as const;
const WEAR = { lift: 0, bevel: 0.5 } as const;

/** Emit one polygon (role `m`) into the plan. */
function put(c: StyleCtx, pts: Pts, color: number, mat: PolyOp['mat'], m: { lift: number; bevel: number }, alpha = 1): void {
  poly(c, pts, color, mat, m.lift, m.bevel, alpha === 1 ? undefined : { alpha });
}

/** A panel's tone: the deck fill nudged light or dark by a seeded amount. */
function tone(base: number, r: () => number): number {
  const t = (r() * 2 - 1) * TONE;
  return t >= 0 ? mixColor(base, TONE_LIGHT, t) : mixColor(base, TONE_DARK, -t);
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Look `a`: three rhombus plates per hex (centre to alternate corners), each
 *  cut 2×2 into panels; major grooves between plates, minor ones between
 *  panels; a bolt inset at each panel corner. */
function plating(c: StyleCtx, o: Pt, cs: Pts, base: number, r: () => number): void {
  const bolts: Pt[] = [];
  const grooves: Array<[Pt, Pt, number]> = [];
  for (let m = 0; m < 3; m++) {
    const a = cs[2 * m]!, b = cs[(2 * m + 2) % 6]!;
    // P(u, v) = o + u (a - o) + v (b - o); the far corner is P(1, 1).
    const P = (u: number, v: number): Pt => [o[0] + u * (a[0] - o[0]) + v * (b[0] - o[0]), o[1] + u * (a[1] - o[1]) + v * (b[1] - o[1])];
    for (let iu = 0; iu < 2; iu++) {
      for (let iv = 0; iv < 2; iv++) {
        const u0 = iu / 2, u1 = u0 + 0.5, v0 = iv / 2, v1 = v0 + 0.5;
        put(c, [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], tone(base, r), 'metal', PANEL);
        const k = 0.1; // bolt inset, fraction of the panel
        bolts.push(P(u0 + k * 0.5, v0 + k * 0.5), P(u1 - k * 0.5, v1 - k * 0.5));
        if (r() < 0.5) bolts.push(P(u1 - k * 0.5, v0 + k * 0.5), P(u0 + k * 0.5, v1 - k * 0.5));
      }
    }
    grooves.push([o, a, GROOVE_MAJOR_W], [P(0.5, 0), P(0.5, 1), GROOVE_MINOR_W], [P(0, 0.5), P(1, 0.5), GROOVE_MINOR_W]);
  }
  for (const [p, q, w] of grooves) put(c, strip(p, q, w), GROOVE, 'metal', GROOVE_CUT);
  for (const [x, y] of bolts) put(c, ngon(x, y, BOLT_R, 4), BOLT, 'metal', BOLT_HEAD);
}

/** Look `b`: planks across the hex (direction hex-aligned, seeded per hex),
 *  each with one butt joint; bolts either side of each joint. */
function planking(c: StyleCtx, o: Pt, cs: Pts, R: number, base: number, r: () => number): void {
  // Plank normal along a flat-to-flat axis: the hex spans exactly ±apothem there.
  const ang = Math.floor(r() * 3) * (Math.PI / 3);
  const nx = Math.cos(ang), ny = Math.sin(ang), tx = -ny, ty = nx;
  const apo = (R * Math.sqrt(3)) / 2;
  const n = 6, w = (2 * apo) / n;
  const off0 = nx * o[0] + ny * o[1];
  for (let k = 0; k < n; k++) {
    const off = off0 - apo + w * (k + 0.5);
    const plank = stripe(cs, ang, off, w);
    if (plank.length < 3) continue;
    // Butt joint across the plank at a seeded point along it.
    const along = (r() * 2 - 1) * apo * 0.5;
    const s0 = tx * o[0] + ty * o[1] + along;
    const near = stripe(plank, ang + Math.PI / 2, s0 - apo, 2 * apo);
    const far = stripe(plank, ang + Math.PI / 2, s0 + apo, 2 * apo);
    put(c, near, tone(base, r), 'metal', PANEL);
    put(c, far, tone(base, r), 'metal', PANEL);
    put(c, stripe(plank, ang + Math.PI / 2, s0, GROOVE_MINOR_W), GROOVE, 'metal', GROOVE_CUT);
    const cx = o[0] + nx * (off - off0) + tx * along, cy = o[1] + ny * (off - off0) + ty * along;
    for (const s of [-1, 1]) {
      for (const d of [-1, 1]) put(c, ngon(cx + tx * s * 34 + nx * d * w * 0.3, cy + ty * s * 34 + ny * d * w * 0.3, BOLT_R, 4), BOLT, 'metal', BOLT_HEAD);
    }
    if (k > 0) put(c, stripe(cs, ang, off - w / 2, GROOVE_MINOR_W), GROOVE, 'metal', GROOVE_CUT);
  }
}

/** Faint wear: two soot blotches and a scuff or two, inside the hex. */
function wear(c: StyleCtx, o: Pt, R: number, r: () => number): void {
  for (let k = 0; k < 2; k++) {
    const a = r() * Math.PI * 2, d = r() * R * 0.5, rad = R * (0.1 + 0.14 * r());
    const cx = o[0] + Math.cos(a) * d, cy = o[1] + Math.sin(a) * d;
    const blob: Pt[] = [];
    for (let p = 0; p < 7; p++) {
      const t = (p / 7) * Math.PI * 2, rr = rad * (0.65 + 0.35 * r());
      blob.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]);
    }
    put(c, blob, r() < 0.3 ? RUST : SOOT, 'mark', WEAR, 0.22);
  }
  const scuffs = 1 + Math.floor(r() * 2);
  for (let k = 0; k < scuffs; k++) {
    const a = r() * Math.PI * 2, d = r() * R * 0.55, dir = r() * Math.PI, len = R * (0.2 + 0.25 * r());
    const cx = o[0] + Math.cos(a) * d, cy = o[1] + Math.sin(a) * d;
    const dx = Math.cos(dir) * len * 0.5, dy = Math.sin(dir) * len * 0.5;
    put(c, strip([cx - dx, cy - dy], [cx + dx, cy + dy], 6 + r() * 8), SOOT, 'mark', WEAR, 0.25);
  }
}

/** The connector yard (the plate's middle hex): a worn hazard dash ring
 *  inset from the seams, and a guide chevron toward each neighbour hex. */
function yard(c: StyleCtx, o: Pt, cs: Pts, base: number, r: () => number): void {
  const hz = mixColor(HAZARD, base, 0.45);
  const guide = mixColor(STENCIL, base, 0.6);
  const inset = 0.88, band = 0.05; // fraction of the corner radius
  for (let k = 0; k < 6; k++) {
    const a0 = lerp(o, cs[k]!, inset), b0 = lerp(o, cs[(k + 1) % 6]!, inset);
    const a1 = lerp(o, cs[k]!, inset - band), b1 = lerp(o, cs[(k + 1) % 6]!, inset - band);
    for (let d = 0; d < 4; d++) {
      if (r() < 0.15) continue; // worn through
      const t0 = 0.06 + d * 0.23, t1 = t0 + 0.15;
      put(c, [lerp(a0, b0, t0), lerp(a0, b0, t1), lerp(a1, b1, t1), lerp(a1, b1, t0)], hz, 'paint', PAINT);
    }
    // Chevron pointing out through the middle of edge k.
    const mid = lerp(cs[k]!, cs[(k + 1) % 6]!, 0.5);
    const ux = (mid[0] - o[0]), uy = (mid[1] - o[1]), L = Math.hypot(ux, uy) || 1;
    const dx = ux / L, dy = uy / L, px = -dy, py = dx;
    const tip: Pt = [o[0] + dx * L * 0.62, o[1] + dy * L * 0.62];
    const h = L * 0.09, wd = L * 0.12, th = L * 0.035;
    const at = (s: number, q: number): Pt => [tip[0] - dx * s + px * q, tip[1] - dy * s + py * q];
    put(c, [at(0, 0), at(h, wd), at(h + th, wd), at(th, 0), at(h + th, -wd), at(h, -wd)], guide, 'mark', PAINT);
  }
}

/** Which polygons {@link deckHexPolys} emits: `all` (the vector plate),
 *  `floor` (all but the yard paint: the lit bake) or `paint` (the yard's
 *  hazard ring and chevrons alone: the lit plate's crisp vector overlay).
 *  `all` is exactly `floor` then `paint`, in order. */
export type DeckHexPart = 'all' | 'floor' | 'paint';

/**
 * One hex's floor (look `tex`, not `plain`) as kit polygons in `c`:
 * panels in place of the flat fill, then grooves, bolts and wear; the yard
 * markings (paint) on the middle hex, last. `o` = hex centre, `cs` = its
 * six corners (pixi space), `R` = corner radius, (q, r) = its axial offset
 * in the plate, seeding the look. `c.frame` must hold the whole hex.
 * `part`: {@link DeckHexPart} (every part makes the same seeded draws).
 */
export function deckHexPolys(
  c: StyleCtx, tex: Exclude<DeckTex, 'plain'>, variant: number,
  o: Pt, cs: Pts, R: number, q: number, r: number, base: number, part: DeckHexPart = 'all',
): void {
  const rand = rng(hash2(q * 31 + variant * 977 + 1, r * 17 + (tex === 'a' ? 3 : 7)));
  const n0 = c.polys.length;
  if (tex === 'a') plating(c, o, cs, base, rand);
  else planking(c, o, cs, R, base, rand);
  wear(c, o, R, rand);
  const n1 = c.polys.length;
  if (part !== 'floor' && q === 0 && r === 0) yard(c, o, cs, base, rand);
  if (part === 'paint') c.polys.splice(n0, n1 - n0);
}

/** A bare style ctx collecting one hex's polygons (cold). `frame`: the fit check's outline. */
export function deckStyleCtx(frame: Pts, seed = 1): StyleCtx {
  return {
    kindId: 'deck', styleId: 'c', W: 0, H: 0, accent: 0, seed, live: true, livery: false,
    polys: [], sigils: [], bands: [], lit: () => undefined, frame,
  };
}

/**
 * Paint one hex's floor (look `tex`, not `plain`) into `ctx`: the
 * polygons of {@link deckHexPolys}, filled flat in order (args as there).
 */
export function drawDeckHexTexture(
  ctx: GraphicsContext, tex: Exclude<DeckTex, 'plain'>, variant: number,
  o: Pt, cs: Pts, R: number, q: number, r: number, base: number,
): void {
  const c = deckStyleCtx(ngon(o[0], o[1], R * 1.25, 6));
  deckHexPolys(c, tex, variant, o, cs, R, q, r, base);
  for (const p of c.polys) {
    const a = p.alpha ?? 1;
    ctx.poly(flat(p.pts), true).fill(a === 1 ? { color: p.color } : { color: p.color, alpha: a });
  }
}
