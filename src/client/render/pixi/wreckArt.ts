/**
 * Capital destruction S3 — wreck art (docs/architecture/capital-destruction.md
 * "S3").
 *
 * **Texture continuity.** A wreck piece shows its own part of the dead ship's
 * baked Machined art, sampled at the piece's ORIGINAL hull-local coordinates,
 * so the pieces fit together like a jigsaw. No re-bake: the piece reuses the
 * parent kind's handle (`ArtService.ship(kind)`, the art the live hull drew).
 * A capital's art is tiled along the hull (one texture per `TILE_MAX_SIDE`
 * rows), so a piece is cut into one `Mesh` per tile it covers: its convex
 * parts are clipped to the tile's row band and fanned. Mesh UVs are
 * frame-relative, so the same geometry serves every sun frame (Pixi maps them
 * into the atlas page). All meshes batch (`batchMode: 'batch'`): a whole
 * wreck draws over at most its parent's tile textures.
 *
 * **Glowing cut edges.** Edges flagged as new cuts (`cutEdges`) get one glow
 * mesh whose colour and alpha per segment follow `wreckGlowAt` from that
 * segment's ignition (molten, an ember at ~1.8 s, dark at `WRECK_GLOW_END_S`
 * (4.5 s); the mesh is destroyed when the last crack is dark), drawn on the
 * piece's own side of each cut so an opening gap stays empty. The
 * original hull outline never glows. The clock is the wreck's death tick
 * from its descriptor (`deathTick`), so a late joiner sees it cool.
 *
 * **Cracks spread, then it breaks** (owner, 2026-11-13: "The instant split
 * feels a bit off"). The pieces hold together for `WRECK_CRACK_MS`; in that
 * window a crack front runs out from the kill point (`crackFrontAt`): each
 * cut-edge segment lights when the front reaches its near end and grows to
 * its far end, then cools from its own ignition on the glow curve. Small
 * blasts ripple along the cracks as the front passes (`WreckInfo.ripples`,
 * seeded from the wreck seed, capped by the effects tier). The glow is one
 * Mesh of quads on a tiny glow-curve texture: per frame only its positions
 * (while growing) and U coordinates (the age of each segment) are rewritten
 * in place.
 *
 * Everything here is built ONCE per piece; the per-frame work is a texture
 * pick and in-place scalar writes (invariant #14).
 *
 * **Profiles** (sub-capital break-up, slice 4). The wreck's `parentKind`
 * picks its destruction profile (`destructionProfileOf`), and its `fx` block
 * picks the look: a capital gets all of the above; a sub-capital (every other
 * ship, ~100× as frequent) gets no break-up burst, kill blasts, crack front
 * or ripples, and a SIMPLE glow: every cut lights at once, core only, dark by
 * `glowSeconds` (none at the minimal effects tier). A piece that has stopped
 * glowing does nothing per frame while its pose and the sun hold.
 */
import { BufferImageSource, Container, Geometry, Mesh, MeshGeometry, Texture } from 'pixi.js';
import { WRECK_CRACK_MS } from '../../../shared-types/wreckTiming.js';
import { LitShipMesh } from '../art/litShipShader.js';
import { litPass } from '../art/litPass.js';
import type { ShipArt } from '../art/ArtService.js';
import { sunFrameBlend, type SunBlend } from '../art/machinedShipLight.js';
import { buildWreckPieceGfx } from './spriteBuilders.js';
import { getShipKind, isShipKindId } from '../../../shared-types/shipKinds.js';
import { shipShapeScale } from '../../../core/geometry/shipHullOutline.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieces.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';
import { destructionProfileOf } from '../../../shared-types/shipScale/destructionProfile.js';
import type { DestructionFx, DestructionProfileId, WreckGlowStyle } from '../../../shared-types/shipScale/destruction.js';

/** Container + meshes (≤ 6 tiles) + one glow mesh (the crack strokes). */
export const WRECK_DISPLAY_OBJECTS_PER_PIECE_MAX = 8;

/** The cut edges are a dull ember here (s)... (money-shot review: it was
 *  still bright orange at 4.5 s; review 2026-11-13: still saturated orange
 *  ~3 s after the kill. Now white-hot only at the crack front, orange for
 *  about half a second, a red ember by ~2 s, dark by 4.5 s.) */
export const WRECK_GLOW_EMBER_S = 1.8;
/** ...and dark from here on (s); the glow stroke is then destroyed. */
export const WRECK_GLOW_END_S = 4.5;
/** A wreck first seen younger than this plays its break-up (dust, shards,
 *  flash); older ones (late joiners, a returning viewer) do not. */
export const WRECK_BREAK_FX_MAX_AGE_MS = 1500;
/** Game ms the crack front takes from the kill point to the farthest cut:
 *  most of the hold, so the last cracks are still white-hot at the split. */
export const WRECK_CRACK_FRONT_MS = Math.round(WRECK_CRACK_MS * 0.8);
/** Most ripple blasts one wreck gets (the `high` effects tier). */
export const WRECK_RIPPLE_MAX = 7;
/** A ripple blast's radius as a share of the wreck radius: clearly visible
 *  at capital zoom (review 2026-11-13: 0.022–0.04 were lost), still below
 *  the kill-point blast (`WRECK_BLAST_MAIN`, 0.09). */
export const WRECK_RIPPLE_R_MIN = 0.05;
export const WRECK_RIPPLE_R_MAX = 0.07;
/** Least game time between two ripples, so they read as a sequence along the
 *  cracks (review 2026-11-13 at 0.25×: two fired 30 ms apart and overlapped). */
export const WRECK_RIPPLE_GAP_MS = 110;
/** Share of the crack front's run spent inside the kill blast's reach
 *  (`WRECK_BLAST_REACH`). v7 cracks all lie within a beam or two of the kill
 *  point, so about half of them sit under the kill blast's fireball and
 *  flash: a front paced evenly over distance spent half its time where
 *  nothing showed (review 2026-11-13: "the first crack appears ~0.8 s after
 *  the kill, then spans the hull in ~0.1 s"). It races through the blast and
 *  spends the rest where it is seen. */
export const WRECK_FRONT_HIDDEN_SHARE = 0.2;
/** Glow widths as a share of the wreck radius (#18: a capital is drawn at
 *  ~0.17 zoom, so a fixed few units is under a pixel): the core, its soft
 *  halo, and the white-hot head racing along a growing crack. Each piece
 *  draws its half of the core and halo INSIDE its own outline (its broken
 *  face), so the two halves make the whole stroke while the hull holds and
 *  nothing is drawn in the gap once the pieces part (filmed take
 *  2026-11-13: the glow over an opening gap read as a thin dark sliver
 *  piece that then "faded away"). */
const GLOW_CORE_R = 0.018;
const GLOW_HALO_MUL = 3;
const GLOW_HEAD_MUL = 1.8;
/** The head's length along the crack (share of the wreck radius). */
const GLOW_HEAD_LEN_R = 0.06;
/** A ripple whose moment passed this long before its piece was drawn is
 *  dropped (a piece built late, e.g. once its art is ready). */
const RIPPLE_LATE_MS = 250;

/** Ripple blasts per wreck for an effects quality tier. */
export function wreckRippleCap(quality: string): number {
  return quality === 'high' ? WRECK_RIPPLE_MAX : quality === 'medium' ? 5 : quality === 'low' ? 3 : 0;
}
/** Server ticks per second (the descriptor's `deathTick` clock). */
const TICK_MS = 1000 / 60;

/** Burnt tint: near the kill point / far from it. Money-shot review: the old
 *  0x3a2c26 / 0x8c7e74 (23–55 % brightness) read as flat dark-grey slabs;
 *  the pieces should carry the hull art, slightly darkened. Hostile review
 *  2026-11-13: a NEAR of 0x9a8a80 still turned every middle piece of a
 *  mid-hull kill into a dark brown slab beside a normal bow and stern (a
 *  hard step at each cut, "lost their hull art"). The tint is per piece, so
 *  the near/far spread must stay small: the scorch is the glow's job. */
const BURNT_NEAR = 0xc4bab2;
const BURNT_FAR = 0xd2cac4;

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

function lerpColor(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/** The cut-edge glow `ageS` seconds after death (pure, alloc-free). */
export function wreckGlowAt(ageS: number, out: WreckGlow): WreckGlow {
  const last = GLOW_T.length - 1;
  if (!(ageS < GLOW_T[last]!)) { out.color = GLOW_C[last]!; out.alpha = 0; return out; }
  if (ageS <= 0) { out.color = GLOW_C[0]!; out.alpha = GLOW_A[0]!; return out; }
  let i = 0;
  while (ageS > GLOW_T[i + 1]!) i++;
  const t = (ageS - GLOW_T[i]!) / (GLOW_T[i + 1]! - GLOW_T[i]!);
  out.color = lerpColor(GLOW_C[i]!, GLOW_C[i + 1]!, t);
  out.alpha = GLOW_A[i]! + (GLOW_A[i + 1]! - GLOW_A[i]!) * t;
  return out;
}

// ── The glow as a texture (per-segment ageing) ────────────────────────────

/** Texels along the glow curve (U = age / WRECK_GLOW_END_S). */
const GLOW_TEX_W = 128;
/** Row centres: the bright core, the soft halo (alpha × 0.3). */
const V_CORE = 0.25;
const V_HALO = 0.75;
/** U of the last texel: dark (an unlit or cooled segment). */
const U_DARK = (GLOW_TEX_W - 0.5) / GLOW_TEX_W;
/** U of the first texel: white-hot (the crack front itself). */
const U_HOT = 0.5 / GLOW_TEX_W;

let _glowTex: Texture | null = null;

/** The glow curve baked into a 64×2 texture (row 0 core, row 1 halo), so a
 *  segment's colour and alpha follow from its U alone. Made once. */
export function wreckGlowTexture(): Texture {
  if (_glowTex !== null) return _glowTex;
  const data = new Uint8Array(GLOW_TEX_W * 2 * 4);
  const g: WreckGlow = { color: 0, alpha: 0 };
  for (let i = 0; i < GLOW_TEX_W; i++) {
    const ageS = (i / (GLOW_TEX_W - 1)) * WRECK_GLOW_END_S;
    wreckGlowAt(ageS, g);
    const halo = 0.3 * Math.max(0, Math.min(1, (HALO_GONE_S - ageS) / (HALO_GONE_S - HALO_FADE_FROM_S)));
    for (let row = 0; row < 2; row++) {
      const o = (row * GLOW_TEX_W + i) * 4;
      data[o] = (g.color >> 16) & 255;
      data[o + 1] = (g.color >> 8) & 255;
      data[o + 2] = g.color & 255;
      data[o + 3] = Math.round(255 * g.alpha * (row === 0 ? 1 : halo));
    }
  }
  _glowTex = new Texture({ source: new BufferImageSource({
    resource: data, width: GLOW_TEX_W, height: 2, alphaMode: 'premultiply-alpha-on-upload', scaleMode: 'linear',
  }) });
  return _glowTex;
}

/** U on the glow texture for a segment `ageS` seconds after it ignited
 *  (not yet ignited ⇒ the dark texel). Pure, alloc-free. */
export function glowU(ageS: number): number {
  if (!(ageS >= 0)) return U_DARK;
  return (0.5 + Math.min(1, ageS / WRECK_GLOW_END_S) * (GLOW_TEX_W - 1)) / GLOW_TEX_W;
}

// ── The simple glow (sub-capital) ─────────────────────────────────────────

/** The simple glow's curve over its life (0..1 of `fx.glowSeconds`): one
 *  warm orange, held, then fading through red to dark, the same for every
 *  kind. Hostile review 2026-11-13: squeezing the capital curve into 1 s
 *  gave a white flash, ~0.4 s of orange and a faint ember, and read as a
 *  different colour on different art. No white stage: the ship's own death
 *  explosion is the flash. */
const SIMPLE_T = [0, 0.4, 0.75, 1];
const SIMPLE_C = [0xff8a2a, 0xff7a20, 0xc8400c, 0x6a1c06];
const SIMPLE_A = [1, 0.95, 0.55, 0];

/** The simple glow at `frac` of its life (pure, alloc-free). */
export function simpleGlowAt(frac: number, out: WreckGlow): WreckGlow {
  const last = SIMPLE_T.length - 1;
  if (!(frac < 1)) { out.color = SIMPLE_C[last]!; out.alpha = 0; return out; }
  if (!(frac > 0)) { out.color = SIMPLE_C[0]!; out.alpha = SIMPLE_A[0]!; return out; }
  let i = 0;
  while (frac > SIMPLE_T[i + 1]!) i++;
  const t = (frac - SIMPLE_T[i]!) / (SIMPLE_T[i + 1]! - SIMPLE_T[i]!);
  out.color = lerpColor(SIMPLE_C[i]!, SIMPLE_C[i + 1]!, t);
  out.alpha = SIMPLE_A[i]! + (SIMPLE_A[i + 1]! - SIMPLE_A[i]!) * t;
  return out;
}

let _simpleGlowTex: Texture | null = null;

/** The simple glow's curve baked into a GLOW_TEX_W×1 texture (U = life
 *  fraction). Made once. */
export function wreckSimpleGlowTexture(): Texture {
  if (_simpleGlowTex !== null) return _simpleGlowTex;
  const data = new Uint8Array(GLOW_TEX_W * 4);
  const g: WreckGlow = { color: 0, alpha: 0 };
  for (let i = 0; i < GLOW_TEX_W; i++) {
    simpleGlowAt(i / (GLOW_TEX_W - 1), g);
    const o = i * 4;
    data[o] = (g.color >> 16) & 255;
    data[o + 1] = (g.color >> 8) & 255;
    data[o + 2] = g.color & 255;
    data[o + 3] = Math.round(255 * g.alpha);
  }
  _simpleGlowTex = new Texture({ source: new BufferImageSource({
    resource: data, width: GLOW_TEX_W, height: 1, alphaMode: 'premultiply-alpha-on-upload', scaleMode: 'linear',
  }) });
  return _simpleGlowTex;
}

/** U on the simple glow texture at `frac` of its life (clamped). */
export function simpleGlowU(frac: number): number {
  const f = frac > 0 ? Math.min(1, frac) : 0;
  return (0.5 + f * (GLOW_TEX_W - 1)) / GLOW_TEX_W;
}

// ── The crack front ───────────────────────────────────────────────────────

/** How far (hull frame, from the kill point) the crack front has run `tMs`
 *  GAME ms after death: the nearest cut at 0, the farthest at
 *  `WRECK_CRACK_FRONT_MS`. Distance is straight-line from the kill point, so
 *  the front is a ring spreading from the hit, lighting the cuts it crosses. */
export function crackFrontAt(info: CrackSpan, tMs: number): number {
  if (!(tMs >= 0)) return -Infinity;
  const k = Math.min(1, tMs / WRECK_CRACK_FRONT_MS);
  // Exactly the farthest crack at the end (the paced sum can round a hair
  // short and leave the last head running for ever).
  if (k >= 1) return info.crackReach;
  const iv = info.crackIv, C = info.crackCover ?? 0;
  if (iv === undefined || iv.length === 0 || !(C > 1e-6)) return info.crackMin + (info.crackReach - info.crackMin) * k;
  // Over the crack distances that hold a crack only: the front never idles
  // across a stretch with nothing to light (review 2026-11-13); and fast
  // through the kill blast, slow where it is seen.
  const want = coverAtShare(info, k);
  for (let i = 0; i < iv.length; i += 3) {
    const len = iv[i + 1]! - iv[i]!;
    if (iv[i + 2]! + len >= want) return iv[i]! + (want - iv[i + 2]!);
  }
  return info.crackReach;
}

/** When (game ms after the front started) the front reaches distance `d`. */
export function crackIgniteMs(info: CrackSpan, d: number): number {
  const iv = info.crackIv, C = info.crackCover ?? 0;
  if (iv !== undefined && iv.length > 0 && C > 1e-6) {
    return shareAtCover(info, Math.min(C, crackCoveredAt(iv, d))) * WRECK_CRACK_FRONT_MS;
  }
  const span = info.crackReach - info.crackMin;
  if (!(span > 1e-6)) return 0;
  return Math.max(0, Math.min(1, (d - info.crackMin) / span)) * WRECK_CRACK_FRONT_MS;
}

/** How much crack distance (the merged intervals) lies below distance `d`. */
export function crackCoveredAt(iv: Float64Array, d: number): number {
  let covered = 0;
  for (let i = 0; i < iv.length; i += 3) {
    if (d <= iv[i]!) break;
    covered = iv[i + 2]! + Math.min(d, iv[i + 1]!) - iv[i]!;
  }
  return covered;
}

/** The front's pacing: the covered crack distance it has run at share `k`
 *  (0..1) of its time. The stretch under the kill blast (`crackHidden`)
 *  takes `WRECK_FRONT_HIDDEN_SHARE` of the time, the rest the remainder. */
function coverAtShare(info: CrackSpan, k: number): number {
  const C = info.crackCover ?? 0, H = info.crackHidden ?? 0;
  if (!(H > 1e-6) || !(C - H > 1e-6)) return k * C;
  const S = WRECK_FRONT_HIDDEN_SHARE;
  return k <= S ? (k / S) * H : H + ((k - S) / (1 - S)) * (C - H);
}

/** Inverse of `coverAtShare`. */
function shareAtCover(info: CrackSpan, c: number): number {
  const C = info.crackCover ?? 0, H = info.crackHidden ?? 0;
  if (!(C > 1e-6)) return 0;
  if (!(H > 1e-6) || !(C - H > 1e-6)) return c / C;
  const S = WRECK_FRONT_HIDDEN_SHARE;
  return c <= H ? (c / H) * S : S + ((c - H) / (C - H)) * (1 - S);
}

/** What the front's clock needs: the crack distance range and, optionally,
 *  the merged intervals of crack distance that hold a crack and how much of
 *  them lies under the kill blast. */
export type CrackSpan = Pick<WreckInfo, 'crackMin' | 'crackReach'> & Partial<Pick<WreckInfo, 'crackIv' | 'crackCover' | 'crackHidden'>>;

/** The union of every cut segment's crack-distance interval, as triples
 *  (start, end, covered length before it), and the total covered length.
 *  Build-time only. */
export function crackIntervals(pieces: readonly WreckPieceGeometry[], kill: CutFrame): { iv: Float64Array; cover: number } {
  const raw: Array<[number, number]> = [];
  for (const p of pieces) forEachCut(p, kill, (_ax, _ay, _bx, _by, da, db) => { raw.push([Math.min(da, db), Math.max(da, db)]); });
  raw.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  let cover = 0;
  for (const [s, e] of raw) {
    const n = out.length;
    if (n > 0 && s <= out[n - 2]!) {
      if (e > out[n - 2]!) { cover += e - out[n - 2]!; out[n - 2] = e; }
      continue;
    }
    out.push(s, e, cover);
    cover += e - s;
  }
  return { iv: new Float64Array(out), cover };
}

/** Runs of consecutive cut edges as `[start, length]` (edge i runs outline[i]
 *  → outline[i+1]); a run wrapping past the end is one run. */
export function cutEdgeRuns(cutEdges: readonly boolean[]): Array<[number, number]> {
  const n = cutEdges.length;
  const out: Array<[number, number]> = [];
  let any = false;
  for (let i = 0; i < n; i++) if (cutEdges[i]) { any = true; break; }
  if (!any) return out;
  let all = true;
  for (let i = 0; i < n; i++) if (!cutEdges[i]) { all = false; break; }
  if (all) { out.push([0, n]); return out; }
  for (let i = 0; i < n; i++) {
    if (!cutEdges[i] || cutEdges[(i - 1 + n) % n]) continue; // not a run start
    let len = 0;
    while (cutEdges[(i + len) % n]) len++;
    out.push([i, len]);
  }
  return out;
}

// ── Texture mapping ───────────────────────────────────────────────────────

/** Where the parent's art sits: texels per world unit, tile rows, frame sizes. */
export interface WreckTexLayout {
  /** Hull art size in texels (one slice for GPU-lit maps). */
  w: number;
  h: number;
  tiles: number;
  tileH: number;
  density: number;
  /** Each tile texture's frame size (texels): UVs are frame-relative. */
  frameW: number;
  frameHs: number[];
}

/** The layout of a parent kind's baked art. */
export function wreckTexLayout(art: ShipArt): WreckTexLayout {
  const tiles = Math.max(1, art.tiles);
  const frameHs: number[] = [];
  for (let t = 0; t < tiles; t++) frameHs.push(art.frames[t]?.frame.height ?? art.tileH);
  return {
    w: art.w, h: art.h, tiles, tileH: art.tileH,
    // GPU-lit maps keep their texels per unit on `lit.ppu`.
    density: art.lit ? art.lit.ppu : art.density,
    frameW: art.frames[0]?.frame.width ?? art.w,
    frameHs,
  };
}

export interface WreckTileMesh {
  tile: number;
  /** Body-local, Pixi-down (x, −y about the piece centroid). */
  positions: Float32Array;
  /** Frame-relative UVs into the tile's texture. */
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Clip a ring (flat x,y) to `lo ≤ y ≤ hi` (Sutherland–Hodgman, convex in → convex out). */
function clipBand(src: number[], lo: number, hi: number): number[] {
  const once = (pts: number[], keep: (y: number) => boolean, edge: number): number[] => {
    const out: number[] = [];
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = pts[i * 2]!, ay = pts[i * 2 + 1]!;
      const j = (i + 1) % n;
      const bx = pts[j * 2]!, by = pts[j * 2 + 1]!;
      const ina = keep(ay), inb = keep(by);
      if (ina) out.push(ax, ay);
      if (ina !== inb) {
        const t = (edge - ay) / (by - ay);
        out.push(ax + (bx - ax) * t, edge);
      }
    }
    return out;
  };
  let pts = src;
  if (Number.isFinite(lo)) pts = once(pts, (y) => y >= lo, lo);
  if (pts.length >= 6 && Number.isFinite(hi)) pts = once(pts, (y) => y <= hi, hi);
  return pts;
}

/**
 * One mesh per art tile the piece covers (built once per piece). A vertex's
 * UV is its hull-local position mapped into the parent's art, so a point two
 * pieces share gets the same UV in both (the jigsaw fits). The first and last
 * tile bands are open-ended, so no part of the piece is ever dropped.
 */
export function wreckPieceMeshes(piece: WreckPieceGeometry, L: WreckTexLayout): WreckTileMesh[] {
  const out: WreckTileMesh[] = [];
  const d = L.density;
  for (let t = 0; t < L.tiles; t++) {
    // The tile's row band in body-local Pixi y (texel ty = (py − cy)·d + h/2).
    const rows = L.frameHs[t] ?? L.tileH;
    const lo = t === 0 ? -Infinity : (t * L.tileH - L.h / 2) / d + piece.cy;
    const hi = t === L.tiles - 1 ? Infinity : (t * L.tileH + rows - L.h / 2) / d + piece.cy;
    const pos: number[] = [];
    const idx: number[] = [];
    for (const part of piece.parts) {
      const ring: number[] = [];
      for (const v of part) ring.push(v.x, -v.y);
      const c = clipBand(ring, lo, hi);
      const n = c.length / 2;
      if (n < 3) continue;
      const base = pos.length / 2;
      for (let i = 0; i < c.length; i++) pos.push(c[i]!);
      for (let i = 1; i < n - 1; i++) idx.push(base, base + i, base + i + 1);
    }
    if (idx.length === 0) continue;
    const positions = new Float32Array(pos);
    const uvs = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 2) {
      const tx = (pos[i]! + piece.cx) * d + L.w / 2;
      const ty = (pos[i + 1]! - piece.cy) * d + L.h / 2 - t * L.tileH;
      uvs[i] = tx / L.frameW;
      uvs[i + 1] = ty / rows;
    }
    out.push({ tile: t, positions, uvs, indices: new Uint32Array(idx) });
  }
  return out;
}

// ── Per-wreck state (renderer-side) ───────────────────────────────────────

/** What every piece of one wreck shares. */
export interface WreckInfo {
  /** When the crack front started, on this renderer's clock: the death, or
   *  first sight for a wreck first seen inside its crack window
   *  (−Infinity ⇒ drawn cool). */
  deathMs: number;
  /** Bounding radius of the whole wreck about the old hull centre (world u). */
  hullR: number;
  /** Kill point, hull-local math-up, scaled (the frame piece centroids use). */
  killX: number;
  killY: number;
  /** The hull snapped cleanly in two. */
  snap: boolean;
  desc: WreckDescriptor;
  /** Nearest / farthest cut vertex from the kill point (hull frame): where
   *  the crack front starts and where it ends. */
  crackMin: number;
  crackReach: number;
  /** Crack distances that hold a crack (`crackIntervals`) and their total:
   *  the front's clock runs over these, skipping the empty stretches. */
  crackIv: Float64Array;
  crackCover: number;
  /** The part of `crackCover` within the kill blast's reach
   *  (`WRECK_BLAST_REACH` × `hullR`): the front races through it. */
  crackHidden: number;
  /** The front's distance at each crack vertex (absent ⇒ per-run). */
  crackD?: CrackDistances;
  /** The ripple blasts along the cracks (empty for a late joiner), each
   *  fired once by its piece's sprite (`rippleFired`). */
  ripples: WreckRipple[];
  rippleFired: Uint8Array;
  onRipple: WreckRippleSink | null;
  /** The parent kind's destruction profile and its effects. */
  profile: DestructionProfileId;
  fx: DestructionFx;
  /** The glow this wreck draws: the profile's style, or `none` for a
   *  `simple` glow at the minimal effects tier. */
  glow: WreckGlowStyle;
}

/** A wreck's profile, by its parent kind. */
function profileFor(desc: WreckDescriptor): { id: DestructionProfileId; fx: DestructionFx } {
  return destructionProfileOf({ type: 'ship', kindId: desc.parentKind });
}

/** One small blast on a crack: its piece, the point body-local (math-up),
 *  when the front reaches it (game ms after death) and its radius. */
export interface WreckRipple { piece: number; lx: number; ly: number; atMs: number; r: number }

/** Ripple sink: game-space centre and blast radius. */
export type WreckRippleSink = (x: number, y: number, r: number) => void;

const NO_RIPPLES: WreckRipple[] = [];
const NO_FIRED = new Uint8Array(0);
const NO_IV = new Float64Array(0);

/** The info of a wreck drawn without a death clock: cool, no cracks running. */
export function coolWreckInfo(desc: WreckDescriptor): WreckInfo {
  const p = profileFor(desc);
  return {
    deathMs: -Infinity, hullR: 0, killX: 0, killY: 0, snap: false, desc,
    crackMin: 0, crackReach: 0, crackIv: NO_IV, crackCover: 0, crackHidden: 0, ripples: NO_RIPPLES, rippleFired: NO_FIRED, onRipple: null,
    profile: p.id, fx: p.fx, glow: 'none',
  };
}

/** A small seeded PRNG (mulberry32): deterministic per wreck seed. */
function seededRandom(seed: number): () => number {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The ripple blasts of a fresh wreck: up to `count` points on the cut edges,
 * each with its whole fireball outside the kill blast (`WRECK_BLAST_REACH`;
 * review 2026-11-13: v7 cracks lie within a beam or two of the kill point,
 * and ripples "on the far 65 % of the cracks" all went off under the kill
 * fireball, unseen). They fire as the front passes them, at least
 * `WRECK_RIPPLE_GAP_MS` apart and spread over the front's run (two used to
 * fire 30 ms apart), each clear of the others. Chosen from the wreck seed
 * (every client sees the same). Runs once per wreck, at first sight.
 */
export function wreckRipples(
  pieces: readonly WreckPieceGeometry[],
  info: Pick<WreckInfo, 'killX' | 'killY' | 'hullR' | 'crackMin' | 'crackReach'> & Partial<Pick<WreckInfo, 'crackIv' | 'crackCover' | 'crackHidden'>>,
  seed: number, count: number,
): WreckRipple[] {
  const out: WreckRipple[] = [];
  if (count <= 0 || !(info.crackReach > info.crackMin)) return out;
  const rnd = seededRandom(seed);
  const clear = WRECK_BLAST_REACH * info.hullR;
  // Candidate sites: points along every cut segment whose ripple (at its
  // own radius) stays outside the kill blast, with the moment the front
  // reaches them. Both sides of a crack offer the same points; the spacing
  // below keeps one.
  const sites: WreckRipple[] = [];
  pieces.forEach((p, pi) => forEachCut(p, info, (ax, ay, bx, by, da, db) => {
    for (const f of RIPPLE_SITE_F) {
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
      const r = Math.max(6, info.hullR * (WRECK_RIPPLE_R_MIN + (WRECK_RIPPLE_R_MAX - WRECK_RIPPLE_R_MIN) * rnd()));
      if (Math.hypot(x - info.killX, y - info.killY) - r < clear) continue;
      sites.push({ piece: pi, lx: x - p.cx, ly: y - p.cy, atMs: crackIgniteMs(info, da + (db - da) * f), r });
    }
  }));
  if (sites.length === 0) return out;
  sites.sort((a, b) => a.atMs - b.atMs);
  const t0 = sites[0]!.atMs, t1 = sites[sites.length - 1]!.atMs;
  const n = Math.min(count, Math.floor((t1 - t0) / WRECK_RIPPLE_GAP_MS) + 1);
  // One per equal stretch of the front's visible run, at the site nearest
  // a seeded moment in that stretch, spaced in time and on the hull.
  for (let k = 0; k < n; k++) {
    const want = t0 + ((k + 0.25 + 0.5 * rnd()) / n) * (t1 - t0);
    let best: WreckRipple | null = null;
    for (const s of sites) {
      if (best !== null && Math.abs(s.atMs - want) >= Math.abs(best.atMs - want)) continue;
      let ok = true;
      for (const o of out) {
        const po = pieces[o.piece]!, ps = pieces[s.piece]!;
        const apart = Math.hypot(ps.cx + s.lx - po.cx - o.lx, ps.cy + s.ly - po.cy - o.ly);
        if (Math.abs(s.atMs - o.atMs) < WRECK_RIPPLE_GAP_MS || apart < 0.35 * (s.r + o.r)) { ok = false; break; }
      }
      if (ok) best = s;
    }
    if (best !== null) out.push(best);
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/** Where along a cut segment a ripple may sit. */
const RIPPLE_SITE_F = [0.25, 0.5, 0.75];

/**
 * Each cut edge of a piece in the hull frame (edge `i` runs outline[i] →
 * outline[i+1]), with each end's CRACK distance: how far the front has
 * run when it gets there. The front reaches a crack (a run of cut edges) at
 * its end nearer the kill point, at the straight-line distance, then runs
 * ALONG the crack, so a crack across the hull is crossed by a travelling
 * head rather than lit all at once (review 2026-11-13: "no visible moving
 * front"). With the wreck's `crackD` (every wreck the renderer draws), the
 * distances come from the whole crack network, so both sides of a crack
 * light together; without it, from this piece's own runs. Build-time only.
 */
function forEachCut(
  p: WreckPieceGeometry, kill: CutFrame,
  fn: (ax: number, ay: number, bx: number, by: number, da: number, db: number, edge: number) => void,
): void {
  const o = p.outline, n = o.length;
  const X = (i: number): number => o[i % n]!.x + p.cx;
  const Y = (i: number): number => o[i % n]!.y + p.cy;
  const D = kill.crackD;
  if (D !== undefined) {
    for (let i = 0; i < n; i++) {
      if (!p.cutEdges[i]) continue;
      fn(X(i), Y(i), X(i + 1), Y(i + 1), D.at(X(i), Y(i)), D.at(X(i + 1), Y(i + 1)), i);
    }
    return;
  }
  for (const [start, len] of cutEdgeRuns(p.cutEdges)) {
    const d0 = Math.hypot(X(start) - kill.killX, Y(start) - kill.killY);
    const d1 = Math.hypot(X(start + len) - kill.killX, Y(start + len) - kill.killY);
    let total = 0;
    for (let k = 0; k < len; k++) total += Math.hypot(X(start + k + 1) - X(start + k), Y(start + k + 1) - Y(start + k));
    // Path distance from the run's start; reversed when the far end is nearer.
    let acc = 0;
    for (let k = 0; k < len; k++) {
      const i = start + k;
      const seg = Math.hypot(X(i + 1) - X(i), Y(i + 1) - Y(i));
      const da = d0 <= d1 ? d0 + acc : d1 + (total - acc);
      const db = d0 <= d1 ? d0 + acc + seg : d1 + (total - acc - seg);
      fn(X(i), Y(i), X(i + 1), Y(i + 1), da, db, i % n);
      acc += seg;
    }
  }
}

/** The kill point (hull frame) and, optionally, the wreck's crack network. */
export type CutFrame = Pick<WreckInfo, 'killX' | 'killY'> & { crackD?: CrackDistances };

/**
 * How far the crack front has run when it reaches each vertex of the crack
 * network (every piece's cut edges, joined where pieces share a vertex). The
 * front enters each crack where it meets the hull's own outline, at the
 * straight-line distance from the kill point (the primary line and the fan
 * cracks start AT the kill point: 0), and runs along the cracks from there,
 * through T-junctions (Dijkstra). Both sides of a crack get the same
 * distances: the per-run distances lit one side of a zone crack ~0.5 s
 * after the other (a fan crack ending on it made the runs differ).
 * Build-time only (once per wreck).
 */
export class CrackDistances {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly d: number[] = [];
  private readonly grid = new Map<number, number[]>();

  constructor(pieces: readonly WreckPieceGeometry[], killX: number, killY: number) {
    const adj: number[][] = [];
    const seed: boolean[] = [];
    for (const p of pieces) {
      const o = p.outline, n = o.length;
      for (let i = 0; i < n; i++) {
        const a = this.vertex(o[i]!.x + p.cx, o[i]!.y + p.cy, adj, seed);
        const b = this.vertex(o[(i + 1) % n]!.x + p.cx, o[(i + 1) % n]!.y + p.cy, adj, seed);
        if (!p.cutEdges[i]) { seed[a] = true; seed[b] = true; continue; }
        if (a === b) continue;
        adj[a]!.push(b);
        adj[b]!.push(a);
      }
    }
    const V = this.xs.length;
    const done: boolean[] = new Array(V).fill(false);
    const straight = (v: number): number => Math.hypot(this.xs[v]! - killX, this.ys[v]! - killY);
    for (let v = 0; v < V; v++) this.d.push(Infinity);
    // Each connected crack system is entered once: at its outline vertex
    // nearest the kill point (the kill point itself for the system holding
    // the primary line), so the front runs ALONG it from there.
    const comp: number[] = new Array(V).fill(-1);
    for (let v0 = 0; v0 < V; v0++) {
      if (comp[v0] !== -1 || adj[v0]!.length === 0) continue;
      const stack = [v0];
      comp[v0] = v0;
      let entry = -1;
      let any = v0;
      while (stack.length > 0) {
        const u = stack.pop()!;
        if (seed[u] && (entry < 0 || straight(u) < straight(entry))) entry = u;
        if (straight(u) < straight(any)) any = u;
        for (const w of adj[u]!) if (comp[w] === -1) { comp[w] = v0; stack.push(w); }
      }
      const e = entry >= 0 ? entry : any;
      this.d[e] = straight(e);
    }
    for (;;) {
      let u = -1;
      for (let v = 0; v < V; v++) if (!done[v] && this.d[v]! < Infinity && (u < 0 || this.d[v]! < this.d[u]!)) u = v;
      if (u < 0) break;
      done[u] = true;
      for (const w of adj[u]!) {
        const nd = this.d[u]! + Math.hypot(this.xs[w]! - this.xs[u]!, this.ys[w]! - this.ys[u]!);
        if (nd < this.d[w]!) this.d[w] = nd;
      }
    }
    // A crack the outline never touches (none in v7): straight-line distance.
    for (let v = 0; v < V; v++) if (this.d[v] === Infinity) this.d[v] = Math.hypot(this.xs[v]! - killX, this.ys[v]! - killY);
  }

  /** The front's distance at hull-frame point (x, y): its network vertex,
   *  else the straight-line distance (not a crack vertex). */
  at(x: number, y: number): number {
    const v = this.find(x, y);
    return v >= 0 ? this.d[v]! : Infinity;
  }

  private find(x: number, y: number): number {
    const cx = Math.floor(x), cy = Math.floor(y);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = this.grid.get((cx + i) * 1_000_003 + (cy + j));
      if (cell === undefined) continue;
      for (const v of cell) if (Math.abs(this.xs[v]! - x) <= VERTEX_EPS && Math.abs(this.ys[v]! - y) <= VERTEX_EPS) return v;
    }
    return -1;
  }

  private vertex(x: number, y: number, adj: number[][], seed: boolean[]): number {
    const f = this.find(x, y);
    if (f >= 0) return f;
    const v = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    adj.push([]);
    seed.push(false);
    const key = Math.floor(x) * 1_000_003 + Math.floor(y);
    const cell = this.grid.get(key);
    if (cell === undefined) this.grid.set(key, [v]);
    else cell.push(v);
    return v;
  }
}

/** Two pieces' copies of one hull vertex differ only by float rounding (the
 *  outlines are centroid-relative); anything this close is one vertex. */
const VERTEX_EPS = 0.05;

// ── The break-up blast ────────────────────────────────────────────────────

/** One FxExplosions blast: game-space centre and blast radius. */
export interface WreckBlast { x: number; y: number; r: number }

/** The main fireball's radius as a share of the wreck radius (#18: a heavy
 *  cruiser's ~260 u, a battleship's ~350 u), and the two smaller ones beside
 *  it. FxExplosions draws a blast of radius r as a 2r fireball under a soft
 *  3.4r glow, so every blast stays within ~0.25 of the wreck radius of the
 *  kill point: a fireball where the hull broke, never one over the hull.
 *  Owner decision 2026-11-13 ("smaller kill blast"): the cracks and the
 *  ripples hid under the old 0.12 / 0.065 at 0.09 (reach 0.165), so the
 *  fireballs shrank to about half the area they cover (reach 0.112); the
 *  flash at the hit stays bright. */
export const WRECK_BLAST_MAIN = 0.09;
export const WRECK_BLAST_SUB = 0.045;
export const WRECK_BLAST_SUB_OFFSET = 0.06;
/** How long the kill blast's smoke hangs, as a share of an ordinary death's
 *  (FxExplosions `linger`): it lifts by ~1.1 s instead of ~2.1 s, so the
 *  cracks are not under it for long. */
export const WRECK_BLAST_LINGER = 0.5;
/** How far the kill blast's fireballs and smoke cover the hull (share of the
 *  wreck radius): the two side blasts reach 0.06 + 1.15 × 0.045, past the
 *  main fireball and its secondary fireballs (1.15 × 0.09; FxExplosions
 *  draws a blast of radius r as a 2r flipbook with secondaries 0.55r out,
 *  and the shortened smoke stays within ~1.1r). The break-up's dust stays
 *  inside it too (`WreckBreakFx`). Its flash reaches further but is gone in
 *  0.3 s. The crack front hurries through this stretch; ripples go outside. */
export const WRECK_BLAST_REACH = Math.max(1.15 * WRECK_BLAST_MAIN, WRECK_BLAST_SUB_OFFSET + 1.15 * WRECK_BLAST_SUB);

/**
 * The fireballs of a break-up at the kill point (game space): one main blast
 * and two smaller ones a little off it, their directions from the wreck's
 * seed (deterministic, so every client sees the same). Writes into `out`
 * (grown once); returns how many. Runs once per wreck.
 */
export function wreckBlasts(x: number, y: number, radius: number, seed: number, out: WreckBlast[]): number {
  const R = Math.max(20, radius);
  while (out.length < 3) out.push({ x: 0, y: 0, r: 0 });
  out[0]!.x = x; out[0]!.y = y; out[0]!.r = R * WRECK_BLAST_MAIN;
  const a0 = ((seed >>> 0) % 6283) / 1000;
  for (let i = 1; i < 3; i++) {
    const a = a0 + i * 2.4;
    const b = out[i]!;
    b.x = x + Math.cos(a) * R * WRECK_BLAST_SUB_OFFSET;
    b.y = y + Math.sin(a) * R * WRECK_BLAST_SUB_OFFSET;
    b.r = R * WRECK_BLAST_SUB;
  }
  return 3;
}

/**
 * True when a dying ship's own death blast is left to the wreck break-up:
 * the room breaks capitals into wrecks (welcome `capitalWrecks`) and the
 * dying sprite is a capital. #493's hull-sized blast (radius ≈ the hull)
 * otherwise covers the whole hull exactly when it breaks (money-shot
 * review); the break-up's fireballs at the kill point replace it. With the
 * dying kind given, its destruction profile must say so too
 * (`fx.hullDeathBlastReplaced`): a sub-capital's wreck never replaces the
 * ship's normal death explosion (sub-capital break-up, slice 4).
 */
export function hullDeathBlastReplaced(capitalWrecks: boolean | undefined, dyingIsCapital: boolean, dyingKind?: string | null): boolean {
  if (capitalWrecks !== true || !dyingIsCapital) return false;
  return dyingKind == null || destructionProfileOf({ type: 'ship', kindId: dyingKind }).fx.hullDeathBlastReplaced;
}

/**
 * The ship's normal death explosion, scaled by its destruction profile
 * (`fx.deathBlastScale` radius, `fx.deathBlastLinger` smoke) while the room
 * breaks that profile into wrecks: a sub-capital with welcome `subcapWrecks`
 * (owner 2026-11-13, "Shrink it": ~half size, shorter smoke, so the break-up
 * and the fight stay readable and capitals feel bigger). Everything else,
 * and every death with the flag off, is 1 / 1 (unchanged). Alloc-free.
 */
export function deathBlastFor(
  subcapWrecks: boolean | undefined, capitalWrecks: boolean | undefined, kind: string | null | undefined,
  out: { scale: number; linger: number },
): { scale: number; linger: number } {
  out.scale = 1;
  out.linger = 1;
  if (typeof kind !== 'string' || !isShipKindId(kind)) return out;
  const p = destructionProfileOf({ type: 'ship', kindId: kind });
  const on = p.id === 'subcap' ? subcapWrecks === true : p.id === 'capital' ? capitalWrecks === true : false;
  if (!on) return out;
  out.scale = p.fx.deathBlastScale;
  out.linger = p.fx.deathBlastLinger;
  return out;
}

/** Break-up sink: kill point (game space), wreck radius, clean snap, seed,
 *  and the wreck's effects (the sink plays only the parts `fx` asks for:
 *  `breakBurst`, `killBlasts`). */
export type WreckBreakSink = (x: number, y: number, radius: number, snap: boolean, seed: number, fx: DestructionFx) => void;

/**
 * Renderer-side state of each wreck in view: when it died (on this
 * renderer's clock) and whether its break-up was played. Created once per
 * wreck (a death event), dropped when the mirror stops listing it.
 */
export class WreckArtState {
  private readonly byId = new Map<number, WreckInfo>();

  /**
   * @param onBreak the break-up at the kill point (once per fresh wreck).
   * @param onRipple a small blast on a crack (a few per fresh wreck).
   * @param rippleCap ripples per wreck for the current effects tier.
   * @param quality the current effects tier (a `simple` glow is dropped at
   *   `minimal`).
   */
  constructor(
    public onBreak: WreckBreakSink | null = null,
    public onRipple: WreckRippleSink | null = null,
    private readonly rippleCap: () => number = () => WRECK_RIPPLE_MAX,
    private readonly quality: () => string = () => 'high',
  ) {}

  /**
   * The wreck's shared info. On first sight, its death time is placed on the
   * render clock from the descriptor's `deathTick` and the piece's latest
   * server tick, and a fresh wreck fires its break-up at the kill point
   * (located from this piece's pose: its centroid in the hull frame is known).
   */
  infoFor(
    desc: WreckDescriptor, pieces: readonly WreckPieceGeometry[], pieceIndex: number,
    pose: { x: number; y: number; angle: number }, serverTick: number, nowMs: number,
  ): WreckInfo {
    const prev = this.byId.get(desc.wreckId);
    if (prev !== undefined && prev.desc.seed === desc.seed && prev.desc.parentKind === desc.parentKind
      && prev.desc.killX === desc.killX && prev.desc.killY === desc.killY) return prev;
    const prof = profileFor(desc);
    const fx = prof.fx;
    const s = shipShapeScale(getShipKind(desc.parentKind));
    let hullR = 0;
    for (const p of pieces) hullR = Math.max(hullR, Math.hypot(p.cx, p.cy) + p.radius);
    const ageMs = desc.deathTick !== undefined ? Math.max(0, serverTick - desc.deathTick) * TICK_MS : Infinity;
    // The client first draws a wreck 0.1–0.5 s after the death (its
    // descriptor arrives late): anchored at the death, most of the crack
    // front had already run and every crack lit at once (review 2026-11-13).
    // A wreck first seen inside its crack window starts the front (and the
    // glow's clock) at first sight, so the whole spread is always seen. Late
    // joiners keep their true age (cool, no front). A wreck with no front
    // (sub-capital) does the same within its short glow.
    const freshMs = fx.crackFront ? WRECK_CRACK_MS : fx.glowSeconds * 1000;
    const crackAgeMs = ageMs < freshMs ? 0 : ageMs;
    // A simple glow is an extra; the minimal effects tier drops it. A
    // capital's full glow is the break-up itself and always draws.
    const glow: WreckGlowStyle = fx.glowStyle === 'simple' && this.quality() === 'minimal' ? 'none' : fx.glowStyle;
    const info: WreckInfo = {
      deathMs: nowMs - crackAgeMs, hullR, killX: desc.killX * s, killY: -desc.killY * s, snap: pieces.length <= 2, desc,
      crackMin: Infinity, crackReach: 0, crackIv: NO_IV, crackCover: 0, crackHidden: 0,
      ripples: NO_RIPPLES, rippleFired: NO_FIRED, onRipple: this.onRipple,
      profile: prof.id, fx, glow,
    };
    if (fx.crackFront) {
      info.crackD = new CrackDistances(pieces, info.killX, info.killY);
      for (const p of pieces) forEachCut(p, info, (_ax, _ay, _bx, _by, da, db) => {
        info.crackMin = Math.min(info.crackMin, da, db);
        info.crackReach = Math.max(info.crackReach, da, db);
      });
    }
    if (!(info.crackMin <= info.crackReach)) { info.crackMin = 0; info.crackReach = 0; }
    else {
      const { iv, cover } = crackIntervals(pieces, info);
      info.crackIv = iv;
      info.crackCover = cover;
      info.crackHidden = Math.min(cover, crackCoveredAt(iv, WRECK_BLAST_REACH * hullR));
    }
    // Ripples only for a wreck seen inside its crack window (late joiners:
    // none); they fire as the front (from first sight) passes them.
    if (fx.ripples && ageMs < WRECK_CRACK_MS && this.onRipple !== null) {
      info.ripples = wreckRipples(pieces, info, desc.seed, Math.min(WRECK_RIPPLE_MAX, this.rippleCap()));
      info.rippleFired = new Uint8Array(info.ripples.length);
    }
    this.byId.set(desc.wreckId, info);
    const g = pieces[pieceIndex];
    if ((fx.breakBurst || fx.killBlasts) && ageMs < WRECK_BREAK_FX_MAX_AGE_MS && g !== undefined && this.onBreak !== null) {
      const dx = info.killX - g.cx, dy = info.killY - g.cy;
      const c = Math.cos(pose.angle), sn = Math.sin(pose.angle);
      this.onBreak(pose.x + dx * c - dy * sn, pose.y + dx * sn + dy * c, hullR, info.snap, desc.seed, fx);
    }
    return info;
  }

  /** Forget wrecks the mirror no longer lists (allocation-free). */
  retain(live: ReadonlyMap<number, unknown>): void {
    if (this.byId.size <= live.size) return;
    for (const id of this.byId.keys()) if (!live.has(id)) this.byId.delete(id);
  }

  clear(): void { this.byId.clear(); }

  size(): number { return this.byId.size; }
}

// ── The piece sprite ──────────────────────────────────────────────────────

/** A piece's burnt tint: slightly darker than the live hull, darkest where
 *  the killing blow landed. */
export function burntTint(piece: Pick<WreckPieceGeometry, 'cx' | 'cy'>, info: Pick<WreckInfo, 'killX' | 'killY' | 'hullR'>): number {
  const near = Math.hypot(info.killX - piece.cx, info.killY - piece.cy) / Math.max(1, info.hullR);
  return lerpColor(BURNT_NEAR, BURNT_FAR, Math.min(1, near * 1.6));
}

/**
 * A lit tile piece's geometry for `LitShipMesh`: positions in the hull's
 * frame (Pixi-down, world units, hull centre at 0: the frame the lit shader
 * lights in), UVs on the tile texture's atlas page (the lit shader samples
 * the page directly, slice A at these UVs and slices B/C beside it).
 */
export function litPieceGeometry(m: WreckTileMesh, tex: Texture, piece: Pick<WreckPieceGeometry, 'cx' | 'cy'>): Geometry {
  const f = tex.frame;
  const PW = tex.source.width, PH = tex.source.height;
  const pos = new Float32Array(m.positions.length);
  const uv = new Float32Array(m.uvs.length);
  for (let i = 0; i < pos.length; i += 2) {
    pos[i] = m.positions[i]! + piece.cx;
    pos[i + 1] = m.positions[i + 1]! - piece.cy;
    uv[i] = (f.x + m.uvs[i]! * f.width) / PW;
    uv[i + 1] = (f.y + m.uvs[i + 1]! * f.height) / PH;
  }
  return new Geometry({ attributes: { aPosition: pos, aUV: uv }, indexBuffer: m.indices });
}

const _glow: WreckGlow = { color: 0, alpha: 0 };
const _blend: SunBlend = { j0: 0, j1: 0, t: 0 };

/**
 * One wreck piece: the parent's art on one Mesh per tile (or, before the art
 * is ready / in the classic look, today's plain polygon), plus one glow
 * stroke on its cut edges while they are hot. Positioned and rotated by the
 * swarm updater like any sprite; `update` once per frame after that.
 */
export class WreckPieceSprite extends Container {
  private readonly meshes: Mesh[] = [];
  private readonly meshTile: number[] = [];
  private glow: Mesh | null = null;
  private glowGeom: MeshGeometry | null = null;
  /** Per cut segment (`SEG_STRIDE` floats) and outline edge → segment. */
  private seg = new Float64Array(0);
  private edgeSeg = new Int32Array(0);
  private segN = 0;
  private halfCore = 0;
  private halfHalo = 0;
  private halfHead = 0;
  private halfHeadHalo = 0;
  private headLen = 0;
  /** White-hot heads drawn at the last update (cracks still growing). */
  private heads = 0;
  /** The front has passed every cut: positions are final. */
  private grown = false;
  /** Game ms after death when the last crack is dark. */
  private glowEndMs = 0;
  /** Game ms since death at the last update. */
  private lastT = -Infinity;
  private sunFrame = -1;
  /** GPU-lit meshes (lit art only). */
  private litMeshes = 0;
  /** A simple glow (sub-capital): every cut lit at once, core only, one U
   *  for all of it on its own warm curve (`simpleGlowAt`), dark by
   *  `fx.glowSeconds`. */
  private simple = false;
  private lastU = -1;
  /** The art (meshes, or the plain polygon) the dead tint goes on. */
  private readonly artParts: Container[] = [];
  /** The pose and sun at the last update that did any work: a piece with no
   *  glow and no pending ripple skips the frame while both hold. */
  private lastRot = NaN;
  private lastSunAz = NaN;
  private ripplesDone = false;
  /** Light-frame swaps and glow buffer uploads so far (tests/diagnostics). */
  private writes = 0;

  constructor(
    piece: WreckPieceGeometry, parentKind: string, readonly art: ShipArt | null, readonly info: WreckInfo,
    /** This piece's index in its wreck (its ripples). */
    readonly pieceIndex = 0,
  ) {
    super();
    const settings = litPass.settings;
    if (art !== null && art.lit !== undefined && settings !== null) {
      // GPU-lit art (the player's default look): the frames are data pages
      // of UNLIT maps (albedo, normals, emission). Only the lit shader turns
      // them into a lit hull, so each tile piece is a LitShipMesh carrying
      // this piece's geometry in the HULL's frame (the shader lights by
      // hull-local position), offset back to the piece's centroid.
      const L = wreckTexLayout(art);
      const lit = art.lit;
      const tint = burntTint(piece, info);
      for (const m of wreckPieceMeshes(piece, L)) {
        const tex = art.frames[m.tile]!;
        const mesh = new LitShipMesh({ tex, w: lit.w, rows: tex.frame.height, y0: m.tile * art.tileH, hullH: lit.h, ppu: lit.ppu, maxH: lit.maxH, emisMax: lit.emisMax }, settings);
        mesh.geometry = litPieceGeometry(m, tex, piece);
        mesh.position.set(-piece.cx, piece.cy);
        mesh.capitalHull = true;
        mesh.tint = tint;
        this.addChild(mesh);
        litPass.register(mesh);
        this.litMeshes++;
        this.artParts.push(mesh);
      }
    } else if (art !== null && art.lit === undefined) {
      const L = wreckTexLayout(art);
      const tint = burntTint(piece, info);
      for (const m of wreckPieceMeshes(piece, L)) {
        const geometry = new MeshGeometry({ positions: m.positions, uvs: m.uvs, indices: m.indices });
        geometry.batchMode = 'batch'; // > 100 vertices still joins the batch
        const mesh = new Mesh({ geometry, texture: art.frames[m.tile]! });
        mesh.tint = tint;
        this.addChild(mesh);
        this.meshes.push(mesh);
        this.meshTile.push(m.tile);
        this.artParts.push(mesh);
      }
    } else {
      this.artParts.push(this.addChild(buildWreckPieceGfx(piece.outline, parentKind)));
    }
    // The glow: cut edges only, one Mesh of quads (a soft halo under a bright
    // core per cut segment) on the glow-curve texture. A wreck already cool
    // when first seen never gets one, nor one whose profile (or tier) has none.
    if (info.deathMs > -Infinity && info.glow !== 'none') {
      this.simple = info.glow === 'simple';
      this.buildGlow(piece);
    }
    // No glow (late joiner, minimal tier, no cut on this piece): dead at once.
    if (this.glow === null) this.applyDeadTint();
    let pending = 0;
    for (const r of info.ripples) if (r.piece === pieceIndex) pending++;
    this.ripplesDone = pending === 0;
  }

  /** Build the cut-edge glow once: each cut segment's ends (Pixi-down,
   *  body-local) ordered from the kill point, their crack distances and
   *  when it ignites. Every quad starts collapsed and dark. */
  private buildGlow(piece: WreckPieceGeometry): void {
    const o = piece.outline, n = o.length, info = this.info;
    let S = 0;
    for (let i = 0; i < n; i++) if (piece.cutEdges[i]) S++;
    if (S === 0) return;
    this.edgeSeg = new Int32Array(n).fill(-1);
    this.seg = new Float64Array(S * SEG_STRIDE);
    // Widths follow the wreck's size (#18), so the cracks read at capital zoom.
    const core = Math.min(120, Math.max(4, info.hullR * GLOW_CORE_R));
    this.halfCore = core / 2;
    this.halfHalo = (core * GLOW_HALO_MUL) / 2;
    this.halfHead = (core * GLOW_HEAD_MUL) / 2;
    this.halfHeadHalo = (core * GLOW_HEAD_MUL * GLOW_HALO_MUL) / 2;
    this.headLen = Math.max(core * 2, info.hullR * GLOW_HEAD_LEN_R);
    let k = 0;
    forEachCut(piece, info, (hax, hay, hbx, hby, da, db, edge) => {
      // Body-local, math-up; then stored Pixi-down.
      const ax = hax - piece.cx, ay = hay - piece.cy, bx = hbx - piece.cx, by = hby - piece.cy;
      const fwd = da <= db;
      const nx = fwd ? ax : bx, ny = fwd ? ay : by, fx = fwd ? bx : ax, fy = fwd ? by : ay;
      const dn = fwd ? da : db, df = fwd ? db : da;
      const len = Math.hypot(fx - nx, fy - ny);
      const s = this.seg, q = k * SEG_STRIDE;
      s[q] = nx; s[q + 1] = -ny; s[q + 2] = fx; s[q + 3] = -fy;
      s[q + 4] = dn; s[q + 5] = df; s[q + 6] = crackIgniteMs(info, dn);
      s[q + 7] = len > 1e-6 ? (fx - nx) / len : 1;
      s[q + 8] = len > 1e-6 ? -(fy - ny) / len : 0;
      s[q + 9] = crackIgniteMs(info, df);
      // Into the piece (Pixi-down): the outline is CCW in math-up, so its
      // inside is left of edge a → b, (−(by−ay), bx−ax); flip y for Pixi.
      const el = Math.hypot(bx - ax, by - ay);
      const mx = el > 1e-6 ? -(by - ay) / el : 0, my = el > 1e-6 ? (bx - ax) / el : 0; // math-up
      s[q + 10] = mx;
      s[q + 11] = -my;
      // How wide the strip may be at each end and stay inside the piece (a
      // sharp corner, e.g. the wedge at the kill point, would poke it out).
      s[q + 12] = insideWidth(o, nx, ny, mx, my, this.halfHalo);
      s[q + 13] = insideWidth(o, fx, fy, mx, my, this.halfHalo);
      // Both ends inside is not enough on a concave piece (the bow): the
      // strip's far side can still cross the outline between them (filmed
      // v3 takes: the scorch stuck out past the hull). Narrow until it fits.
      for (let tries = 0; tries < 6 && !stripInside(o, nx, ny, fx, fy, mx, my, s[q + 12]!, s[q + 13]!); tries++) {
        s[q + 12] = s[q + 12]! * 0.5; s[q + 13] = s[q + 13]! * 0.5;
      }
      if (!stripInside(o, nx, ny, fx, fy, mx, my, s[q + 12]!, s[q + 13]!)) { s[q + 12] = 0; s[q + 13] = 0; }
      this.glowEndMs = Math.max(this.glowEndMs, s[q + 9]! + WRECK_GLOW_END_S * 1000);
      this.edgeSeg[edge] = k++;
    });
    this.segN = S;
    if (this.simple) { this.buildSimpleGlow(); return; }
    // Per segment, in draw order: halo quads, core quads, then the head's
    // halo and core on top (all four blocks S quads long).
    const Q = GLOW_QUADS_PER_SEG * S;
    const positions = new Float32Array(Q * 8);
    const uvs = new Float32Array(Q * 8);
    const indices = new Uint32Array(Q * 6);
    for (let j = 0; j < Q; j++) {
      const v0 = j * 4, ii = j * 6;
      indices[ii] = v0; indices[ii + 1] = v0 + 1; indices[ii + 2] = v0 + 2;
      indices[ii + 3] = v0; indices[ii + 4] = v0 + 2; indices[ii + 5] = v0 + 3;
      const block = Math.floor(j / S);
      const v = block === 1 || block === 3 ? V_CORE : V_HALO;
      for (let c = 0; c < 4; c++) { uvs[(v0 + c) * 2] = block >= 2 ? U_HOT : U_DARK; uvs[(v0 + c) * 2 + 1] = v; }
    }
    const geometry = new MeshGeometry({ positions, uvs, indices });
    geometry.batchMode = 'batch';
    const mesh = new Mesh({ geometry, texture: wreckGlowTexture() });
    this.glowGeom = geometry;
    this.glow = mesh;
    this.addChild(mesh);
  }

  /** The simple glow (sub-capital): one core quad per cut segment on this
   *  piece's side, full length from the start (no front), never moved
   *  again; only its one shared U changes as it fades (`writeSimpleGlow`). */
  private buildSimpleGlow(): void {
    // Twice the core (still inside the piece): a small hull's core alone is
    // a hairline at fleet-fight zoom (review 2026-11-13: "the glow lasted
    // only ~0.4-0.6 s" was partly a glow too thin to see).
    const S = this.segN, s = this.seg, hc = this.halfCore * 2;
    const positions = new Float32Array(S * 8);
    const uvs = new Float32Array(S * 8);
    const indices = new Uint32Array(S * 6);
    const u0 = simpleGlowU(0);
    for (let k = 0; k < S; k++) {
      const v0 = k * 4, ii = k * 6, q = k * SEG_STRIDE;
      indices[ii] = v0; indices[ii + 1] = v0 + 1; indices[ii + 2] = v0 + 2;
      indices[ii + 3] = v0; indices[ii + 4] = v0 + 2; indices[ii + 5] = v0 + 3;
      for (let c = 0; c < 4; c++) { uvs[(v0 + c) * 2] = u0; uvs[(v0 + c) * 2 + 1] = 0.5; }
      writeStrip(positions, v0, s[q]!, s[q + 1]!, s[q + 2]!, s[q + 3]!, s[q + 10]!, s[q + 11]!, Math.min(hc, s[q + 12]!), Math.min(hc, s[q + 13]!));
    }
    this.grown = true;
    this.glowEndMs = this.info.fx.glowSeconds * 1000;
    const geometry = new MeshGeometry({ positions, uvs, indices });
    geometry.batchMode = 'batch';
    const mesh = new Mesh({ geometry, texture: wreckSimpleGlowTexture() });
    this.glowGeom = geometry;
    this.glow = mesh;
    this.addChild(mesh);
  }

  /** The simple glow at `t` game ms after death: one U for every vertex,
   *  rewritten (in place) only when it moves. */
  private writeSimpleGlow(t: number): void {
    const u = simpleGlowU(t / this.glowEndMs);
    if (u === this.lastU) return;
    this.lastU = u;
    const uv = this.glowGeom!.uvs;
    for (let i = 0; i < uv.length; i += 2) uv[i] = u;
    this.glowGeom!.getBuffer('aUV').update();
    this.writes++;
  }

  /** The glow at `t` game ms after death: grow each segment from its near end
   *  as far as the front has run, and age it from its own ignition. In-place
   *  writes only (invariant #14). */
  private writeGlow(t: number): void {
    const geom = this.glowGeom!, s = this.seg, S = this.segN, info = this.info;
    const F = crackFrontAt(info, t);
    const uv = geom.uvs;
    if (!this.grown) {
      const pos = geom.positions;
      const hc = this.halfCore, hh = this.halfHalo;
      let heads = 0;
      for (let k = 0; k < S; k++) {
        const q = k * SEG_STRIDE;
        const nx = s[q]!, ny = s[q + 1]!, dn = s[q + 4]!, df = s[q + 5]!;
        const inx = s[q + 10]!, iny = s[q + 11]!;
        const lit = F >= dn;
        const frac = !lit ? 0 : df > dn ? Math.min(1, (F - dn) / (df - dn)) : 1;
        const fx = s[q + 2]!, fy = s[q + 3]!;
        const ex = nx + (fx - nx) * frac, ey = ny + (fy - ny) * frac;
        // Halo and core on this piece's side of the crack only (its half of
        // the stroke; the neighbour draws the other half).
        const wn = s[q + 12]!, we = wn + (s[q + 13]! - wn) * frac;
        writeStrip(pos, k * 4, nx, ny, ex, ey, inx, iny, lit ? Math.min(hh, wn) : 0, lit ? Math.min(hh, we) : 0);
        writeStrip(pos, (S + k) * 4, nx, ny, ex, ey, inx, iny, lit ? Math.min(hc, wn) : 0, lit ? Math.min(hc, we) : 0);
        // The white-hot head: the last stretch behind the tip of a crack the
        // front is still running along, wider than the crack it leaves.
        // On this piece's side only, like the stroke (it was a quad centred
        // on the crack, so half of it lay in the neighbour or past the hull).
        const growing = lit && frac < 1;
        let hx = ex, hy = ey, wh = we;
        if (growing) {
          heads++;
          const segLen = Math.hypot(fx - nx, fy - ny);
          const back = Math.min(frac, this.headLen / Math.max(1e-6, segLen));
          hx = ex - (fx - nx) * back; hy = ey - (fy - ny) * back;
          wh = wn + (s[q + 13]! - wn) * (frac - back);
        }
        writeStrip(pos, (2 * S + k) * 4, hx, hy, ex, ey, inx, iny, growing ? Math.min(this.halfHeadHalo, wh) : 0, growing ? Math.min(this.halfHeadHalo, we) : 0);
        writeStrip(pos, (3 * S + k) * 4, hx, hy, ex, ey, inx, iny, growing ? Math.min(this.halfHead, wh) : 0, growing ? Math.min(this.halfHead, we) : 0);
      }
      this.heads = heads;
      geom.getBuffer('aPosition').update();
      if (F >= info.crackReach) {
        this.grown = true;
        this.heads = 0;
      }
    }
    // Each end of a crack ages from the moment the front reached it, so the
    // crack runs white-hot at the tip, cooling orange to red behind it.
    for (let k = 0; k < S; k++) {
      const q = k * SEG_STRIDE;
      const dn = s[q + 4]!, df = s[q + 5]!;
      let ua = U_DARK, ub = U_DARK;
      if (F >= dn) {
        ua = glowU((t - s[q + 6]!) / 1000);
        ub = F >= df ? glowU((t - s[q + 9]!) / 1000) : U_HOT;
      }
      // writeQuad's corners: 0 and 3 at the near end, 1 and 2 at the tip.
      const h = k * 8, c = (S + k) * 8;
      uv[h] = ua; uv[h + 2] = ub; uv[h + 4] = ub; uv[h + 6] = ua;
      uv[c] = ua; uv[c + 2] = ub; uv[c + 4] = ub; uv[c + 6] = ua;
    }
    geom.getBuffer('aUV').update();
    this.writes++;
  }

  /** White-hot heads drawn at the last update (0 once the front has passed
   *  every crack). Tests/diagnostics. */
  frontHeads(): number {
    return this.glow === null ? 0 : this.heads;
  }

  /** Fire this piece's ripple blasts whose moment has come (once each). */
  private fireRipples(t: number): void {
    const info = this.info, rs = info.ripples, sink = info.onRipple;
    if (rs.length === 0 || sink === null) { this.ripplesDone = true; return; }
    let pending = 0;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i]!;
      if (r.piece !== this.pieceIndex || info.rippleFired[i] === 1) continue;
      if (t < r.atMs) { pending++; continue; }
      info.rippleFired[i] = 1;
      if (t - r.atMs > RIPPLE_LATE_MS) continue; // this piece was drawn too late for it
      const a = -this.rotation, c = Math.cos(a), sn = Math.sin(a);
      sink(this.x + r.lx * c - r.ly * sn, -this.y + r.lx * sn + r.ly * c, r.r);
    }
    if (pending === 0) this.ripplesDone = true;
  }

  /** Per frame, after the pose is set: light frame + glow. Alloc-free. A
   *  settled piece (glow gone, its ripples fired) whose rotation and sun have
   *  not moved since the last update does nothing (permanent debris at
   *  volume: sub-capital break-up, slice 4). */
  update(nowMs: number, sunAz: number): void {
    if (this.glow === null && this.ripplesDone && this.rotation === this.lastRot && sunAz === this.lastSunAz) return;
    this.lastRot = this.rotation;
    this.lastSunAz = sunAz;
    const art = this.art;
    if (art !== null && art.lit === undefined && this.meshes.length > 0) {
      const tiles = Math.max(1, art.tiles);
      const steps = Math.floor(art.frames.length / tiles);
      if (steps > 1) {
        sunFrameBlend(sunAz, this.rotation, steps, _blend);
        const j = _blend.t < 0.5 ? _blend.j0 : _blend.j1;
        if (j !== this.sunFrame) {
          this.sunFrame = j;
          for (let i = 0; i < this.meshes.length; i++) this.meshes[i]!.texture = art.frames[j * tiles + this.meshTile[i]!]! as Texture;
          this.writes++;
        }
      }
    }
    const t = nowMs - this.info.deathMs; // game ms since death
    this.lastT = t;
    this.fireRipples(t);
    const g = this.glow;
    if (g === null) return;
    if (t >= this.glowEndMs) {
      // Every crack cooled for good: the glow goes (one fewer object per piece).
      this.removeChild(g);
      g.destroy();
      this.glowGeom?.destroy();
      this.glow = null;
      this.glowGeom = null;
      this.applyDeadTint(); // once, the frame the glow ends
      return;
    }
    if (this.simple) this.writeSimpleGlow(t);
    else this.writeGlow(t);
  }

  /** The dead look (profile `fx.deadTint`), written once on the art when the
   *  glow ends (or at build, with no glow); null keeps the burnt tint. */
  private applyDeadTint(): void {
    const t = this.info.fx.deadTint;
    if (t === null) return;
    for (let i = 0; i < this.artParts.length; i++) this.artParts[i]!.tint = t;
  }

  /** The glow's colour at the last update (the simple glow's curve; the full
   *  glow's at its first segment's age). Tests/diagnostics. */
  glowColor(): number {
    if (this.simple) return simpleGlowAt(this.lastT / this.glowEndMs, _glow).color;
    return wreckGlowAt((this.lastT - (this.seg[6] ?? 0)) / 1000, _glow).color;
  }

  /** Cut segments the glow covers (0 once cool). Tests/diagnostics. */
  glowSegments(): number {
    return this.glow === null ? 0 : this.segN;
  }

  /** Light-frame swaps and glow uploads so far. Tests/diagnostics. */
  frameWrites(): number {
    return this.writes;
  }

  /** How the piece draws the dead ship's art: `baked` (lit sun frames),
   *  `lit` (GPU-lit maps through the lit shader), `raw-maps` (GPU-lit maps
   *  through the default shader: unlit albedo, the money-shot bug) or
   *  `plain` (no art: the flat polygon). */
  artMode(): 'baked' | 'lit' | 'raw-maps' | 'plain' {
    if (this.art === null) return 'plain';
    if (this.art.lit === undefined) return 'baked';
    return this.litMeshes > 0 ? 'lit' : 'raw-maps';
  }

  /** The hottest cut edge's current alpha (0 once cool). Tests/diagnostics. */
  glowAlpha(): number {
    if (this.glow === null) return 0;
    let m = 0;
    for (let i = 0; i < this.edgeSeg.length; i++) m = Math.max(m, this.edgeHeat(i));
    return m;
  }

  /** Outline edge `i`'s glow alpha at the last update: 0 for an edge that is
   *  not a cut, not yet reached by the crack front, or cooled. */
  edgeHeat(i: number): number {
    const k = this.glow === null ? -1 : (this.edgeSeg[i] ?? -1);
    if (k < 0) return 0;
    if (this.simple) return simpleGlowAt(this.lastT / this.glowEndMs, _glow).alpha;
    const q = k * SEG_STRIDE;
    if (crackFrontAt(this.info, this.lastT) < this.seg[q + 4]!) return 0;
    return wreckGlowAt((this.lastT - this.seg[q + 6]!) / 1000, _glow).alpha;
  }

  /** The glow mesh's vertex positions (body-local, Pixi-down; null once
   *  cool). Tests/diagnostics. */
  glowPositions(): Float32Array | null {
    return this.glowGeom === null ? null : this.glowGeom.positions;
  }

  /** The glow strip's texture (the shared glow-curve texture; the simple
   *  glow's own curve for a simple glow). */
  glowTexture(): Texture {
    return this.simple ? wreckSimpleGlowTexture() : wreckGlowTexture();
  }
}

/** Floats per cut segment: near x,y and far x,y (Pixi-down), near/far crack
 *  distance, near-end ignition (game ms after the front started), unit
 *  direction x,y, far-end ignition, unit normal into the piece x,y, the
 *  widest the strip may be at the near / far end and stay inside. */
const SEG_STRIDE = 14;
/** Glow quads per cut segment: halo, core, head halo, head core. */
const GLOW_QUADS_PER_SEG = 4;

/** Four corners of a strip on one side of the edge (px,py) → (qx,qy): from
 *  the edge to `wp` / `wq` (at each end) along the unit normal (nx,ny).
 *  Corners 0 and 3 at the near end, 1 and 2 at the far end (the U layout
 *  `writeGlow` relies on). In place. */
function writeStrip(
  pos: Float32Array, v0: number, px: number, py: number, qx: number, qy: number,
  nx: number, ny: number, wp: number, wq: number,
): void {
  const o = v0 * 2;
  pos[o] = px + nx * wp; pos[o + 1] = py + ny * wp;
  pos[o + 2] = qx + nx * wq; pos[o + 3] = qy + ny * wq;
  pos[o + 4] = qx; pos[o + 5] = qy;
  pos[o + 6] = px; pos[o + 7] = py;
}

/** How far (≤ `w`) a strip may reach from outline point (x, y) along the
 *  inward normal (mx, my) and stay inside the ring (math-up). Halved until
 *  the strip's tip and middle are inside; 0 at a sharp corner. Build-time. */
function insideWidth(ring: ReadonlyArray<{ x: number; y: number }>, x: number, y: number, mx: number, my: number, w: number): number {
  for (let k = 0; k < 6; k++, w *= 0.5) {
    if (pointInRing(ring, x + mx * w, y + my * w) && pointInRing(ring, x + mx * w * 0.5, y + my * w * 0.5)) return w;
  }
  return 0;
}

/** Even-odd point-in-polygon. */
function pointInRing(ring: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether the strip from edge (ax,ay) → (bx,by) out to `wa` / `wb` along
 *  the inward normal (mx, my) lies inside the ring (math-up): its far side
 *  and its middle, sampled along the edge. Build-time. */
function stripInside(
  ring: ReadonlyArray<{ x: number; y: number }>, ax: number, ay: number, bx: number, by: number,
  mx: number, my: number, wa: number, wb: number,
): boolean {
  for (let i = 0; i <= STRIP_SAMPLES; i++) {
    const f = i / STRIP_SAMPLES, w = wa + (wb - wa) * f;
    if (!(w > 0)) continue;
    const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
    if (!pointInRing(ring, x + mx * w, y + my * w) || !pointInRing(ring, x + mx * w * 0.5, y + my * w * 0.5)) return false;
  }
  return true;
}
const STRIP_SAMPLES = 16;
