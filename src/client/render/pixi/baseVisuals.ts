/**
 * Procedural-base VISUAL plan — pure, Pixi-free, unit-testable
 * (plan: soft-leaping-truffle; look: docs/architecture/procedural-bases-research.md §5).
 *
 * Turns a layout into flat draw ops per chunk, so the renderer just replays
 * them into one retained `Graphics` per chunk (built once; rebuilt only when a
 * chunk's destroy mask changes). The look:
 *  - THREE flat tones per solid piece — base fill, a lit top/left edge and a
 *    shadow bottom/right edge (Cryptark-style two-tone lighting, no gradients);
 *  - FUNCTIONAL detail only (rack bay slots, container seams, wall conduits,
 *    loading-bay hazard edges) — no purposeless greebles;
 *  - deterministic WEATHERING: a per-piece hash shifts the tone a little,
 *    breaking up repetition across "endless" rows;
 *  - LIGHT points (gate beacons, rack-end lamps) drawn into a separate layer
 *    whose alpha the renderer pulses on a shared clock (one alpha write per
 *    chunk per frame).
 * Coordinates are PIXI world space (pixiY = -gameY, the renderer rule).
 */
import { basePieceKindAt, type BasePieceKind } from '../../../shared-types/basePieceKinds.js';
import type { BaseLayout } from '../../../core/procgen/baseLayout.js';
import { isPieceDead } from '../../../core/procgen/baseChunkMesh.js';
import { fnvMixU32 } from '../../../core/procgen/rng.js';
import { BASE_CHUNK_SIZE } from '../../../shared-types/baseBudgets.js';

/** A flat rectangle draw (pixi space). */
export interface RectOp { x: number; y: number; w: number; h: number; color: number; alpha: number }
/** A light point (pixi space). */
export interface LightOp { x: number; y: number; r: number; color: number }

export interface ChunkVisual {
  readonly rects: RectOp[];
  readonly lights: LightOp[];
}

/** Base colour per palette slot. */
export const BASE_PALETTE: Record<BasePieceKind['palette'], number> = {
  hull: 0x6b7a8f,
  hullDark: 0x4a5668,
  rack: 0xb9772f,
  cargo: 0x3f8f92,
  habitat: 0x8d9bb3,
  tower: 0x9fb0c9,
  military: 0x7a4a46,
  floor: 0x1d2433,
  accent: 0xe8c547,
};

const LIT = 0.22; // fraction toward white on the lit edge
const SHADE = 0.35; // fraction toward black on the shadow edge
const EDGE = 14; // lit/shadow edge width (u)

export function mixColor(c: number, target: number, t: number): number {
  const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
  const tr = (target >> 16) & 0xff, tg = (target >> 8) & 0xff, tb = target & 0xff;
  const rr = Math.round(r + (tr - r) * t), gg = Math.round(g + (tg - g) * t), bb = Math.round(b + (tb - b) * t);
  return (rr << 16) | (gg << 8) | bb;
}

/** Deterministic per-piece weathering: ±6 % tone shift from the layout seed. */
function weathered(color: number, seed: number, key: number): number {
  const h = fnvMixU32(fnvMixU32(0x811c9dc5, seed), key);
  const t = ((h & 0xff) / 255) * 0.12 - 0.06;
  return t >= 0 ? mixColor(color, 0xffffff, t) : mixColor(color, 0x000000, -t);
}

export function buildChunkVisual(l: BaseLayout, chunk: number, dead?: Uint32Array | null): ChunkVisual {
  const rects: RectOp[] = [];
  const lights: LightOp[] = [];
  const ox = l.descriptor.x;
  const oy = l.descriptor.y;
  for (let i = 0; i < l.count; i++) {
    if (l.chunk[i] !== chunk || isPieceDead(dead, i)) continue;
    const kind = basePieceKindAt(l.kind[i]!);
    // Game-space rect → pixi-space rect (flip Y: top edge = -(y + h)).
    const gx = ox + l.x[i]!;
    const gy = oy + l.y[i]!;
    const w = l.w[i]!;
    const h = l.h[i]!;
    const px = gx;
    const py = -(gy + h);
    const base = weathered(BASE_PALETTE[kind.palette], l.descriptor.seed, weatherKey(l, i));

    if (!kind.solid) {
      // Floors: flat + a hazard-striped rim.
      rects.push({ x: px, y: py, w, h, color: base, alpha: 0.85 });
      hazardRim(rects, px, py, w, h);
      continue;
    }

    rects.push({ x: px, y: py, w, h, color: base, alpha: 1 });
    const e = Math.min(EDGE, Math.floor(Math.min(w, h) / 3));
    if (e > 0) {
      // A side lying on a chunk line is (almost always) where the builder
      // SPLIT one piece — the neighbour continues it. Shading that side would
      // draw a seam across a continuous wall/rack, so skip it.
      const lx0 = l.x[i]!, ly0 = l.y[i]!;
      const cutL = isChunkCut(lx0, l.half), cutR = isChunkCut(lx0 + w, l.half);
      const cutB = isChunkCut(ly0, l.half), cutT = isChunkCut(ly0 + h, l.half); // game bottom/top
      if (!cutT) rects.push({ x: px, y: py, w, h: e, color: mixColor(base, 0xffffff, LIT), alpha: 1 }); // lit top
      if (!cutL) rects.push({ x: px, y: py, w: e, h, color: mixColor(base, 0xffffff, LIT * 0.6), alpha: 1 }); // lit left
      if (!cutB) rects.push({ x: px, y: py + h - e, w, h: e, color: mixColor(base, 0x000000, SHADE), alpha: 1 }); // shadow bottom
      if (!cutR) rects.push({ x: px + w - e, y: py, w: e, h, color: mixColor(base, 0x000000, SHADE * 0.7), alpha: 1 }); // shadow right
    }
    detail(kind.id, rects, lights, px, py, w, h, base);
  }
  return { rects, lights };
}

/**
 * Weathering key shared by every split half of one parent piece: a piece cut
 * at a chunk line keys on its UNCUT axis only (both halves share it), so a
 * continuous rack/wall gets one tone instead of a visible tone seam.
 */
function weatherKey(l: BaseLayout, i: number): number {
  const x0 = l.x[i]!, y0 = l.y[i]!, x1 = x0 + l.w[i]!, y1 = y0 + l.h[i]!;
  const cutY = isChunkCut(y0, l.half) || isChunkCut(y1, l.half);
  const cutX = isChunkCut(x0, l.half) || isChunkCut(x1, l.half);
  let h = fnvMixU32(0x811c9dc5, l.kind[i]!);
  if (!cutX) { h = fnvMixU32(h, x0 >>> 0); h = fnvMixU32(h, x1 >>> 0); }
  if (!cutY) { h = fnvMixU32(h, y0 >>> 0); h = fnvMixU32(h, y1 >>> 0); }
  return h;
}

/** True when a base-local coordinate lies on an interior chunk line. */
function isChunkCut(v: number, half: number): boolean {
  const off = v + half;
  return off > 0 && off < 2 * half && off % BASE_CHUNK_SIZE === 0;
}

function hazardRim(out: RectOp[], x: number, y: number, w: number, h: number): void {
  const t = 18;
  const stripe = 90;
  for (let s = 0; s < w; s += stripe * 2) {
    const sw = Math.min(stripe, w - s);
    out.push({ x: x + s, y, w: sw, h: t, color: BASE_PALETTE.accent, alpha: 0.7 });
    out.push({ x: x + s, y: y + h - t, w: sw, h: t, color: BASE_PALETTE.accent, alpha: 0.7 });
  }
}

/** Functional detail per kind. */
function detail(id: string, rects: RectOp[], lights: LightOp[], x: number, y: number, w: number, h: number, base: number): void {
  const dark = mixColor(base, 0x000000, 0.45);
  if (id === 'rack_row') {
    // Bay slots across the long axis + a centre spine (a double-sided rack).
    const along = w >= h;
    const len = along ? w : h;
    const depth = along ? h : w;
    const bay = 120;
    for (let s = bay; s < len - 8; s += bay) {
      if (along) rects.push({ x: x + s, y: y + 16, w: 6, h: depth - 32, color: dark, alpha: 0.9 });
      else rects.push({ x: x + 16, y: y + s, w: depth - 32, h: 6, color: dark, alpha: 0.9 });
    }
    if (along) rects.push({ x: x + 10, y: y + depth / 2 - 3, w: len - 20, h: 6, color: dark, alpha: 0.8 });
    else rects.push({ x: x + depth / 2 - 3, y: y + 10, w: 6, h: len - 20, color: dark, alpha: 0.8 });
    // End lamps.
    if (along) {
      lights.push({ x: x + 16, y: y + depth / 2, r: 10, color: 0xffd27a });
      lights.push({ x: x + w - 16, y: y + depth / 2, r: 10, color: 0xffd27a });
    } else {
      lights.push({ x: x + depth / 2, y: y + 16, r: 10, color: 0xffd27a });
      lights.push({ x: x + depth / 2, y: y + h - 16, r: 10, color: 0xffd27a });
    }
  } else if (id === 'container_stack') {
    // Corrugation seams.
    for (let s = 30; s < Math.max(w, h) - 15; s += 34) {
      if (w >= h) rects.push({ x: x + s, y: y + 8, w: 5, h: h - 16, color: dark, alpha: 0.6 });
      else rects.push({ x: x + 8, y: y + s, w: w - 16, h: 5, color: dark, alpha: 0.6 });
    }
  } else if (id === 'wall') {
    // Conduit dashes along the wall.
    const along = w >= h;
    const len = along ? w : h;
    for (let s = 50; s < len - 50; s += 220) {
      const dash = Math.min(120, len - 50 - s); // never run past the wall end
      if (along) rects.push({ x: x + s, y: y + h / 2 - 5, w: dash, h: 10, color: dark, alpha: 0.7 });
      else rects.push({ x: x + w / 2 - 5, y: y + s, w: 10, h: dash, color: dark, alpha: 0.7 });
    }
  } else if (id === 'gate_post') {
    lights.push({ x: x + w / 2, y: y + h / 2, r: Math.max(6, Math.min(w, h) / 3), color: 0x7cf7ff });
  }
}

/**
 * Chunks whose pixi-space AABB overlaps the view rect [minX, minY, maxX, maxY]
 * (pixi space). Writes 1/0 per chunk into `out`; returns the visible count.
 * Pure + allocation-free (the per-frame cull).
 */
export function cullChunks(
  l: BaseLayout,
  view: Float64Array,
  out: Uint8Array,
  margin = 64,
): number {
  let n = 0;
  const size = BASE_CHUNK_SIZE;
  for (let c = 0; c < out.length; c++) {
    const cx = c % l.chunksAcross;
    const cy = (c - cx) / l.chunksAcross;
    const gx0 = l.descriptor.x - l.half + cx * size;
    const gy0 = l.descriptor.y - l.half + cy * size;
    // Game [gy0, gy0+size] → pixi [-(gy0+size), -gy0].
    const px0 = gx0 - margin, px1 = gx0 + size + margin;
    const py0 = -(gy0 + size) - margin, py1 = -gy0 + margin;
    const vis = px1 >= view[0]! && px0 <= view[2]! && py1 >= view[1]! && py0 <= view[3]!;
    out[c] = vis ? 1 : 0;
    if (vis) n++;
  }
  return n;
}

/** Below this zoom a base draws as one silhouette instead of its chunks. */
export function useSilhouette(zoom: number, lodZoom: number): boolean {
  return zoom < lodZoom;
}

/** Debris fragment fields per entry in a flat Float32Array. */
export const DEBRIS_STRIDE = 8; // x, y, vx, vy, size, color, life, spin
export const DEBRIS_LIFE_MS = 1400;

/**
 * Debris for newly destroyed pieces (PR-D): fragments scattered over each
 * piece's area flying outward, count scaled by area (6–24 per piece), colour
 * from the piece's palette. Deterministic (hash of piece index), pixi space.
 * Writes into `out` starting at fragment `start`; returns the next free slot
 * (stops at capacity).
 */
export function spawnDebris(l: BaseLayout, pieces: readonly number[], out: Float32Array, start: number): number {
  const cap = Math.floor(out.length / DEBRIS_STRIDE);
  let n = start;
  for (const i of pieces) {
    const kind = basePieceKindAt(l.kind[i]!);
    const w = l.w[i]!, h = l.h[i]!;
    const gx = l.descriptor.x + l.x[i]!, gy = l.descriptor.y + l.y[i]!;
    const cx = gx + w / 2, cy = -(gy + h / 2); // pixi space centre
    const count = Math.max(6, Math.min(24, Math.round((w * h) / 20000)));
    for (let k = 0; k < count && n < cap; k++, n++) {
      let hh = fnvMixU32(fnvMixU32(0x811c9dc5, i), k);
      const r1 = (hh & 0xffff) / 0xffff; hh = fnvMixU32(hh, 7);
      const r2 = (hh & 0xffff) / 0xffff; hh = fnvMixU32(hh, 11);
      const r3 = (hh & 0xffff) / 0xffff;
      const px = gx + r1 * w, py = -(gy + r2 * h);
      const dx = px - cx, dy = py - cy;
      const d = Math.hypot(dx, dy) || 1;
      const speed = 60 + r3 * 220;
      const o = n * DEBRIS_STRIDE;
      out[o] = px; out[o + 1] = py;
      out[o + 2] = (dx / d) * speed; out[o + 3] = (dy / d) * speed;
      out[o + 4] = 10 + r3 * Math.min(60, Math.min(w, h) * 0.4);
      out[o + 5] = BASE_PALETTE[kind.palette];
      out[o + 6] = DEBRIS_LIFE_MS;
      out[o + 7] = (r1 - 0.5) * 6;
    }
  }
  return n;
}
