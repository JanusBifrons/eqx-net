/**
 * Edge feel P2 mock-ups (`?edgeLook=a|b|c`): three looks for the deck fence
 * posts (`shield_pylon`) and the shield link between them, for the owner to
 * pick from stills. Absent or anything else = `off` = today's look, untouched.
 *
 *  a "Light sheet": round emitter, bright cyan cap, soft glow ring; link = a
 *    wide translucent band with a bright thin core line.
 *  b "Hex field": squat hex emitter block, two prongs along the seam; link =
 *    a translucent band with a faint hex-cell row and brighter edges.
 *  c "Pylon fork": taller pylon with a fork head, a bright node at each tine
 *    tip; link = two thin bright lines (the field's edges), very faint fill.
 *
 * The link body (and the seam-facing parts of a post: b's prongs, c's fork)
 * draw on the connector STATIC layer from `drawFenceBeamBody`, since only the
 * link knows the seam's direction; the post's emitter draws over its body on
 * the pylon's existing body-status overlay (`structureStyleC.fences.ts`
 * `status`). Unpowered / wall down: no field (the link keeps today's dim
 * line), the post's lights go dead. Static only, allocation-free.
 */
import type { LinePath } from './connectorLineLooks.js';
import { SHIELD_WALL_CORE_COLOR, SHIELD_WALL_GLOW_COLOR, SHIELD_WALL_SHIMMER_COLOR } from './connectorVisual.js';

/** The P2 mock-up look: `off` = today's. */
export type EdgeLook = 'off' | 'a' | 'b' | 'c';

export const DEFAULT_EDGE_LOOK: EdgeLook = 'off';

/** `?edgeLook=a|b|c`; absent or unknown = {@link DEFAULT_EDGE_LOOK}. */
export function readEdgeLook(search: string): EdgeLook {
  const m = /[?&]edgeLook=(a|b|c)(?![\w-])/.exec(search);
  return m ? (m[1] as EdgeLook) : DEFAULT_EDGE_LOOK;
}

/** The post look the pylon's body-status hook reads (one renderer per
 *  thread; set at init by `applyRestyleLook`). */
export const edgePost: { look: EdgeLook } = { look: DEFAULT_EDGE_LOOK };

/** 0 for `off`, else 1..3 (the body-status code's variant digit). */
export function edgeLookIndex(look: EdgeLook): number {
  return look === 'a' ? 1 : look === 'b' ? 2 : look === 'c' ? 3 : 0;
}
const LOOKS: readonly EdgeLook[] = ['off', 'a', 'b', 'c'];
export function edgeLookOfIndex(i: number): EdgeLook { return LOOKS[i] ?? 'off'; }

// ── Colours ──────────────────────────────────────────────────────────────────
const CAP_BRIGHT = 0xbff8ff;
const CAP_WHITE = 0xf2feff;
const BODY_DARK = 0x1b2328;
const BODY_EDGE = 0x3c4a52;
const DEAD = 0x16262a;
const DEAD_EDGE = 0x2a3a3f;

/** Link sizes, × the cable look's width (screen-constant). */
export const EDGE_A_BAND = 3.4;
export const EDGE_A_CORE = 0.3;
export const EDGE_B_HALF = 1.6;
export const EDGE_C_HALF = 1.2;
/** Hex cells per link at most (b). */
const MAX_CELLS = 48;

const _style = { color: 0, alpha: 0, width: 0 };
function stroke(g: LinePath, color: number, alpha: number, width: number): void {
  _style.color = color; _style.alpha = alpha; _style.width = width;
  g.stroke(_style);
}
const _fill = { color: 0, alpha: 0 };
function fill(g: LinePath, color: number, alpha: number): void {
  _fill.color = color; _fill.alpha = alpha;
  g.fill(_fill);
}

/** A quad band of half width `h` from (x0,y0) to (x1,y1), normal (nx,ny). */
function band(g: LinePath, x0: number, y0: number, x1: number, y1: number, nx: number, ny: number, h: number): void {
  g.moveTo(x0 + nx * h, y0 + ny * h); g.lineTo(x1 + nx * h, y1 + ny * h);
  g.lineTo(x1 - nx * h, y1 - ny * h); g.lineTo(x0 - nx * h, y0 - ny * h); g.closePath();
}
function line(g: LinePath, x0: number, y0: number, x1: number, y1: number): void {
  g.moveTo(x0, y0); g.lineTo(x1, y1);
}

/** A flat hex outline (one subpath) at (cx,cy), radius r, axis (ux,uy). */
function hexOutline(g: LinePath, cx: number, cy: number, r: number, ux: number, uy: number): void {
  for (let i = 0; i <= 6; i++) {
    const a = (i % 6) * (Math.PI / 3), ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    const x = cx + ux * ca - uy * sa, y = cy + uy * ca + ux * sa;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
}

/**
 * One lit link (pixi space) in look `look` ≠ off, from the post at (ax, ay)
 * to the post at (bx, by); (x0,y0)-(x1,y1) is the field span (just outside
 * each post), (ux,uy) its unit axis, `w` the cable look's width, `ra`/`rb`
 * the posts' radii.
 */
export function drawEdgeLinkUp(
  g: LinePath, look: EdgeLook, ax: number, ay: number, bx: number, by: number,
  x0: number, y0: number, x1: number, y1: number, ux: number, uy: number, w: number, ra: number, rb: number,
): void {
  const nx = -uy, ny = ux;
  if (look === 'a') {
    line(g, x0, y0, x1, y1); stroke(g, SHIELD_WALL_GLOW_COLOR, 0.16, w * EDGE_A_BAND);
    line(g, x0, y0, x1, y1); stroke(g, SHIELD_WALL_GLOW_COLOR, 0.22, w * EDGE_A_BAND * 0.45);
    line(g, x0, y0, x1, y1); stroke(g, SHIELD_WALL_SHIMMER_COLOR, 0.95, w * EDGE_A_CORE);
    return;
  }
  if (look === 'b') {
    const h = w * EDGE_B_HALF;
    band(g, x0, y0, x1, y1, nx, ny, h); fill(g, SHIELD_WALL_GLOW_COLOR, 0.14);
    // One row of hex cells along the axis, as many as fit (capped).
    const len = Math.hypot(x1 - x0, y1 - y0);
    const r = h * 0.62, pitch0 = r * 1.75;
    const n = Math.max(1, Math.min(MAX_CELLS, Math.floor(len / pitch0)));
    const pitch = len / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * pitch;
      hexOutline(g, x0 + ux * t, y0 + uy * t, Math.min(r, pitch * 0.55), ux, uy);
    }
    stroke(g, SHIELD_WALL_CORE_COLOR, 0.32, w * 0.12);
    line(g, x0 + nx * h, y0 + ny * h, x1 + nx * h, y1 + ny * h);
    line(g, x0 - nx * h, y0 - ny * h, x1 - nx * h, y1 - ny * h);
    stroke(g, SHIELD_WALL_CORE_COLOR, 0.9, w * 0.2);
    prongs(g, ax, ay, ux, uy, nx, ny, ra, h);
    prongs(g, bx, by, -ux, -uy, nx, ny, rb, h);
    return;
  }
  // c
  const h = w * EDGE_C_HALF;
  band(g, x0, y0, x1, y1, nx, ny, h); fill(g, SHIELD_WALL_GLOW_COLOR, 0.06);
  line(g, x0 + nx * h, y0 + ny * h, x1 + nx * h, y1 + ny * h);
  line(g, x0 - nx * h, y0 - ny * h, x1 - nx * h, y1 - ny * h);
  stroke(g, SHIELD_WALL_SHIMMER_COLOR, 0.95, w * 0.22);
  fork(g, ax, ay, ux, uy, nx, ny, ra, h, w);
  fork(g, bx, by, -ux, -uy, nx, ny, rb, h, w);
}

/** b: two emitter prongs from post (px,py) toward the field along (ux,uy). */
function prongs(g: LinePath, px: number, py: number, ux: number, uy: number, nx: number, ny: number, r: number, h: number): void {
  const i0 = r * 0.45, i1 = r * 0.95, o = h * 0.7;
  for (let s = -1; s <= 1; s += 2) {
    const ox = nx * o * s, oy = ny * o * s;
    line(g, px + ux * i0 + ox, py + uy * i0 + oy, px + ux * i1 + ox, py + uy * i1 + oy);
  }
  stroke(g, BODY_EDGE, 1, h * 0.55);
  for (let s = -1; s <= 1; s += 2) {
    const ox = nx * o * s, oy = ny * o * s;
    line(g, px + ux * i0 + ox, py + uy * i0 + oy, px + ux * i1 + ox, py + uy * i1 + oy);
  }
  stroke(g, SHIELD_WALL_CORE_COLOR, 0.85, h * 0.18);
}

/** c: the fork head at post (px,py) facing (ux,uy): a crossbar, two tines
 *  out to the field's edge lines, a bright node at each tip. */
function fork(g: LinePath, px: number, py: number, ux: number, uy: number, nx: number, ny: number, r: number, h: number, w: number): void {
  const bx = px + ux * r * 0.55, by = py + uy * r * 0.55, tx = px + ux * r * 0.92, ty = py + uy * r * 0.92;
  line(g, bx - nx * h, by - ny * h, bx + nx * h, by + ny * h);
  for (let s = -1; s <= 1; s += 2) line(g, bx + nx * h * s, by + ny * h * s, tx + nx * h * s, ty + ny * h * s);
  stroke(g, BODY_EDGE, 1, w * 0.35);
  const nr = Math.max(w * 0.42, r * 0.06);
  for (let s = -1; s <= 1; s += 2) g.circle(tx + nx * h * s, ty + ny * h * s, nr * 1.9);
  fill(g, SHIELD_WALL_GLOW_COLOR, 0.25);
  for (let s = -1; s <= 1; s += 2) g.circle(tx + nx * h * s, ty + ny * h * s, nr);
  fill(g, CAP_WHITE, 1);
}

// ── Post emitter (body-status overlay, structure-local Pixi frame) ───────────

/**
 * The post's emitter in look `look` ≠ off, over the baked pylon body; `k` =
 * footprint / 120. `live`: built and powered (lights on), else dead glass and
 * no glow.
 */
export function drawEdgePost(g: LinePath, look: EdgeLook, live: boolean, k: number): void {
  if (look === 'a') {
    if (live) {
      g.circle(0, 0, 44 * k); stroke(g, SHIELD_WALL_GLOW_COLOR, 0.22, 16 * k);
      g.circle(0, 0, 36 * k); stroke(g, SHIELD_WALL_CORE_COLOR, 0.85, 3 * k);
    } else {
      g.circle(0, 0, 36 * k); stroke(g, DEAD_EDGE, 1, 3 * k);
    }
    g.circle(0, 0, 26 * k); fill(g, BODY_DARK, 1);
    g.circle(0, 0, 26 * k); stroke(g, BODY_EDGE, 1, 2.5 * k);
    g.circle(0, 0, 18 * k); fill(g, live ? SHIELD_WALL_GLOW_COLOR : DEAD, 1);
    g.circle(0, 0, 11 * k); fill(g, live ? CAP_BRIGHT : DEAD, 1);
    if (live) { g.circle(0, 0, 5 * k); fill(g, CAP_WHITE, 1); }
    return;
  }
  if (look === 'b') {
    hexOutline(g, 0, 0, 42 * k, 1, 0); g.closePath(); fill(g, BODY_DARK, 1);
    hexOutline(g, 0, 0, 42 * k, 1, 0); stroke(g, live ? SHIELD_WALL_CORE_COLOR : DEAD_EDGE, live ? 0.9 : 1, 3 * k);
    hexOutline(g, 0, 0, 26 * k, 1, 0); g.closePath(); fill(g, live ? SHIELD_WALL_GLOW_COLOR : DEAD, live ? 0.55 : 1);
    hexOutline(g, 0, 0, 26 * k, 1, 0); stroke(g, live ? CAP_BRIGHT : DEAD_EDGE, 1, 2 * k);
    if (live) { hexOutline(g, 0, 0, 10 * k, 1, 0); g.closePath(); fill(g, CAP_WHITE, 1); }
    return;
  }
  // c: a taller pylon (a wider mast with a raised collar) and a bright node.
  if (live) { g.circle(0, 0, 40 * k); stroke(g, SHIELD_WALL_GLOW_COLOR, 0.16, 10 * k); }
  g.circle(0, 0, 34 * k); fill(g, BODY_DARK, 1);
  g.circle(0, 0, 34 * k); stroke(g, BODY_EDGE, 1, 3 * k);
  g.circle(0, 0, 22 * k); fill(g, 0x2a343a, 1);
  g.circle(0, 0, 22 * k); stroke(g, live ? SHIELD_WALL_CORE_COLOR : DEAD_EDGE, 0.9, 2.5 * k);
  g.circle(0, 0, 12 * k); fill(g, live ? CAP_BRIGHT : DEAD, 1);
  if (live) { g.circle(0, 0, 5 * k); fill(g, CAP_WHITE, 1); }
}
