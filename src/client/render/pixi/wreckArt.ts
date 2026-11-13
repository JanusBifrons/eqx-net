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
 * segment's ignition (molten, an ember at ~3 s, dark at `WRECK_GLOW_END_S`
 * (6 s); the mesh is destroyed when the last crack is dark). The
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
 */
import { BufferImageSource, Container, Geometry, Mesh, MeshGeometry, Texture } from 'pixi.js';
import { WRECK_CRACK_MS } from '../../../shared-types/wreckTiming.js';
import { LitShipMesh } from '../art/litShipShader.js';
import { litPass } from '../art/litPass.js';
import type { ShipArt } from '../art/ArtService.js';
import { sunFrameBlend, type SunBlend } from '../art/machinedShipLight.js';
import { buildWreckPieceGfx } from './spriteBuilders.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { shipShapeScale } from '../../../core/geometry/shipHullOutline.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieces.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';

/** Container + meshes (≤ 6 tiles) + one glow mesh (the crack strokes). */
export const WRECK_DISPLAY_OBJECTS_PER_PIECE_MAX = 8;

/** The cut edges are a dull ember here (s)... (money-shot review: bright for
 *  ~1 s, an ember by ~3 s, dark by ~6 s; it was still bright orange at 4.5 s) */
export const WRECK_GLOW_EMBER_S = 3;
/** ...and dark from here on (s); the glow stroke is then destroyed. */
export const WRECK_GLOW_END_S = 6;
/** A wreck first seen younger than this plays its break-up (dust, shards,
 *  flash); older ones (late joiners, a returning viewer) do not. */
export const WRECK_BREAK_FX_MAX_AGE_MS = 1500;
/** Game ms the crack front takes from the kill point to the farthest cut:
 *  most of the hold, so the last cracks are still white-hot at the split. */
export const WRECK_CRACK_FRONT_MS = Math.round(WRECK_CRACK_MS * 0.8);
/** Most ripple blasts one wreck gets (the `high` effects tier). */
export const WRECK_RIPPLE_MAX = 7;
/** A ripple blast's radius as a share of the wreck radius: well below the
 *  kill-point blast (`WRECK_BLAST_MAIN`, 0.12). */
export const WRECK_RIPPLE_R_MIN = 0.022;
export const WRECK_RIPPLE_R_MAX = 0.04;
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
 *  the pieces should carry the hull art, slightly darkened. */
const BURNT_NEAR = 0x9a8a80;
const BURNT_FAR = 0xd2cac4;

// ── The glow curve ────────────────────────────────────────────────────────

export interface WreckGlow { color: number; alpha: number }

/** Keyframes: time (s), colour, alpha. Colour and alpha only ever fall. */
const GLOW_T = [0, 0.5, 1.1, WRECK_GLOW_EMBER_S, 4.4, WRECK_GLOW_END_S];
const GLOW_C = [0xfff2c8, 0xffa040, 0xff6a18, 0xa82c08, 0x501404, 0x200804];
const GLOW_A = [1, 1, 0.9, 0.55, 0.2, 0];

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
const GLOW_TEX_W = 64;
/** Row centres: the bright core, the soft halo (alpha × 0.3). */
const V_CORE = 0.25;
const V_HALO = 0.75;
/** U of the last texel: dark (an unlit or cooled segment). */
const U_DARK = (GLOW_TEX_W - 0.5) / GLOW_TEX_W;

let _glowTex: Texture | null = null;

/** The glow curve baked into a 64×2 texture (row 0 core, row 1 halo), so a
 *  segment's colour and alpha follow from its U alone. Made once. */
export function wreckGlowTexture(): Texture {
  if (_glowTex !== null) return _glowTex;
  const data = new Uint8Array(GLOW_TEX_W * 2 * 4);
  const g: WreckGlow = { color: 0, alpha: 0 };
  for (let i = 0; i < GLOW_TEX_W; i++) {
    wreckGlowAt((i / (GLOW_TEX_W - 1)) * WRECK_GLOW_END_S, g);
    for (let row = 0; row < 2; row++) {
      const o = (row * GLOW_TEX_W + i) * 4;
      data[o] = (g.color >> 16) & 255;
      data[o + 1] = (g.color >> 8) & 255;
      data[o + 2] = g.color & 255;
      data[o + 3] = Math.round(255 * g.alpha * (row === 0 ? 1 : 0.3));
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

// ── The crack front ───────────────────────────────────────────────────────

/** How far (hull frame, from the kill point) the crack front has run `tMs`
 *  GAME ms after death: the nearest cut at 0, the farthest at
 *  `WRECK_CRACK_FRONT_MS`. Distance is straight-line from the kill point, so
 *  the front is a ring spreading from the hit, lighting the cuts it crosses. */
export function crackFrontAt(info: Pick<WreckInfo, 'crackMin' | 'crackReach'>, tMs: number): number {
  if (!(tMs >= 0)) return -Infinity;
  const k = Math.min(1, tMs / WRECK_CRACK_FRONT_MS);
  return info.crackMin + (info.crackReach - info.crackMin) * k;
}

/** When (game ms after death) the front reaches distance `d`. */
export function crackIgniteMs(info: Pick<WreckInfo, 'crackMin' | 'crackReach'>, d: number): number {
  const span = info.crackReach - info.crackMin;
  if (!(span > 1e-6)) return 0;
  return Math.max(0, Math.min(1, (d - info.crackMin) / span)) * WRECK_CRACK_FRONT_MS;
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
  /** Death time on this renderer's clock (−Infinity ⇒ drawn cool). */
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
  /** The ripple blasts along the cracks (empty for a late joiner), each
   *  fired once by its piece's sprite (`rippleFired`). */
  ripples: WreckRipple[];
  rippleFired: Uint8Array;
  onRipple: WreckRippleSink | null;
}

/** One small blast on a crack: its piece, the point body-local (math-up),
 *  when the front reaches it (game ms after death) and its radius. */
export interface WreckRipple { piece: number; lx: number; ly: number; atMs: number; r: number }

/** Ripple sink: game-space centre and blast radius. */
export type WreckRippleSink = (x: number, y: number, r: number) => void;

const NO_RIPPLES: WreckRipple[] = [];
const NO_FIRED = new Uint8Array(0);

/** The info of a wreck drawn without a death clock: cool, no cracks running. */
export function coolWreckInfo(desc: WreckDescriptor): WreckInfo {
  return {
    deathMs: -Infinity, hullR: 0, killX: 0, killY: 0, snap: false, desc,
    crackMin: 0, crackReach: 0, ripples: NO_RIPPLES, rippleFired: NO_FIRED, onRipple: null,
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
 * The ripple blasts of a fresh wreck: `count` points on the cut edges,
 * spaced along the crack front (one per equal band of front distance,
 * jittered), each on a cut segment the front crosses at that distance,
 * chosen from the wreck seed (every client sees the same). Runs once per
 * wreck, at first sight.
 */
export function wreckRipples(
  pieces: readonly WreckPieceGeometry[], info: Pick<WreckInfo, 'killX' | 'killY' | 'hullR' | 'crackMin' | 'crackReach'>,
  seed: number, count: number,
): WreckRipple[] {
  const out: WreckRipple[] = [];
  if (count <= 0 || !(info.crackReach > info.crackMin)) return out;
  const rnd = seededRandom(seed);
  for (let k = 0; k < count; k++) {
    const target = info.crackMin + (info.crackReach - info.crackMin) * ((k + 0.2 + 0.6 * rnd()) / count);
    // Count the cut segments the front crosses at `target`, then pick one.
    let n = 0;
    for (const p of pieces) forEachCut(p, info, (_ax, _ay, _bx, _by, da, db) => {
      if (Math.min(da, db) <= target && target <= Math.max(da, db)) n++;
    });
    if (n === 0) continue;
    let pick = Math.floor(rnd() * n);
    const rr = rnd();
    for (let pi = 0; pi < pieces.length && pick >= 0; pi++) {
      const p = pieces[pi]!;
      forEachCut(p, info, (ax, ay, bx, by, da, db) => {
        if (pick < 0 || !(Math.min(da, db) <= target && target <= Math.max(da, db))) return;
        if (pick-- > 0) return;
        const s = db !== da ? (target - da) / (db - da) : 0.5;
        out.push({
          piece: pi, lx: ax + (bx - ax) * s - p.cx, ly: ay + (by - ay) * s - p.cy,
          atMs: crackIgniteMs(info, target),
          r: Math.max(6, info.hullR * (WRECK_RIPPLE_R_MIN + (WRECK_RIPPLE_R_MAX - WRECK_RIPPLE_R_MIN) * rr)),
        });
        pick = -1;
      });
    }
  }
  return out;
}

/** Each cut edge of a piece in the hull frame, with each end's distance from
 *  the kill point. Build-time only. */
function forEachCut(
  p: WreckPieceGeometry, kill: Pick<WreckInfo, 'killX' | 'killY'>,
  fn: (ax: number, ay: number, bx: number, by: number, da: number, db: number) => void,
): void {
  const o = p.outline, n = o.length;
  for (let i = 0; i < n; i++) {
    if (!p.cutEdges[i]) continue;
    const a = o[i]!, b = o[(i + 1) % n]!;
    const ax = a.x + p.cx, ay = a.y + p.cy, bx = b.x + p.cx, by = b.y + p.cy;
    fn(ax, ay, bx, by, Math.hypot(ax - kill.killX, ay - kill.killY), Math.hypot(bx - kill.killX, by - kill.killY));
  }
}

// ── The break-up blast ────────────────────────────────────────────────────

/** One FxExplosions blast: game-space centre and blast radius. */
export interface WreckBlast { x: number; y: number; r: number }

/** The main fireball's radius as a share of the wreck radius (#18: a heavy
 *  cruiser's ~260 u, a battleship's ~350 u), and the two smaller ones beside
 *  it. FxExplosions draws a blast of radius r as a 2r fireball under a soft
 *  3.4r glow, so every blast stays within ~0.25 of the wreck radius of the
 *  kill point: a fireball where the hull broke, never one over the hull. */
export const WRECK_BLAST_MAIN = 0.12;
export const WRECK_BLAST_SUB = 0.065;
export const WRECK_BLAST_SUB_OFFSET = 0.09;

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
 * review); the break-up's fireballs at the kill point replace it.
 */
export function hullDeathBlastReplaced(capitalWrecks: boolean | undefined, dyingIsCapital: boolean): boolean {
  return capitalWrecks === true && dyingIsCapital;
}

/** Break-up sink: kill point (game space), wreck radius, clean snap, seed. */
export type WreckBreakSink = (x: number, y: number, radius: number, snap: boolean, seed: number) => void;

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
   */
  constructor(
    public onBreak: WreckBreakSink | null = null,
    public onRipple: WreckRippleSink | null = null,
    private readonly rippleCap: () => number = () => WRECK_RIPPLE_MAX,
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
    const s = shipShapeScale(getShipKind(desc.parentKind));
    let hullR = 0;
    for (const p of pieces) hullR = Math.max(hullR, Math.hypot(p.cx, p.cy) + p.radius);
    const ageMs = desc.deathTick !== undefined ? Math.max(0, serverTick - desc.deathTick) * TICK_MS : Infinity;
    const info: WreckInfo = {
      deathMs: nowMs - ageMs, hullR, killX: desc.killX * s, killY: -desc.killY * s, snap: pieces.length <= 2, desc,
      crackMin: Infinity, crackReach: 0, ripples: NO_RIPPLES, rippleFired: NO_FIRED, onRipple: this.onRipple,
    };
    for (const p of pieces) forEachCut(p, info, (_ax, _ay, _bx, _by, da, db) => {
      info.crackMin = Math.min(info.crackMin, da, db);
      info.crackReach = Math.max(info.crackReach, da, db);
    });
    if (!(info.crackMin <= info.crackReach)) { info.crackMin = 0; info.crackReach = 0; }
    // Ripples only for a wreck seen inside its crack window (late joiners:
    // none); one whose moment already passed is marked fired.
    if (ageMs < WRECK_CRACK_MS && this.onRipple !== null) {
      info.ripples = wreckRipples(pieces, info, desc.seed, Math.min(WRECK_RIPPLE_MAX, this.rippleCap()));
      info.rippleFired = new Uint8Array(info.ripples.length);
      for (let i = 0; i < info.ripples.length; i++) if (info.ripples[i]!.atMs < ageMs) info.rippleFired[i] = 1;
    }
    this.byId.set(desc.wreckId, info);
    const g = pieces[pieceIndex];
    if (ageMs < WRECK_BREAK_FX_MAX_AGE_MS && g !== undefined && this.onBreak !== null) {
      const dx = info.killX - g.cx, dy = info.killY - g.cy;
      const c = Math.cos(pose.angle), sn = Math.sin(pose.angle);
      this.onBreak(pose.x + dx * c - dy * sn, pose.y + dx * sn + dy * c, hullR, info.snap, desc.seed);
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
  /** The front has passed every cut: positions are final. */
  private grown = false;
  /** Game ms after death when the last crack is dark. */
  private glowEndMs = 0;
  /** Game ms since death at the last update. */
  private lastT = -Infinity;
  private sunFrame = -1;
  /** GPU-lit meshes (lit art only). */
  private litMeshes = 0;

  constructor(
    piece: WreckPieceGeometry, parentKind: string, readonly art: ShipArt | null, private readonly info: WreckInfo,
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
      }
    } else {
      this.addChild(buildWreckPieceGfx(piece.outline, parentKind));
    }
    // The glow: cut edges only, one Mesh of quads (a soft halo under a bright
    // core per cut segment) on the glow-curve texture. A wreck already cool
    // when first seen never gets one.
    if (info.deathMs > -Infinity) this.buildGlow(piece);
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
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!piece.cutEdges[i]) continue;
      const a = o[i]!, b = o[(i + 1) % n]!;
      const da = Math.hypot(a.x + piece.cx - info.killX, a.y + piece.cy - info.killY);
      const db = Math.hypot(b.x + piece.cx - info.killX, b.y + piece.cy - info.killY);
      const [near, far, dn, df] = da <= db ? [a, b, da, db] : [b, a, db, da];
      const len = Math.hypot(far.x - near.x, far.y - near.y);
      const s = this.seg, q = k * SEG_STRIDE;
      s[q] = near.x; s[q + 1] = -near.y; s[q + 2] = far.x; s[q + 3] = -far.y;
      s[q + 4] = dn; s[q + 5] = df; s[q + 6] = crackIgniteMs(info, dn);
      s[q + 7] = len > 1e-6 ? (far.x - near.x) / len : 1;
      s[q + 8] = len > 1e-6 ? -(far.y - near.y) / len : 0;
      this.glowEndMs = Math.max(this.glowEndMs, s[q + 6]! + WRECK_GLOW_END_S * 1000);
      this.edgeSeg[i] = k++;
    }
    this.segN = S;
    const core = Math.min(40, Math.max(3, info.hullR * 0.006));
    this.halfCore = core / 2;
    this.halfHalo = (core * 3.5) / 2;
    // Halo quads first (drawn under), then the core quads.
    const positions = new Float32Array(S * 16);
    const uvs = new Float32Array(S * 16);
    const indices = new Uint32Array(S * 12);
    for (let j = 0; j < 2 * S; j++) {
      const v0 = j * 4, ii = j * 6;
      indices[ii] = v0; indices[ii + 1] = v0 + 1; indices[ii + 2] = v0 + 2;
      indices[ii + 3] = v0; indices[ii + 4] = v0 + 2; indices[ii + 5] = v0 + 3;
      for (let v = 0; v < 4; v++) { uvs[(v0 + v) * 2] = U_DARK; uvs[(v0 + v) * 2 + 1] = j < S ? V_HALO : V_CORE; }
    }
    const geometry = new MeshGeometry({ positions, uvs, indices });
    geometry.batchMode = 'batch';
    const mesh = new Mesh({ geometry, texture: wreckGlowTexture() });
    this.glowGeom = geometry;
    this.glow = mesh;
    this.addChild(mesh);
  }

  /** The glow at `t` game ms after death: grow each segment from its near end
   *  as far as the front has run, and age it from its own ignition. In-place
   *  writes only (invariant #14). */
  private writeGlow(t: number): void {
    const geom = this.glowGeom!, s = this.seg, S = this.segN;
    const F = crackFrontAt(this.info, t);
    if (!this.grown) {
      const pos = geom.positions;
      const hc = this.halfCore, hh = this.halfHalo;
      for (let k = 0; k < S; k++) {
        const q = k * SEG_STRIDE;
        const nx = s[q]!, ny = s[q + 1]!, dn = s[q + 4]!, df = s[q + 5]!;
        const ux = s[q + 7]!, uy = s[q + 8]!;
        const lit = F >= dn;
        const frac = !lit ? 0 : df > dn ? Math.min(1, (F - dn) / (df - dn)) : 1;
        const ex = nx + (s[q + 2]! - nx) * frac, ey = ny + (s[q + 3]! - ny) * frac;
        const ext = lit ? hc : 0; // the core runs a little past both ends: closed joints
        writeQuad(pos, k * 4, nx, ny, ex, ey, ux, uy, lit ? hh : 0, 0);
        writeQuad(pos, (S + k) * 4, nx, ny, ex, ey, ux, uy, lit ? hc : 0, ext);
      }
      geom.getBuffer('aPosition').update();
      if (F >= this.info.crackReach) this.grown = true;
    }
    const uv = geom.uvs;
    for (let k = 0; k < S; k++) {
      const q = k * SEG_STRIDE;
      const u = F >= s[q + 4]! ? glowU((t - s[q + 6]!) / 1000) : U_DARK;
      const h = k * 8, c = (S + k) * 8;
      uv[h] = u; uv[h + 2] = u; uv[h + 4] = u; uv[h + 6] = u;
      uv[c] = u; uv[c + 2] = u; uv[c + 4] = u; uv[c + 6] = u;
    }
    geom.getBuffer('aUV').update();
  }

  /** Fire this piece's ripple blasts whose moment has come (once each). */
  private fireRipples(t: number): void {
    const info = this.info, rs = info.ripples, sink = info.onRipple;
    if (rs.length === 0 || sink === null) return;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i]!;
      if (r.piece !== this.pieceIndex || info.rippleFired[i] === 1 || t < r.atMs) continue;
      info.rippleFired[i] = 1;
      if (t - r.atMs > RIPPLE_LATE_MS) continue; // this piece was drawn too late for it
      const a = -this.rotation, c = Math.cos(a), sn = Math.sin(a);
      sink(this.x + r.lx * c - r.ly * sn, -this.y + r.lx * sn + r.ly * c, r.r);
    }
  }

  /** Per frame, after the pose is set: light frame + glow. Alloc-free. */
  update(nowMs: number, sunAz: number): void {
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
      return;
    }
    this.writeGlow(t);
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
    const q = k * SEG_STRIDE;
    if (crackFrontAt(this.info, this.lastT) < this.seg[q + 4]!) return 0;
    return wreckGlowAt((this.lastT - this.seg[q + 6]!) / 1000, _glow).alpha;
  }

  /** The glow strip's texture (the shared glow-curve texture). */
  glowTexture(): Texture {
    return wreckGlowTexture();
  }
}

/** Floats per cut segment: near x,y and far x,y (Pixi-down), near/far crack
 *  distance, ignition (game ms after death), unit direction x,y. */
const SEG_STRIDE = 9;

/** Four corners of a quad from (px,py) to (qx,qy), half-width `h`, ends
 *  pushed out by `ext` along the unit direction (ux,uy). In place. */
function writeQuad(
  pos: Float32Array, v0: number, px: number, py: number, qx: number, qy: number,
  ux: number, uy: number, h: number, ext: number,
): void {
  const ax = px - ux * ext, ay = py - uy * ext, bx = qx + ux * ext, by = qy + uy * ext;
  const nx = -uy * h, ny = ux * h;
  const o = v0 * 2;
  pos[o] = ax + nx; pos[o + 1] = ay + ny;
  pos[o + 2] = bx + nx; pos[o + 3] = by + ny;
  pos[o + 4] = bx - nx; pos[o + 5] = by - ny;
  pos[o + 6] = ax - nx; pos[o + 7] = ay - ny;
}
