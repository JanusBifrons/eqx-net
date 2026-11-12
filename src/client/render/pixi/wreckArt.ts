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
 * **Glowing cut edges.** Edges flagged as new cuts (`cutEdges`) get one white
 * stroke `Graphics` whose tint and alpha follow `wreckGlowAt` (molten at
 * death, an ember at ~3 s, dark at `WRECK_GLOW_END_S` (6 s), then destroyed). The
 * original hull outline never glows. The clock is the wreck's death tick
 * from its descriptor (`deathTick`), so a late joiner sees it cool.
 *
 * Everything here is built ONCE per piece; the per-frame work is a texture
 * pick and a tint/alpha write (invariant #14).
 */
import { Container, Graphics, Mesh, MeshGeometry, type Texture } from 'pixi.js';
import type { ShipArt } from '../art/ArtService.js';
import { sunFrameBlend, type SunBlend } from '../art/machinedShipLight.js';
import { buildWreckPieceGfx } from './spriteBuilders.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { shipShapeScale } from '../../../core/geometry/shipHullOutline.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieces.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';

/** Container + meshes (≤ 6 tiles) + one glow stroke. */
export const WRECK_DISPLAY_OBJECTS_PER_PIECE_MAX = 8;

/** The cut edges are a dull ember here (s)... (money-shot review: bright for
 *  ~1 s, an ember by ~3 s, dark by ~6 s; it was still bright orange at 4.5 s) */
export const WRECK_GLOW_EMBER_S = 3;
/** ...and dark from here on (s); the glow stroke is then destroyed. */
export const WRECK_GLOW_END_S = 6;
/** A wreck first seen younger than this plays its break-up (dust, shards,
 *  flash); older ones (late joiners, a returning viewer) do not. */
export const WRECK_BREAK_FX_MAX_AGE_MS = 1500;
/** Server ticks per second (the descriptor's `deathTick` clock). */
const TICK_MS = 1000 / 60;

/** Burnt tint: near the kill point / far from it. */
const BURNT_NEAR = 0x3a2c26;
const BURNT_FAR = 0x8c7e74;

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
}

/** Break-up sink: kill point (game space), wreck radius, clean snap. */
export type WreckBreakSink = (x: number, y: number, radius: number, snap: boolean) => void;

/**
 * Renderer-side state of each wreck in view: when it died (on this
 * renderer's clock) and whether its break-up was played. Created once per
 * wreck (a death event), dropped when the mirror stops listing it.
 */
export class WreckArtState {
  private readonly byId = new Map<number, WreckInfo>();

  constructor(public onBreak: WreckBreakSink | null = null) {}

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
    };
    this.byId.set(desc.wreckId, info);
    const g = pieces[pieceIndex];
    if (ageMs < WRECK_BREAK_FX_MAX_AGE_MS && g !== undefined && this.onBreak !== null) {
      const dx = info.killX - g.cx, dy = info.killY - g.cy;
      const c = Math.cos(pose.angle), sn = Math.sin(pose.angle);
      this.onBreak(pose.x + dx * c - dy * sn, pose.y + dx * sn + dy * c, hullR, info.snap);
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
  private glow: Graphics | null = null;
  private sunFrame = -1;

  constructor(piece: WreckPieceGeometry, parentKind: string, readonly art: ShipArt | null, private readonly info: WreckInfo) {
    super();
    if (art !== null) {
      const L = wreckTexLayout(art);
      // Burnt: darker overall, darkest where the killing blow landed.
      const near = Math.hypot(info.killX - piece.cx, info.killY - piece.cy) / Math.max(1, info.hullR);
      const tint = lerpColor(BURNT_NEAR, BURNT_FAR, Math.min(1, near * 1.6));
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
    // The glow: cut edges only, one white stroke tinted per frame. A wreck
    // already cool when first seen never gets one.
    const runs = cutEdgeRuns(piece.cutEdges);
    if (runs.length > 0 && info.deathMs > -Infinity) {
      const g = new Graphics();
      const core = Math.min(40, Math.max(3, info.hullR * 0.006));
      const o = piece.outline;
      const n = o.length;
      const path = (): void => {
        for (const [start, len] of runs) {
          g.moveTo(o[start]!.x, -o[start]!.y);
          for (let k = 1; k <= len; k++) { const v = o[(start + k) % n]!; g.lineTo(v.x, -v.y); }
        }
      };
      path();
      g.stroke({ width: core * 3.5, color: 0xffffff, alpha: 0.3, cap: 'round', join: 'round' });
      path();
      g.stroke({ width: core, color: 0xffffff, alpha: 1, cap: 'round', join: 'round' });
      this.glow = g;
      this.addChild(g);
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
    const g = this.glow;
    if (g === null) return;
    const ageS = (nowMs - this.info.deathMs) / 1000;
    wreckGlowAt(ageS, _glow);
    if (_glow.alpha <= 0 && ageS >= WRECK_GLOW_END_S) {
      // Cooled for good: the stroke goes (one fewer object per piece).
      this.removeChild(g);
      g.destroy();
      this.glow = null;
      return;
    }
    g.tint = _glow.color;
    g.alpha = _glow.alpha;
  }

  /** The glow's current alpha (0 once cool). */
  glowAlpha(): number {
    return this.glow === null ? 0 : this.glow.alpha;
  }
}
