/**
 * Structure restyle 1g — the grid line LOOKS (`?lineLook=pipe|cable|conduit`).
 * Drawing helpers for `ConnectorRenderer` (not a renderer of their own): the
 * steady body of each look goes on its static layer (rebuilt only when the web
 * or zoom changes), the flow on its per-frame layer (only while an edge is
 * carrying flow, as today). Default `cable`; `?lineLook=off` ⇒
 * `ConnectorRenderer` keeps the old thin line, untouched.
 *
 * Lines stay pass-through and draw under ships (same layer as today). Colours
 * stay the connector palette: the idle blue tints the body, the per-material
 * active colour and its lightened pulse drive the flow.
 *
 * Allocation-free per call (invariant #14): one reused stroke-style scratch
 * (Pixi copies it on `stroke`) and the caller's comet scratch.
 */
import type { Graphics, GraphicsContext } from 'pixi.js';
import { CONNECTOR_IDLE_COLOR, cometSegment, mixColor, type CometSegment, type ConnectorVisual } from './connectorVisual.js';
import {
  W, along, bowSpan, cablePath, edgePath, frameAt, oneSegment, pt, rawPath, setCablePath, smoothAt, type CablePath,
} from './connectorCablePath.js';
import { MIN_CABLE_LENGTH } from '../../../core/structures/structureGridConstants.js';

export type { CablePath } from './connectorCablePath.js';

export type LineLook = 'pipe' | 'cable' | 'conduit';

/** Where a look draws: a per-frame `Graphics`, or a shared, cached
 *  `GraphicsContext` (a crane arm's internal cable is static part art). */
export type LinePath = Graphics | GraphicsContext;

/** Per-call options. `size` scales the look's authored sizes (widths and
 *  station pitch) on top of its zoom floor; `cradles: false` drops the cable
 *  look's own truss cradles (a run laid inside a lattice that already carries
 *  it: the crane arm). `lit` gives the cable look a lighter sheath and a
 *  brighter lit edge (same palette), for a run laid inside a bright lattice
 *  where the connector's dark rubber strands would vanish (the crane arm);
 *  connectors leave it unset. Callers pass a shared constant or a reused
 *  scratch. */
export interface LineLookOpts { size: number; cradles: boolean; lit?: boolean }

/** Today's connector look: authored size, with its cradles. */
export const LINE_LOOK_FULL: LineLookOpts = Object.freeze({ size: 1, cradles: true });
export const LINE_LOOKS: readonly LineLook[] = ['pipe', 'cable', 'conduit'];

/** The line look every player sees (owner, structure restyle: on by default). */
export const DEFAULT_LINE_LOOK: LineLook = 'cable';

/** `?lineLook=pipe|cable|conduit`; `?lineLook=off` = null (the pre-restyle
 *  thin line); absent or unknown = `DEFAULT_LINE_LOOK`. */
export function readLineLook(search: string): LineLook | null {
  const m = /[?&]lineLook=(pipe|cable|conduit|off)\b/.exec(search);
  if (m === null) return DEFAULT_LINE_LOOK;
  return m[1] === 'off' ? null : (m[1] as LineLook);
}

/** Blend two 0xRRGGBB colours (now lives in `connectorVisual.ts`). */
export { mixColor };

const SHADOW = 0x081014;
const BODY = mixColor(CONNECTOR_IDLE_COLOR, 0x222c33, 0.62);
const RIM = mixColor(CONNECTOR_IDLE_COLOR, 0xdceaf2, 0.4);
const STEEL = mixColor(CONNECTOR_IDLE_COLOR, 0x6c7b84, 0.7);
const STEEL_DARK = mixColor(CONNECTOR_IDLE_COLOR, 0x1a2228, 0.75);
const CHANNEL_IDLE = mixColor(CONNECTOR_IDLE_COLOR, 0x0c1418, 0.35);

/** Authored body width (world units) per look; floored on screen by `MIN_PX`
 *  so the line stays readable at phone zoom-out. */
const BASE_W: Record<LineLook, number> = { pipe: 12, cable: 12, conduit: 18 };
const MIN_PX: Record<LineLook, number> = { pipe: 3.5, cable: 5, conduit: 5 };

/** A look's authored body width (world units at 1x, before any floor). */
export function lineLookBaseWidth(look: LineLook): number {
  return BASE_W[look];
}

/** Multiplier on a look's authored sizes: 1, or more when zoomed out so the
 *  body never drops under `MIN_PX` screen pixels. */
export function lineLookScale(look: LineLook, scale: number): number {
  const s = scale > 0 ? scale : 1;
  return Math.max(1, MIN_PX[look] / s / BASE_W[look]);
}

const _style = { color: 0, alpha: 0, width: 0 };
function stroke(g: LinePath, color: number, alpha: number, width: number): void {
  _style.color = color;
  _style.alpha = alpha;
  _style.width = width;
  g.stroke(_style);
}

/** One straight run offset `o` along the edge normal. */
function run(g: LinePath, ax: number, ay: number, bx: number, by: number, nx: number, ny: number, o: number): void {
  g.moveTo(ax + nx * o, ay + ny * o).lineTo(bx + nx * o, by + ny * o);
}

/** Path of short marks every `step` along the edge (centred in the run, kept
 *  `margin` off each end), each `half` long along the edge, offset `o` across.
 *  Returns how many were added (0 ⇒ nothing to stroke). */
function marks(
  g: LinePath, ax: number, ay: number, ux: number, uy: number, len: number,
  step: number, margin: number, alongHalf: number, nx: number, ny: number, acrossHalf: number,
): number {
  const usable = len - margin * 2;
  if (usable <= 0) return 0;
  const n = Math.floor(usable / step) + 1;
  const start = margin + (usable - (n - 1) * step) / 2;
  for (let i = 0; i < n; i++) {
    const t = start + i * step;
    const px = ax + ux * t;
    const py = ay + uy * t;
    g.moveTo(px - ux * alongHalf - nx * acrossHalf, py - uy * alongHalf - ny * acrossHalf)
      .lineTo(px + ux * alongHalf + nx * acrossHalf, py + uy * alongHalf + ny * acrossHalf);
  }
  return n;
}

/** The steady body of one edge in pixi space (static layer). `ra` / `rb` are
 *  the end nodes' radii (cable puts its strain-relief collars there). */
export function drawLineLookBody(
  g: LinePath, look: LineLook, ax: number, ay: number, bx: number, by: number, scale: number, ra = 0, rb = 0,
  opts: LineLookOpts = LINE_LOOK_FULL,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const k = lineLookScale(look, scale) * opts.size;
  const w = BASE_W[look] * k;
  if (look === 'pipe') {
    // Armoured pipe: drop shadow, shaded body, a rim highlight, flange rings.
    run(g, ax, ay, bx, by, nx, ny, w * 0.12); stroke(g, SHADOW, 0.55, w * 1.45);
    run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, BODY, 0.95, w);
    run(g, ax, ay, bx, by, nx, ny, -w * 0.24); stroke(g, RIM, 0.4, w * 0.2);
    run(g, ax, ay, bx, by, nx, ny, w * 0.3); stroke(g, SHADOW, 0.35, w * 0.22);
    if (marks(g, ax, ay, ux, uy, len, 70 * k, 30 * k, w * 0.22, 0, 0, 0) > 0) stroke(g, STEEL, 0.95, w * 1.5);
    if (marks(g, ax, ay, ux, uy, len, 70 * k, 30 * k, w * 0.06, 0, 0, 0) > 0) stroke(g, SHADOW, 0.6, w * 1.5);
    return;
  }
  if (look === 'cable') { drawCableBodyEdge(g, ax, ay, bx, by, len, w, k, ra, rb, opts.cradles, opts.lit === true); return; }
  // Conduit: a row of sleeper plates over a recessed, faintly lit channel.
  run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, SHADOW, 0.45, w * 1.05);
  if (marks(g, ax, ay, ux, uy, len, 22 * k, 6 * k, 8 * k, 0, 0, 0) > 0) stroke(g, BODY, 0.95, w);
  if (marks(g, ax, ay, ux, uy, len, 22 * k, 6 * k, 8 * k, 0, 0, 0) > 0) stroke(g, RIM, 0.12, w * 0.7);
  run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, SHADOW, 0.9, w * 0.34);
  run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, CHANNEL_IDLE, 0.7, w * 0.12);
}

/** The cable look's travelling lit band (its flow pulse) on edge a -> b at
 *  phase `t` (as `cometSegment`, so a `t` outside [0, 1) draws only the
 *  part on this edge: one comet over a polyline, e.g. the dock crane's arm,
 *  3e), in `v`'s pulse colour / alpha. Returns the comet (the `comet`
 *  scratch), or null when none of it is on this edge. Allocation-free. */
export function drawCablePulse(
  g: LinePath, v: ConnectorVisual, comet: CometSegment, t: number, sourceIsLo: boolean,
  ax: number, ay: number, bx: number, by: number, scale: number, size = 1,
): CometSegment | null {
  const c = cometSegment(comet, t, sourceIsLo, ax, ay, bx, by, scale);
  if (c.x0 === c.x1 && c.y0 === c.y1) return null;
  const sw = BASE_W.cable * lineLookScale('cable', scale) * size * 0.5;
  g.moveTo(c.x0, c.y0).lineTo(c.x1, c.y1);
  stroke(g, v.pulseColor ?? 0, v.pulseAlpha ?? 0, sw * 0.7);
  return c;
}

/** The flow of one ACTIVE edge (per-frame layer). `v` is this frame's
 *  `connectorVisualInto` result; `sourceIsLo` as for `cometSegment`. */
export function drawLineLookFlow(
  g: LinePath, look: LineLook, v: ConnectorVisual, comet: CometSegment, sourceIsLo: boolean,
  ax: number, ay: number, bx: number, by: number, scale: number, ra = 0, rb = 0,
  opts: LineLookOpts = LINE_LOOK_FULL,
): void {
  const w = BASE_W[look] * lineLookScale(look, scale) * opts.size;
  const t = v.pulseT ?? 0;
  const pulseColor = v.pulseColor ?? 0;
  const pulseAlpha = v.pulseAlpha ?? 0;
  if (look === 'pipe') {
    // Lit core seen through the pipe, three glints riding the flow.
    g.moveTo(ax, ay).lineTo(bx, by); stroke(g, v.color, v.alpha * 0.6, w * 0.32);
    for (let i = 0; i < 3; i++) {
      const c = cometSegment(comet, (t + i / 3) % 1, sourceIsLo, ax, ay, bx, by, scale);
      g.moveTo(c.x0, c.y0).lineTo(c.x1, c.y1);
    }
    stroke(g, pulseColor, pulseAlpha, w * 0.34);
    return;
  }
  if (look === 'cable') { drawCableFlow(g, v, comet, sourceIsLo, ax, ay, bx, by, scale, w, ra, rb, opts.size); return; }
  // Conduit: the channel lights up, two packets run it.
  g.moveTo(ax, ay).lineTo(bx, by); stroke(g, v.color, v.glowAlpha, w * 0.9);
  g.moveTo(ax, ay).lineTo(bx, by); stroke(g, v.color, v.alpha, w * 0.16);
  for (let i = 0; i < 2; i++) {
    const c = cometSegment(comet, (t + i / 2) % 1, sourceIsLo, ax, ay, bx, by, scale);
    g.moveTo(c.x0, c.y0).lineTo(c.x1, c.y1);
  }
  stroke(g, pulseColor, pulseAlpha, w * 0.2);
}

// ── Cable (restyle 1i): heavy industrial power cabling on truss cradles ──────
// Three sheathed strands (dark outline, rubber body, lit edge) over a cast
// shadow, carried through X-braced lattice cradles with clamp plates, lashed
// between cradles (the outer strands bow apart between lashings), with a
// strain-relief collar where the run meets each node. Gritty and desaturated:
// a breath of the idle blue keeps it in the connector palette.
const CABLE_OUTLINE = 0x0a0d0f;
const CABLE_SHEATH = mixColor(CONNECTOR_IDLE_COLOR, 0x2b3033, 0.84);
const CABLE_CORE_SHEATH = mixColor(CONNECTOR_IDLE_COLOR, 0x3a342b, 0.86);
const CABLE_HI = mixColor(CONNECTOR_IDLE_COLOR, 0x8e979b, 0.82);
/** The lit variant (`LineLookOpts.lit`): the same sheath / core / edge, raised
 *  toward pale steel so it holds up under a bright lattice on a phone. */
export const CABLE_LIT_SHEATH = mixColor(CONNECTOR_IDLE_COLOR, 0xa3aaad, 0.84);
const LIT_CORE_SHEATH = mixColor(CONNECTOR_IDLE_COLOR, 0xb0a48e, 0.86);
const LIT_HI = mixColor(CONNECTOR_IDLE_COLOR, 0xeef2f3, 0.85);
const TRUSS = mixColor(CONNECTOR_IDLE_COLOR, 0x5c6264, 0.86);
const CLAMP = mixColor(CONNECTOR_IDLE_COLOR, 0x7a7466, 0.88);
const LASH = 0x14181a;
/** Station pitch (world units at 1x): collar, lashing, cradle, lashing, ... */
const CABLE_PITCH = 55;
/** Shortest span between the end collars that lays out stations (world units
 *  at 1x); shorter draws the collars only. The gameplay minimum
 *  (`MIN_CABLE_LENGTH`) less the two collar insets (half a body width each):
 *  56 - 12 = 44 = 0.8 pitches, so a link the grid allows always shows bundle. */
const SHORT_RUN_SPAN = MIN_CABLE_LENGTH - BASE_W.cable;
/** Light comes from the top-left of the screen (pixi y-down). */
const LIGHT_X = -0.6;
const LIGHT_Y = -0.8;


// Station layout scratch (module-level, written by `cableLayout`).
let _s0 = 0;
let _seg = 0;
let _nSeg = 0;
/** Arc length of the far collar. */
let _s1 = 0;
/** A run too short for cradles still gets its two end collars (a stud-to-
 *  stud cable between close neighbours). */
let _shortCollars = false;

/** Lay the stations out along the path: collars at `_s0` = `e0` and `_s1`
 *  (`e1` from the far end), cradles at even inner stations, lashings at odd
 *  ones. `nSeg` is even, or 0 when the run is too short for any. */
function cableLayout(len: number, e0: number, e1: number, k: number, endCollars = false): void {
  const span = len - e0 - e1;
  const pitch = CABLE_PITCH * k;
  _s0 = e0;
  _shortCollars = false;
  if (span < SHORT_RUN_SPAN * k) {
    _nSeg = 0; _seg = 0; _s1 = len - e1;
    _shortCollars = endCollars && _s1 > _s0;
    return;
  }
  _nSeg = 2 * Math.max(1, Math.round(span / (2 * pitch)));
  _seg = span / _nSeg;
  _s1 = _s0 + _nSeg * _seg;
}

/** One strand: along the path to the first collar, bowing `bow` further out
 *  between stations, along the path from the last collar. `o` = offset
 *  along the normal. */
function strand(g: LinePath, len: number, o: number, bow: number): void {
  if (_nSeg === 0 || bow === 0) { along(g, 0, len, o, 0, 0); return; }
  along(g, 0, _s0, o, 0, 0);
  const oc = o + bow;
  for (let j = 0; j < _nSeg; j++) {
    const ta = _s0 + j * _seg;
    const tm = _s0 + (j + 0.5) * _seg;
    const tb = _s0 + (j + 1) * _seg;
    if (!oneSegment(ta, tb)) { bowSpan(g, ta, tb, o, bow); continue; }
    pt(tm, oc);
    const cx = W.px, cy = W.py;
    pt(tb, o);
    g.quadraticCurveTo(cx, cy, W.px, W.py);
  }
  pt(len, o); g.lineTo(W.px, W.py);
}

/** A segment at arc length `t`, from (`a0`, `c0`) to (`a1`, `c1`) in
 *  (along, across) coordinates of the local frame there, shifted (`ox`, `oy`). */
function seg(g: LinePath, t: number, a0: number, c0: number, a1: number, c1: number, ox: number, oy: number): void {
  if (cablePath().n > 2) {
    // On a curve: square to the smoothed tangent at t.
    smoothAt(t);
    const qx = W.px + ox, qy = W.py + oy;
    g.moveTo(qx + W.ux * a0 + W.nx * c0, qy + W.uy * a0 + W.ny * c0)
      .lineTo(qx + W.ux * a1 + W.nx * c1, qy + W.uy * a1 + W.ny * c1);
    return;
  }
  frameAt(t);
  const px = W.ox + ox;
  const py = W.oy + oy;
  g.moveTo(px + W.ux * (t + a0) + W.nx * c0, py + W.uy * (t + a0) + W.ny * c0)
    .lineTo(px + W.ux * (t + a1) + W.nx * c1, py + W.uy * (t + a1) + W.ny * c1);
}

const ST_CRADLE = 0;
const ST_LASH = 1;
const ST_COLLAR = 2;
const SH_RAILS = 0;
const SH_BRACES = 1;
const SH_FEET = 2;
const SH_BAR = 3;
/** Add one shape at every station of `kind`, shifted (`ox`, `oy`). Shapes:
 *  rails (two across-bars at +-a), braces (X lattice, two bays), feet (pads
 *  along the edge at +-c), bar (one across-bar of half-length c at along a).
 *  Returns how many stations were drawn (0 => nothing to stroke). */
function atStations(g: LinePath, kind: number, shape: number, a: number, c: number, ox: number, oy: number): number {
  if (_nSeg === 0 && !(_shortCollars && kind === ST_COLLAR)) return 0;
  const last = _nSeg === 0 ? 1 : _nSeg;
  let n = 0;
  for (let j = 0; j <= last; j++) {
    const st = j === 0 || j === last ? ST_COLLAR : (j & 1) === 1 ? ST_LASH : ST_CRADLE;
    if (st !== kind) continue;
    const t = j === last ? _s1 : _s0 + j * _seg;
    if (shape === SH_RAILS) {
      seg(g, t, -a, -c, -a, c, ox, oy);
      seg(g, t, a, -c, a, c, ox, oy);
    } else if (shape === SH_BRACES) {
      seg(g, t, -a, -c, a, 0, ox, oy);
      seg(g, t, a, -c, -a, 0, ox, oy);
      seg(g, t, -a, 0, a, c, ox, oy);
      seg(g, t, a, 0, -a, c, ox, oy);
    } else if (shape === SH_FEET) {
      seg(g, t, -a, -c, a, -c, ox, oy);
      seg(g, t, -a, c, a, c, ox, oy);
    } else {
      seg(g, t, a, -c, a, c, ox, oy);
    }
    n++;
  }
  return n;
}

/** The cable body along the walked path (laid out by the caller's `cableLayout`). */
function drawCableBody(g: LinePath, w: number, cradles: boolean, lit: boolean): void {
  const P = cablePath();
  const len = P.len;
  const sheath = lit ? CABLE_LIT_SHEATH : CABLE_SHEATH;
  const core = lit ? LIT_CORE_SHEATH : CABLE_CORE_SHEATH;
  const hi = lit ? LIT_HI : CABLE_HI;
  const hiA = lit ? 0.85 : 0.38;
  const sw = w * 0.5; // one strand
  const sp = w * 0.55; // strand spacing (pinched at stations)
  const bow = sp * 0.45; // extra spread between stations (quadratic control)
  // Lit side along the normal, by the chord (end to end): one side all along.
  const q = P.poly, m = (P.n - 1) * 2;
  const cdx = q[m]! - q[0]!, cdy = q[m + 1]! - q[1]!;
  const cl = Math.hypot(cdx, cdy);
  const side = cl > 0 && -(cdy / cl) * LIGHT_X + (cdx / cl) * LIGHT_Y < 0 ? -1 : 1;
  const shx = -LIGHT_X * w * 0.45;
  const shy = -LIGHT_Y * w * 0.45;
  const cradleC = sp * 1.35 + sw + w * 0.65; // cradle half-span across
  const cradleA = w * 0.75; // cradle half-depth along
  // Cast shadows: the bundle, then each cradle's footprint.
  along(g, 0, len, 0, shx, shy);
  stroke(g, SHADOW, 0.5, sp * 2.4 + sw * 1.5);
  if (cradles && atStations(g, ST_CRADLE, SH_BAR, 0, cradleC, shx, shy) > 0) {
    stroke(g, SHADOW, 0.55, cradleA * 2.4);
    // Truss cradles: dark under-strokes, then the steel lattice and feet.
    atStations(g, ST_CRADLE, SH_RAILS, cradleA, cradleC, 0, 0); stroke(g, CABLE_OUTLINE, 0.95, w * 0.28);
    atStations(g, ST_CRADLE, SH_BRACES, cradleA, cradleC, 0, 0); stroke(g, CABLE_OUTLINE, 0.9, w * 0.2);
    atStations(g, ST_CRADLE, SH_RAILS, cradleA, cradleC, 0, 0); stroke(g, TRUSS, 1, w * 0.15);
    atStations(g, ST_CRADLE, SH_BRACES, cradleA, cradleC, 0, 0); stroke(g, TRUSS, 0.95, w * 0.09);
    atStations(g, ST_CRADLE, SH_FEET, cradleA * 1.3, cradleC, 0, 0); stroke(g, CABLE_OUTLINE, 1, w * 0.36);
    atStations(g, ST_CRADLE, SH_FEET, cradleA * 1.15, cradleC, 0, 0); stroke(g, STEEL_DARK, 1, w * 0.22);
  }
  // Strands: outline, sheath, lit edge. The outer two bow apart between stations.
  for (let i = -1; i <= 1; i++) {
    const o = i * sp;
    const b = i * bow;
    strand(g, len, o, b); stroke(g, CABLE_OUTLINE, 0.95, sw + w * 0.16);
    strand(g, len, o, b); stroke(g, i === 0 ? core : sheath, 1, sw);
    strand(g, len, o + side * sw * 0.24, b); stroke(g, hi, hiA, sw * 0.22);
  }
  if (_nSeg > 0) {
    // Lashings pull the bundle together between cradles.
    const lashC = sp + sw * 0.7;
    atStations(g, ST_LASH, SH_BAR, 0, lashC, 0, 0); stroke(g, LASH, 1, w * 0.32);
    atStations(g, ST_LASH, SH_BAR, -w * 0.06, lashC * 0.92, 0, 0); stroke(g, CABLE_HI, 0.28, w * 0.07);
    // Clamp plates on the cradles, bolted at each end.
    const clampC = sp + sw * 0.8;
    if (atStations(g, ST_CRADLE, SH_BAR, 0, clampC + w * 0.06, 0, 0) > 0) {
      stroke(g, CABLE_OUTLINE, 1, w * 0.56);
      atStations(g, ST_CRADLE, SH_BAR, 0, clampC, 0, 0); stroke(g, CLAMP, 1, w * 0.42);
      atStations(g, ST_CRADLE, SH_BAR, -w * 0.1, clampC * 0.9, 0, 0); stroke(g, CABLE_HI, 0.35, w * 0.08);
      atStations(g, ST_CRADLE, SH_FEET, w * 0.09, clampC * 0.82, 0, 0); stroke(g, CABLE_OUTLINE, 1, w * 0.2);
    }
  } else if (!_shortCollars) return;
  // Strain-relief collars where the run meets each node.
  const collarC = sp + sw * 0.95;
  atStations(g, ST_COLLAR, SH_BAR, 0, collarC + w * 0.07, 0, 0); stroke(g, CABLE_OUTLINE, 1, w * 0.95);
  atStations(g, ST_COLLAR, SH_BAR, 0, collarC, 0, 0); stroke(g, TRUSS, 1, w * 0.78);
  atStations(g, ST_COLLAR, SH_BAR, 0, collarC, 0, 0); stroke(g, CABLE_OUTLINE, 0.8, w * 0.1);
  atStations(g, ST_COLLAR, SH_BAR, -w * 0.26, collarC * 0.92, 0, 0); stroke(g, CABLE_HI, 0.4, w * 0.08);
}

/** The cable's flowing glow along the walked path (laid out): a faint bleed around the
 *  bundle, and the lit core in the gaps between stations (lashings, cradles
 *  and collars hide it). */
function cableGlow(g: LinePath, v: ConnectorVisual, w: number): void {
  rawPath(g); stroke(g, v.color, v.glowAlpha * 0.6, w * 1.2);
  if (_nSeg === 0) rawPath(g);
  else {
    const gap = w * 0.45;
    for (let j = 0; j < _nSeg; j++) {
      const t0 = _s0 + j * _seg + gap;
      const t1 = _s0 + (j + 1) * _seg - gap;
      if (t1 > t0) along(g, t0, t1, 0, 0, 0);
    }
  }
  stroke(g, v.color, v.alpha, w * 0.5 * 0.42);
}

/** Sparks at the clamp ends of every cradle within reach of arc length `d`
 *  (a lit band passing through). Returns how many (0 => nothing to stroke). */
function cableSparks(g: LinePath, d: number, w: number): number {
  const reach = w * 1.6;
  const s = w * 0.28;
  const clampC = w * 0.55 + w * 0.5 * 0.8;
  let n = 0;
  for (let j = 2; j < _nSeg; j += 2) {
    const t = _s0 + j * _seg;
    if (Math.abs(t - d) > reach) continue;
    for (let side = -1; side <= 1; side += 2) {
      const cc = side * clampC;
      seg(g, t, -s, cc - s, s, cc + s, 0, 0);
      seg(g, t, -s, cc + s, s, cc - s, 0, 0);
      n++;
    }
  }
  return n;
}

function sparkWidth(w: number, scale: number): number {
  return Math.max(w * 0.1, 1 / (scale > 0 ? scale : 1));
}

function drawCableBodyEdge(
  g: LinePath, ax: number, ay: number, bx: number, by: number, len: number,
  w: number, k: number, ra: number, rb: number, cradles: boolean, lit: boolean,
): void {
  setCablePath(edgePath(ax, ay, bx, by, len));
  cableLayout(len, Math.min(ra * 0.9, len * 0.3), Math.min(rb * 0.9, len * 0.3), k);
  drawCableBody(g, w, cradles, lit);
}

/** Cable flow on a straight edge: the glow, a lit band riding it, and a few
 *  sparks at a cradle's clamp as the band passes through. */
function drawCableFlow(
  g: LinePath, v: ConnectorVisual, comet: CometSegment, sourceIsLo: boolean,
  ax: number, ay: number, bx: number, by: number, scale: number, w: number, ra: number, rb: number, size: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  setCablePath(edgePath(ax, ay, bx, by, len));
  cableLayout(len, Math.min(ra * 0.9, len * 0.3), Math.min(rb * 0.9, len * 0.3), w / BASE_W.cable);
  cableGlow(g, v, w);
  // The travelling lit band.
  const c = drawCablePulse(g, v, comet, v.pulseT ?? 0, sourceIsLo, ax, ay, bx, by, scale, size);
  if (_nSeg === 0 || c === null) return;
  const d = ((c.x0 + c.x1) * 0.5 - ax) * ux + ((c.y0 + c.y1) * 0.5 - ay) * uy;
  if (cableSparks(g, d, w) > 0) stroke(g, v.pulseColor ?? 0, (v.pulseAlpha ?? 0) * 0.9, sparkWidth(w, scale));
}

// ── The cable look along a socket cable's curve (stud to stud) ──────────────

/** The cable look's body width (world units) at this zoom. */
export function cableLookWidth(scale: number, size = 1): number {
  return BASE_W.cable * lineLookScale('cable', scale) * size;
}

/** How far in from a stud its end collar sits (the collar band starts at
 *  the stud). */
export function cableStudInset(scale: number, len: number): number {
  return Math.min(cableLookWidth(scale) * 0.5, len * 0.3);
}

/** The cable look's steady body along `path`, end collars `e0` / `e1` in
 *  from its ends. `endCollars`: a run too short for cradles still gets its
 *  end collars (a socket cable between close neighbours). */
export function drawCablePathBody(
  g: LinePath, path: CablePath, scale: number, e0: number, e1: number, endCollars: boolean,
  opts: LineLookOpts = LINE_LOOK_FULL,
): void {
  if (path.n < 2 || path.len < 1) return;
  const k = lineLookScale('cable', scale) * opts.size;
  setCablePath(path);
  cableLayout(path.len, e0, e1, k, endCollars);
  drawCableBody(g, BASE_W.cable * k, opts.cradles, opts.lit === true);
}

/** The cable look's flow glow along `path` (bleed + lit core between the
 *  stations), laid out as `drawCablePathBody`. Leaves that layout for
 *  `addCablePathSparks` / `drawCablePathCollarFlash` on the same path. */
export function drawCablePathGlow(
  g: LinePath, path: CablePath, v: ConnectorVisual, scale: number, e0: number, e1: number, endCollars: boolean,
): void {
  if (path.n < 2 || path.len < 1) return;
  const w = cableLookWidth(scale);
  setCablePath(path);
  cableLayout(path.len, e0, e1, w / BASE_W.cable, endCollars);
  cableGlow(g, v, w);
}

/** The cable look's lit-band width (as `drawCablePulse`). */
export function cablePulseWidth(scale: number): number {
  return cableLookWidth(scale) * 0.5 * 0.7;
}

/** Add the clamp sparks for a band at arc length `d` on the path last laid
 *  out by `drawCablePathGlow`; returns how many (then `strokeCableSparks`). */
export function addCablePathSparks(g: LinePath, d: number, scale: number): number {
  return _nSeg === 0 ? 0 : cableSparks(g, d, cableLookWidth(scale));
}

export function strokeCableSparks(g: LinePath, v: ConnectorVisual, scale: number): void {
  stroke(g, v.pulseColor ?? 0, (v.pulseAlpha ?? 0) * 0.9, sparkWidth(cableLookWidth(scale), scale));
}

/** The receiving end collar (`atEnd`: at the path's last point) lit by an
 *  arriving band, strength `flash` in (0, 1]: the collar band in the flow
 *  colour, a ring in the pulse colour, on the path last laid out by
 *  `drawCablePathGlow`. False when that path has no collars. */
export function drawCablePathCollarFlash(g: LinePath, v: ConnectorVisual, atEnd: boolean, scale: number, flash: number): boolean {
  if (_nSeg === 0 && !_shortCollars) return false;
  const w = cableLookWidth(scale);
  const t = atEnd ? _s1 : _s0;
  const c = w * 0.55 + w * 0.5 * 0.95;
  seg(g, t, 0, -c * 1.15, 0, c * 1.15, 0, 0); stroke(g, v.color, 0.55 * flash, w * 1.4);
  seg(g, t, atEnd ? -w * 0.3 : w * 0.3, -c, atEnd ? -w * 0.3 : w * 0.3, c, 0, 0); stroke(g, v.pulseColor ?? 0, flash, w * 0.2);
  return true;
}
