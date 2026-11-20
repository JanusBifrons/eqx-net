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
 *  - The cable look (static body + per-frame flow: the cable line look,
 *    "bundle on the curve", laid stud to stud) and the placement preview
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
import {
  addCablePathSparks, cablePulseWidth, cableStudInset, drawCablePathBody, drawCablePathCollarFlash, drawCablePathGlow,
  mixColor, strokeCableSparks, type LinePath,
} from './connectorLineLooks.js';
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

// The socket palette (dark grey plates, cyan accents), shared with the socket
// nubs (`structureSocketNubs.ts`). The cable itself is the cable line look.
const OUTLINE = 0x0a0d0f;
const PLATE = mixColor(CONNECTOR_IDLE_COLOR, 0x4b5459, 0.88);
const PLATE_HI = 0x9aa5ab;
const ACCENT = 0x5fd8ff;
export { OUTLINE as SOCKET_OUTLINE, PLATE as SOCKET_PLATE, PLATE_HI as SOCKET_PLATE_HI, ACCENT as SOCKET_ACCENT };

// End-collar insets of the cable being drawn (`insets`).
let _e0 = 0;
let _e1 = 0;

/** Where the end collars sit: just off each stud on a socket cable (the
 *  curve already runs stud to stud), just outside each post on a straight
 *  fence link (centre to centre, as the straight line look). */
function insets(c: LinkCable, scale: number, ra: number, rb: number): void {
  if (c.socketed) { _e0 = _e1 = cableStudInset(scale, c.len); return; }
  _e0 = Math.min(ra * 0.9, c.len * 0.3);
  _e1 = Math.min(rb * 0.9, c.len * 0.3);
}

/** The cable's steady body (static layer): the cable line look (bundle,
 *  lit core, support frames, end collars) laid along the link's
 *  curve, stud to stud. `ra` / `rb`: the end nodes' radii (a fence link's
 *  collars sit outside its posts). */
export function drawSocketCableBody(g: LinePath, c: LinkCable, scale: number, ra = 0, rb = 0): void {
  if (c.n < 2 || c.len < 1) return;
  insets(c, scale, ra, rb);
  drawCablePathBody(g, c, scale, _e0, _e1, c.socketed);
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
/** This frame's comets: arc lengths [lo, hi] from the polyline's first point. */
const _comets = new Float64Array((MAX_CABLE_COMETS + 1) * 2);

/** The flow of an ACTIVE link (per-frame layer): the cable look's glow along
 *  the curve (bleed + lit core between the frames), the comet train leaving
 *  the source socket (`sourceIsLo`: the polyline's first point) at the
 *  material's pace in game time (`nowMs` = `fxNow`, #20), all comets in one
 *  stroke, clamp sparks at frames a comet passes through, and the receiving
 *  end collar's flash as each comet arrives. The static body is not touched. */
export function drawSocketCableFlow(
  g: LinePath, c: LinkCable, v: ConnectorVisual, sourceIsLo: boolean, scale: number,
  nowMs: number, material: ConnectorFlowMaterial, ra = 0, rb = 0,
): void {
  if (c.n < 2 || c.len < 1) return;
  // A new run of flow (first frame, or after a gap): the train restarts.
  if (!(nowMs - c.flowSeen <= FLOW_RESTART_GAP_MS) || nowMs < c.flowSeen) c.flowSince = nowMs;
  c.flowSeen = nowMs;
  insets(c, scale, ra, rb);
  drawCablePathGlow(g, c, v, scale, _e0, _e1, c.socketed);
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
    const a = sourceIsLo ? lo : c.len - hi, b = sourceIsLo ? hi : c.len - lo;
    pathRange(g, c, a, b);
    _comets[drawn * 2] = a; _comets[drawn * 2 + 1] = b;
    drawn++;
  }
  if (drawn > 0) stroke(g, v.pulseColor ?? 0, pa, cablePulseWidth(scale));
  let sparks = 0;
  for (let i = 0; i < drawn; i++) sparks += addCablePathSparks(g, (_comets[i * 2]! + _comets[i * 2 + 1]!) * 0.5, scale);
  if (sparks > 0) strokeCableSparks(g, v, scale);
  if (!c.socketed) return;
  const flash = collarFlash(t, c.len);
  // The receiving collar lights in the flow colour, its ring in the pulse colour.
  if (flash > 0) drawCablePathCollarFlash(g, v, sourceIsLo, scale, flash);
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
