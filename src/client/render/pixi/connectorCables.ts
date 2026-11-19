/**
 * Structure restyle 0d slice 8 — socket cables on the connector web. Helpers
 * for `ConnectorRenderer` (not a renderer of their own):
 *
 *  - `LinkCableCache`: each live link's flattened cable, cached per link and
 *    re-flattened only when the link's ends (pose, kind) or its stored
 *    sockets change. The curve is core `flattenLinkCable`, the same one the
 *    server's `canConnect` tested (root invariant #15): it leaves each socket
 *    along its outward normal; a fence link (no socket) is the straight post
 *    to post line.
 *  - The cable look (static body + per-frame flow) and the placement preview
 *    line, drawn along a cached polyline by arc length.
 *  - Slice 9: the flow is a train of comets leaving the source socket at a
 *    per-material speed in game time, and each comet that reaches the
 *    receiving socket flashes its collar (`flowTrainInto`, `collarFlash`).
 *    Only state the client has (#16): the link's flow flash, source and
 *    material; when flow starts is noted on the cached link.
 *
 * The look is behind the new-effects flag (`ArtOptions.fx`, `?fx=new`):
 * `ConnectorRenderer.socketCables`. Off = today's straight lines, untouched.
 *
 * Allocation-free per frame (invariant #14): cache entries are pooled; a
 * new entry is allocated only when a link first appears beyond the pool.
 */
import type { SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import type { GridNode } from '../../../core/structures/Grid.js';
import {
  CABLE_CURVE_FLOATS, CABLE_CURVE_SEGMENTS, CABLE_NO_SOCKET, flattenLinkCable, makeCableBox,
} from '../../../core/structures/cableCurve.js';
import { isShieldEmitterKind } from '../../../core/structures/gateGeometry.js';
import { blankGridNode } from '../../structures/mirrorToGridNode.js';
import { lineLookBaseWidth, lineLookScale, mixColor, type LinePath } from './connectorLineLooks.js';
import { CONNECTOR_IDLE_COLOR, type ConnectorFlowMaterial, type ConnectorVisual } from './connectorVisual.js';

/** Points in a cable polyline. */
export const CABLE_POINTS = CABLE_CURVE_SEGMENTS + 1;

/** One link's cable in Pixi space (y down), with its arc lengths. */
export interface LinkCable {
  /** x0, y0, x1, y1, … (`n` points; Pixi space). */
  readonly poly: Float64Array;
  /** Arc length from the first point to each point. */
  readonly cum: Float64Array;
  /** Points in use (`CABLE_POINTS`, or 2 for a plain straight preview line). */
  n: number;
  /** Total arc length. */
  len: number;
  /** Socket to socket (end collars); false for a straight fence link. */
  socketed: boolean;
  // What the curve was flattened from (the cache's change check).
  ax: number; ay: number; aa: number; ak: string; sa: number;
  bx: number; by: number; ba: number; bk: string; sb: number;
  gen: number;
  /** Slice 9: game ms this link's current run of flow started, and the
   *  last frame it was drawn flowing (a gap means the flow stopped). */
  flowSince: number;
  flowSeen: number;
}

export function makeLinkCable(): LinkCable {
  return {
    poly: new Float64Array(CABLE_CURVE_FLOATS), cum: new Float64Array(CABLE_POINTS), n: 0, len: 0, socketed: false,
    ax: NaN, ay: 0, aa: 0, ak: '', sa: CABLE_NO_SOCKET, bx: 0, by: 0, ba: 0, bk: '', sb: CABLE_NO_SOCKET, gen: 0,
    flowSince: 0, flowSeen: -Infinity,
  };
}

const _box = makeCableBox();
const _world = new Float64Array(CABLE_CURVE_FLOATS);

/** Arc lengths of `out`'s first `out.n` points. */
function measure(out: LinkCable): void {
  const p = out.poly, cum = out.cum;
  cum[0] = 0;
  let s = 0;
  for (let i = 1; i < out.n; i++) {
    s += Math.hypot(p[i * 2]! - p[i * 2 - 2]!, p[i * 2 + 1]! - p[i * 2 - 1]!);
    cum[i] = s;
  }
  out.len = s;
}

/** Flatten the link a (socket `sa`) -> b (socket `sb`) into `out`, in Pixi
 *  space: core `flattenLinkCable` (game space, y up), y flipped. */
export function fillLinkCable(out: LinkCable, a: GridNode, sa: number, b: GridNode, sb: number): void {
  flattenLinkCable(a, sa, b, sb, _world, _box);
  for (let i = 0; i < CABLE_POINTS; i++) {
    out.poly[i * 2] = _world[i * 2]!;
    out.poly[i * 2 + 1] = -_world[i * 2 + 1]!;
  }
  out.n = CABLE_POINTS;
  out.socketed = sa !== CABLE_NO_SOCKET && sb !== CABLE_NO_SOCKET;
  measure(out);
}

/** A plain two-point line (Pixi space): the preview's straight lines. */
export function fillStraight(out: LinkCable, ax: number, ay: number, bx: number, by: number): void {
  out.poly[0] = ax; out.poly[1] = ay; out.poly[2] = bx; out.poly[3] = by;
  out.n = 2;
  out.socketed = false;
  measure(out);
}

/** Write a structure's link-curve inputs into a reused node (only what
 *  `flattenLinkCable` reads: pose, kind, any-side flags). */
function endNode(e: SwarmRenderState, out: GridNode): GridNode {
  const kind = e.shipKind ?? '';
  out.kind = kind;
  out.x = e.x;
  out.y = e.y;
  out.rot = e.angle;
  out.isConnector = kind === 'connector';
  out.isShieldPylon = isShieldEmitterKind(kind);
  return out;
}

/**
 * Per-link flattened cables, keyed by the renderer's packed edge key.
 * `get` re-flattens only when an end's pose / kind or a socket changed;
 * `beginSweep` / `endSweep` around a full walk return links that are gone
 * to the pool.
 */
export class LinkCableCache {
  private readonly map = new Map<number, LinkCable>();
  private readonly free: LinkCable[] = [];
  private gen = 0;
  private readonly nodeA = blankGridNode();
  private readonly nodeB = blankGridNode();
  /** Test hook: how many times a curve was flattened. */
  flattens = 0;

  get size(): number { return this.map.size; }

  get(key: number, a: SwarmRenderState, sa: number, b: SwarmRenderState, sb: number): LinkCable {
    let c = this.map.get(key);
    if (c === undefined) {
      c = this.free.pop() ?? makeLinkCable();
      c.ax = NaN;
      c.flowSeen = -Infinity;
      this.map.set(key, c);
    }
    c.gen = this.gen;
    const ak = a.shipKind ?? '', bk = b.shipKind ?? '';
    if (c.ax !== a.x || c.ay !== a.y || c.aa !== a.angle || c.ak !== ak || c.sa !== sa
      || c.bx !== b.x || c.by !== b.y || c.ba !== b.angle || c.bk !== bk || c.sb !== sb) {
      fillLinkCable(c, endNode(a, this.nodeA), sa, endNode(b, this.nodeB), sb);
      c.ax = a.x; c.ay = a.y; c.aa = a.angle; c.ak = ak; c.sa = sa;
      c.bx = b.x; c.by = b.y; c.ba = b.angle; c.bk = bk; c.sb = sb;
      this.flattens++;
    }
    return c;
  }

  /** The cached cable for `key`, or undefined (no flattening). */
  peek(key: number): LinkCable | undefined { return this.map.get(key); }

  beginSweep(): void { this.gen++; }

  /** Drop every link not `get` since `beginSweep`. */
  endSweep(): void {
    for (const key of this.map.keys()) {
      const c = this.map.get(key)!;
      if (c.gen === this.gen) continue;
      this.map.delete(key);
      this.free.push(c);
    }
  }

  clear(): void {
    for (const c of this.map.values()) this.free.push(c);
    this.map.clear();
  }
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const _style = { color: 0, alpha: 0, width: 0 };
function stroke(g: LinePath, color: number, alpha: number, width: number): void {
  _style.color = color;
  _style.alpha = alpha;
  _style.width = width;
  g.stroke(_style);
}

/** The whole polyline, offset (`ox`, `oy`). */
function path(g: LinePath, c: LinkCable, ox = 0, oy = 0): void {
  const p = c.poly;
  g.moveTo(p[0]! + ox, p[1]! + oy);
  for (let i = 1; i < c.n; i++) g.lineTo(p[i * 2]! + ox, p[i * 2 + 1]! + oy);
}

/** Coordinate `k` (0 = x, 1 = y) at arc length `s` on segment j-1 -> j. */
function lerpAt(c: LinkCable, j: number, s: number, k: 0 | 1): number {
  const p = c.poly, cum = c.cum;
  const d = cum[j]! - cum[j - 1]!;
  const t = d > 0 ? (s - cum[j - 1]!) / d : 0;
  return p[(j - 1) * 2 + k]! + (p[j * 2 + k]! - p[(j - 1) * 2 + k]!) * t;
}

/** The part of the polyline between arc lengths `s0` <= `s1`. */
function pathRange(g: LinePath, c: LinkCable, s0: number, s1: number): void {
  const p = c.poly, cum = c.cum;
  let i = 1;
  while (i < c.n - 1 && cum[i]! < s0) i++;
  // Segment i-1 -> i holds s0.
  g.moveTo(lerpAt(c, i, s0, 0), lerpAt(c, i, s0, 1));
  while (i < c.n - 1 && cum[i]! < s1) {
    g.lineTo(p[i * 2]!, p[i * 2 + 1]!);
    i++;
  }
  g.lineTo(lerpAt(c, i, s1, 0), lerpAt(c, i, s1, 1));
}

// House style: dark grey plates, cyan accents; a breath of the idle blue
// keeps the sheath in the connector palette.
const SHADOW = 0x081014;
const OUTLINE = 0x0a0d0f;
const SHEATH = mixColor(CONNECTOR_IDLE_COLOR, 0x2a3035, 0.86);
const CORE_HI = mixColor(CONNECTOR_IDLE_COLOR, 0x7f8c93, 0.8);
const PLATE = mixColor(CONNECTOR_IDLE_COLOR, 0x4b5459, 0.88);
const PLATE_HI = 0x9aa5ab;
const ACCENT = 0x5fd8ff;
/** Light from the top-left of the screen (as the line looks). */
const SHADOW_DX = 0.6;
const SHADOW_DY = 0.8;

/** One cable's sheath width (world units) at this zoom: the cable line
 *  look's authored width with its zoom floor, a single strand. */
export function socketCableWidth(scale: number): number {
  return lineLookBaseWidth('cable') * lineLookScale('cable', scale) * 0.62;
}

/** Where a socket's collar sits: the socket point and the unit direction
 *  into the cable, the collar length `L`, and its accent ring point. */
interface CollarFrame { x: number; y: number; ux: number; uy: number; L: number; rx: number; ry: number }
const _frame: CollarFrame = { x: 0, y: 0, ux: 0, uy: 0, L: 0, rx: 0, ry: 0 };

/** Fill `out` with the collar at the polyline's first point, or its last
 *  (`atEnd`, direction reversed). False when the end segment is degenerate. */
function collarFrame(c: LinkCable, atEnd: boolean, w: number, out: CollarFrame): boolean {
  const p = c.poly;
  const i0 = atEnd ? c.n - 1 : 0, i1 = atEnd ? c.n - 2 : 1;
  const x = p[i0 * 2]!, y = p[i0 * 2 + 1]!;
  const dx = p[i1 * 2]! - x, dy = p[i1 * 2 + 1]! - y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return false;
  out.x = x; out.y = y;
  out.ux = dx / d; out.uy = dy / d;
  out.L = Math.min(w * 1.1, d * 0.8);
  out.rx = x + out.ux * out.L * 0.78; out.ry = y + out.uy * out.L * 0.78;
  return true;
}

/** A strain-relief collar at a socket: a short plate band across the cable
 *  where it leaves the socket, with a cyan accent line at its outer edge.
 *  `atEnd` = the polyline's last point (direction reversed). */
function collar(g: LinePath, c: LinkCable, atEnd: boolean, w: number): void {
  const f = _frame;
  if (!collarFrame(c, atEnd, w, f)) return;
  const x = f.x, y = f.y, ux = f.ux, uy = f.uy, L = f.L;
  g.moveTo(x, y).lineTo(x + ux * L, y + uy * L); stroke(g, OUTLINE, 1, w * 1.75);
  g.moveTo(x, y).lineTo(x + ux * L * 0.92, y + uy * L * 0.92); stroke(g, PLATE, 1, w * 1.45);
  // Lit top edge of the plate, then the accent ring at its outer edge.
  g.moveTo(x - uy * w * 0.5, y + ux * w * 0.5).lineTo(x + ux * L * 0.85 - uy * w * 0.5, y + uy * L * 0.85 + ux * w * 0.5);
  stroke(g, PLATE_HI, 0.35, w * 0.16);
  const h = w * 0.72;
  g.moveTo(f.rx - uy * h, f.ry + ux * h).lineTo(f.rx + uy * h, f.ry - ux * h); stroke(g, ACCENT, 0.85, w * 0.2);
}

/** The cable's steady body (static layer): cast shadow, dark outline,
 *  sheath, a lighter core highlight, and a collar at each socket. */
export function drawSocketCableBody(g: LinePath, c: LinkCable, scale: number): void {
  if (c.n < 2 || c.len < 1) return;
  const w = socketCableWidth(scale);
  path(g, c, SHADOW_DX * w * 0.5, SHADOW_DY * w * 0.5); stroke(g, SHADOW, 0.5, w * 1.5);
  path(g, c); stroke(g, OUTLINE, 0.95, w * 1.3);
  path(g, c); stroke(g, SHEATH, 1, w);
  path(g, c); stroke(g, CORE_HI, 0.55, w * 0.26);
  if (c.socketed) {
    collar(g, c, false, w);
    collar(g, c, true, w);
  }
}

// ── Flow (slice 9): a comet train by arc length, in game time ───────────────

/** Comet half length (screen px), as `cometSegment`. */
const COMET_HALF_PX = 12;
/** Most comets on one cable at once (bounds the per-frame path work). */
export const MAX_CABLE_COMETS = 4;
/** A link not drawn flowing for this long (game ms) starts a new run: its
 *  first comet leaves the source socket again. */
export const FLOW_RESTART_GAP_MS = 1000;
/** How long a socket collar flashes when a comet reaches it (game ms). */
export const COLLAR_FLASH_MS = 240;

/** Comet speed (world units per game second) and spacing (world units) per
 *  flow material. The client knows a link's material but not its throughput
 *  (#16: no new wire field), so the material sets the pace: ore crawls in a
 *  dense train, power races. */
const TRAIN_SPEED: Readonly<Record<ConnectorFlowMaterial, number>> = { minerals: 220, repair: 280, construction: 320, power: 440 };
const TRAIN_SPACING: Readonly<Record<ConnectorFlowMaterial, number>> = { minerals: 170, repair: 200, construction: 210, power: 170 };

/** One link's comet train this frame. Comet `k` (0 = the first to leave)
 *  is at arc length `d - k * spacing` from the source; it is drawn while
 *  that lies on the cable. */
export interface FlowTrain {
  /** World units per game second. */
  speed: number;
  /** Arc length between comets (widened on a long cable so at most
   *  `MAX_CABLE_COMETS` ride it). */
  spacing: number;
  /** How far the first comet has travelled since the flow started. */
  d: number;
}

/** The train of a cable `len` long that has flowed for `elapsedMs` game ms. */
export function flowTrainInto(out: FlowTrain, len: number, elapsedMs: number, material: ConnectorFlowMaterial): FlowTrain {
  out.speed = TRAIN_SPEED[material];
  out.spacing = Math.max(TRAIN_SPACING[material], len / MAX_CABLE_COMETS);
  out.d = Math.max(0, elapsedMs) * out.speed / 1000;
  return out;
}

/** Arc length (from the source) of the comet nearest the receiving end that
 *  is still on the cable; the rest follow `spacing` behind it. */
export function leadCometArc(t: FlowTrain, len: number): number {
  if (t.d <= len) return t.d;
  return len - ((t.d - len) % t.spacing);
}

/** The receiving collar's flash: 1 the instant a comet arrives, easing to 0
 *  over `COLLAR_FLASH_MS`; 0 before the first arrival. */
export function collarFlash(t: FlowTrain, len: number): number {
  if (t.d < len || t.speed <= 0) return 0;
  const sinceMs = ((t.d - len) % t.spacing) / t.speed * 1000;
  return sinceMs < COLLAR_FLASH_MS ? 1 - sinceMs / COLLAR_FLASH_MS : 0;
}

const _train: FlowTrain = { speed: 0, spacing: 0, d: 0 };

/** The flow of an ACTIVE link (per-frame layer): a faint bleed, the lit core
 *  in the flow colour, the comet train leaving the source socket
 *  (`sourceIsLo`: the polyline's first point) at the material's pace in game
 *  time (`nowMs` = `fxNow`, #20), all comets in one stroke, and the
 *  receiving socket's collar flash as each comet arrives. The static body
 *  is not touched. */
export function drawSocketCableFlow(
  g: LinePath, c: LinkCable, v: ConnectorVisual, sourceIsLo: boolean, scale: number,
  nowMs: number, material: ConnectorFlowMaterial,
): void {
  if (c.n < 2 || c.len < 1) return;
  // A new run of flow (first frame, or after a gap): the train restarts.
  if (!(nowMs - c.flowSeen <= FLOW_RESTART_GAP_MS) || nowMs < c.flowSeen) c.flowSince = nowMs;
  c.flowSeen = nowMs;
  const w = socketCableWidth(scale);
  if (v.glowAlpha > 0) { path(g, c); stroke(g, v.color, v.glowAlpha * 0.6, w * 1.9); }
  path(g, c); stroke(g, v.color, v.alpha, w * 0.34);
  const pa = v.pulseAlpha ?? 0;
  if (!v.pulseActive || pa <= 0) return;
  const t = flowTrainInto(_train, c.len, nowMs - c.flowSince, material);
  const safe = scale > 0 ? scale : 1;
  const half = Math.min(c.len * 0.45, Math.max(COMET_HALF_PX / safe, COMET_HALF_PX));
  let drawn = 0;
  for (let s = leadCometArc(t, c.len), k = 0; s > -half && k <= MAX_CABLE_COMETS; s -= t.spacing, k++) {
    const lo = Math.max(0, s - half), hi = Math.min(c.len, s + half);
    if (hi <= lo) continue;
    // Arc length from the source -> from the polyline's first point.
    if (sourceIsLo) pathRange(g, c, lo, hi); else pathRange(g, c, c.len - hi, c.len - lo);
    drawn++;
  }
  if (drawn > 0) stroke(g, v.pulseColor ?? 0, pa, w * 0.5);
  if (!c.socketed) return;
  const flash = collarFlash(t, c.len);
  if (flash <= 0 || !collarFrame(c, sourceIsLo, w, _frame)) return;
  // The receiving collar lights in the flow colour, its accent ring in the
  // pulse colour (same geometry as the static collar under it).
  const f = _frame, h = w * 0.9;
  g.moveTo(f.x, f.y).lineTo(f.x + f.ux * f.L, f.y + f.uy * f.L); stroke(g, v.color, 0.55 * flash, w * 2.4);
  g.moveTo(f.rx - f.uy * h, f.ry + f.ux * h).lineTo(f.rx + f.uy * h, f.ry - f.ux * h); stroke(g, v.pulseColor ?? 0, flash, w * 0.34);
}

/** One placement-preview line along `c` (glow underlay, then the core; a
 *  dashed kind walks the polyline by arc length). A two-point `c` draws
 *  exactly today's straight preview segment. */
export function drawPreviewCable(g: LinePath, c: LinkCable, v: ConnectorVisual): void {
  if (c.n < 2) return;
  if (v.glowAlpha > 0) { path(g, c); stroke(g, v.color, v.glowAlpha, v.glowWidth); }
  if (v.dash && v.dash.on > 0) {
    // Pixi v8 has no native dash: short `on` dashes separated by `off` gaps.
    if (c.len <= 0.001) return;
    const period = v.dash.on + v.dash.off;
    for (let t = 0; t < c.len; t += period) {
      pathRange(g, c, t, Math.min(t + v.dash.on, c.len));
      stroke(g, v.color, v.alpha, v.width);
    }
    return;
  }
  path(g, c); stroke(g, v.color, v.alpha, v.width);
}
