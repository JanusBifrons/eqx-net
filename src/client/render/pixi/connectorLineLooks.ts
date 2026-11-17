/**
 * Structure restyle 1g — the grid line LOOKS (`?lineLook=pipe|cable|conduit`).
 * Drawing helpers for `ConnectorRenderer` (not a renderer of their own): the
 * steady body of each look goes on its static layer (rebuilt only when the web
 * or zoom changes), the flow on its per-frame layer (only while an edge is
 * carrying flow, as today). Absent flag ⇒ `ConnectorRenderer` keeps today's
 * thin line, untouched.
 *
 * Lines stay pass-through and draw under ships (same layer as today). Colours
 * stay the connector palette: the idle blue tints the body, the per-material
 * active colour and the gold flow pulse drive the flow.
 *
 * Allocation-free per call (invariant #14): one reused stroke-style scratch
 * (Pixi copies it on `stroke`) and the caller's comet scratch.
 */
import type { Graphics } from 'pixi.js';
import { CONNECTOR_IDLE_COLOR, cometSegment, type CometSegment, type ConnectorVisual } from './connectorVisual.js';

export type LineLook = 'pipe' | 'cable' | 'conduit';
export const LINE_LOOKS: readonly LineLook[] = ['pipe', 'cable', 'conduit'];

/** `?lineLook=pipe|cable|conduit`, or null (today's line). */
export function readLineLook(search: string): LineLook | null {
  const m = /[?&]lineLook=(pipe|cable|conduit)\b/.exec(search);
  return m ? (m[1] as LineLook) : null;
}

/** Blend two 0xRRGGBB colours (`t` = 0 ⇒ `a`). */
export function mixColor(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

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

/** Multiplier on a look's authored sizes: 1, or more when zoomed out so the
 *  body never drops under `MIN_PX` screen pixels. */
export function lineLookScale(look: LineLook, scale: number): number {
  const s = scale > 0 ? scale : 1;
  return Math.max(1, MIN_PX[look] / s / BASE_W[look]);
}

const _style = { color: 0, alpha: 0, width: 0 };
function stroke(g: Graphics, color: number, alpha: number, width: number): void {
  _style.color = color;
  _style.alpha = alpha;
  _style.width = width;
  g.stroke(_style);
}

/** One straight run offset `o` along the edge normal. */
function run(g: Graphics, ax: number, ay: number, bx: number, by: number, nx: number, ny: number, o: number): void {
  g.moveTo(ax + nx * o, ay + ny * o).lineTo(bx + nx * o, by + ny * o);
}

/** Path of short marks every `step` along the edge (centred in the run, kept
 *  `margin` off each end), each `half` long along the edge, offset `o` across.
 *  Returns how many were added (0 ⇒ nothing to stroke). */
function marks(
  g: Graphics, ax: number, ay: number, ux: number, uy: number, len: number,
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
  g: Graphics, look: LineLook, ax: number, ay: number, bx: number, by: number, scale: number, ra = 0, rb = 0,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const k = lineLookScale(look, scale);
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
  if (look === 'cable') { drawCableBody(g, ax, ay, ux, uy, nx, ny, len, w, k, ra, rb); return; }
  // Conduit: a row of sleeper plates over a recessed, faintly lit channel.
  run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, SHADOW, 0.45, w * 1.05);
  if (marks(g, ax, ay, ux, uy, len, 22 * k, 6 * k, 8 * k, 0, 0, 0) > 0) stroke(g, BODY, 0.95, w);
  if (marks(g, ax, ay, ux, uy, len, 22 * k, 6 * k, 8 * k, 0, 0, 0) > 0) stroke(g, RIM, 0.12, w * 0.7);
  run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, SHADOW, 0.9, w * 0.34);
  run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, CHANNEL_IDLE, 0.7, w * 0.12);
}

/** The flow of one ACTIVE edge (per-frame layer). `v` is this frame's
 *  `connectorVisualInto` result; `sourceIsLo` as for `cometSegment`. */
export function drawLineLookFlow(
  g: Graphics, look: LineLook, v: ConnectorVisual, comet: CometSegment, sourceIsLo: boolean,
  ax: number, ay: number, bx: number, by: number, scale: number, ra = 0, rb = 0,
): void {
  const w = BASE_W[look] * lineLookScale(look, scale);
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
  if (look === 'cable') { drawCableFlow(g, v, comet, sourceIsLo, ax, ay, bx, by, scale, w, ra, rb); return; }
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
const TRUSS = mixColor(CONNECTOR_IDLE_COLOR, 0x5c6264, 0.86);
const CLAMP = mixColor(CONNECTOR_IDLE_COLOR, 0x7a7466, 0.88);
const LASH = 0x14181a;
/** Station pitch (world units at 1x): collar, lashing, cradle, lashing, ... */
const CABLE_PITCH = 55;
/** Light comes from the top-left of the screen (pixi y-down). */
const LIGHT_X = -0.6;
const LIGHT_Y = -0.8;

// Station layout scratch (module-level, written by `cableLayout`).
let _s0 = 0;
let _seg = 0;
let _nSeg = 0;

/** Lay the stations out along an edge: collars at `s0` and `s0 + nSeg*seg`
 *  (just outside each node), cradles at even inner stations, lashings at odd
 *  ones. `nSeg` is even, or 0 when the run is too short for any. */
function cableLayout(len: number, ra: number, rb: number, k: number): void {
  const e0 = Math.min(ra * 0.9, len * 0.3);
  const e1 = Math.min(rb * 0.9, len * 0.3);
  const span = len - e0 - e1;
  const pitch = CABLE_PITCH * k;
  _s0 = e0;
  if (span < pitch * 0.8) { _nSeg = 0; _seg = 0; return; }
  _nSeg = 2 * Math.max(1, Math.round(span / (2 * pitch)));
  _seg = span / _nSeg;
}

/** One strand: straight to the first collar, bowing `bow` further out between
 *  stations, straight from the last collar. `o` = offset along the normal. */
function strand(
  g: Graphics, ax: number, ay: number, ux: number, uy: number, nx: number, ny: number,
  len: number, o: number, bow: number,
): void {
  if (_nSeg === 0 || bow === 0) { run(g, ax, ay, ax + ux * len, ay + uy * len, nx, ny, o); return; }
  g.moveTo(ax + nx * o, ay + ny * o);
  g.lineTo(ax + ux * _s0 + nx * o, ay + uy * _s0 + ny * o);
  const oc = o + bow;
  for (let j = 0; j < _nSeg; j++) {
    const tm = _s0 + (j + 0.5) * _seg;
    const tb = _s0 + (j + 1) * _seg;
    g.quadraticCurveTo(ax + ux * tm + nx * oc, ay + uy * tm + ny * oc, ax + ux * tb + nx * o, ay + uy * tb + ny * o);
  }
  g.lineTo(ax + ux * len + nx * o, ay + uy * len + ny * o);
}

/** A segment at along-distance `t`, from (`a0`, `c0`) to (`a1`, `c1`) in
 *  (along, across) coordinates relative to that station. */
function seg(
  g: Graphics, ax: number, ay: number, ux: number, uy: number, nx: number, ny: number,
  t: number, a0: number, c0: number, a1: number, c1: number,
): void {
  g.moveTo(ax + ux * (t + a0) + nx * c0, ay + uy * (t + a0) + ny * c0)
    .lineTo(ax + ux * (t + a1) + nx * c1, ay + uy * (t + a1) + ny * c1);
}

const ST_CRADLE = 0;
const ST_LASH = 1;
const ST_COLLAR = 2;
const SH_RAILS = 0;
const SH_BRACES = 1;
const SH_FEET = 2;
const SH_BAR = 3;
/** Add one shape at every station of `kind`, offset (`ox`, `oy`). Shapes:
 *  rails (two across-bars at +-a), braces (X lattice, two bays), feet (pads
 *  along the edge at +-c), bar (one across-bar of half-length c at along a).
 *  Returns how many stations were drawn (0 => nothing to stroke). */
function atStations(
  g: Graphics, kind: number, shape: number, ax: number, ay: number, ux: number, uy: number,
  nx: number, ny: number, a: number, c: number, ox: number, oy: number,
): number {
  if (_nSeg === 0) return 0;
  let n = 0;
  const px = ax + ox;
  const py = ay + oy;
  for (let j = 0; j <= _nSeg; j++) {
    const st = j === 0 || j === _nSeg ? ST_COLLAR : (j & 1) === 1 ? ST_LASH : ST_CRADLE;
    if (st !== kind) continue;
    const t = _s0 + j * _seg;
    if (shape === SH_RAILS) {
      seg(g, px, py, ux, uy, nx, ny, t, -a, -c, -a, c);
      seg(g, px, py, ux, uy, nx, ny, t, a, -c, a, c);
    } else if (shape === SH_BRACES) {
      seg(g, px, py, ux, uy, nx, ny, t, -a, -c, a, 0);
      seg(g, px, py, ux, uy, nx, ny, t, a, -c, -a, 0);
      seg(g, px, py, ux, uy, nx, ny, t, -a, 0, a, c);
      seg(g, px, py, ux, uy, nx, ny, t, a, 0, -a, c);
    } else if (shape === SH_FEET) {
      seg(g, px, py, ux, uy, nx, ny, t, -a, -c, a, -c);
      seg(g, px, py, ux, uy, nx, ny, t, -a, c, a, c);
    } else {
      seg(g, px, py, ux, uy, nx, ny, t, a, -c, a, c);
    }
    n++;
  }
  return n;
}

function drawCableBody(
  g: Graphics, ax: number, ay: number, ux: number, uy: number, nx: number, ny: number,
  len: number, w: number, k: number, ra: number, rb: number,
): void {
  cableLayout(len, ra, rb, k);
  const sw = w * 0.5; // one strand
  const sp = w * 0.55; // strand spacing (pinched at stations)
  const bow = sp * 0.45; // extra spread between stations (quadratic control)
  const lit = nx * LIGHT_X + ny * LIGHT_Y >= 0 ? 1 : -1; // lit side along the normal
  const shx = -LIGHT_X * w * 0.45;
  const shy = -LIGHT_Y * w * 0.45;
  const cradleC = sp * 1.35 + sw + w * 0.65; // cradle half-span across
  const cradleA = w * 0.75; // cradle half-depth along
  // Cast shadows: the bundle, then each cradle's footprint.
  g.moveTo(ax + shx, ay + shy).lineTo(ax + ux * len + shx, ay + uy * len + shy);
  stroke(g, SHADOW, 0.5, sp * 2.4 + sw * 1.5);
  if (atStations(g, ST_CRADLE, SH_BAR, ax, ay, ux, uy, nx, ny, 0, cradleC, shx, shy) > 0) {
    stroke(g, SHADOW, 0.55, cradleA * 2.4);
    // Truss cradles: dark under-strokes, then the steel lattice and feet.
    atStations(g, ST_CRADLE, SH_RAILS, ax, ay, ux, uy, nx, ny, cradleA, cradleC, 0, 0); stroke(g, CABLE_OUTLINE, 0.95, w * 0.28);
    atStations(g, ST_CRADLE, SH_BRACES, ax, ay, ux, uy, nx, ny, cradleA, cradleC, 0, 0); stroke(g, CABLE_OUTLINE, 0.9, w * 0.2);
    atStations(g, ST_CRADLE, SH_RAILS, ax, ay, ux, uy, nx, ny, cradleA, cradleC, 0, 0); stroke(g, TRUSS, 1, w * 0.15);
    atStations(g, ST_CRADLE, SH_BRACES, ax, ay, ux, uy, nx, ny, cradleA, cradleC, 0, 0); stroke(g, TRUSS, 0.95, w * 0.09);
    atStations(g, ST_CRADLE, SH_FEET, ax, ay, ux, uy, nx, ny, cradleA * 1.3, cradleC, 0, 0); stroke(g, CABLE_OUTLINE, 1, w * 0.36);
    atStations(g, ST_CRADLE, SH_FEET, ax, ay, ux, uy, nx, ny, cradleA * 1.15, cradleC, 0, 0); stroke(g, STEEL_DARK, 1, w * 0.22);
  }
  // Strands: outline, sheath, lit edge. The outer two bow apart between stations.
  for (let i = -1; i <= 1; i++) {
    const o = i * sp;
    const b = i * bow;
    strand(g, ax, ay, ux, uy, nx, ny, len, o, b); stroke(g, CABLE_OUTLINE, 0.95, sw + w * 0.16);
    strand(g, ax, ay, ux, uy, nx, ny, len, o, b); stroke(g, i === 0 ? CABLE_CORE_SHEATH : CABLE_SHEATH, 1, sw);
    strand(g, ax, ay, ux, uy, nx, ny, len, o + lit * sw * 0.24, b); stroke(g, CABLE_HI, 0.38, sw * 0.22);
  }
  if (_nSeg === 0) return;
  // Lashings pull the bundle together between cradles.
  const lashC = sp + sw * 0.7;
  atStations(g, ST_LASH, SH_BAR, ax, ay, ux, uy, nx, ny, 0, lashC, 0, 0); stroke(g, LASH, 1, w * 0.32);
  atStations(g, ST_LASH, SH_BAR, ax, ay, ux, uy, nx, ny, -w * 0.06, lashC * 0.92, 0, 0); stroke(g, CABLE_HI, 0.28, w * 0.07);
  // Clamp plates on the cradles, bolted at each end.
  const clampC = sp + sw * 0.8;
  if (atStations(g, ST_CRADLE, SH_BAR, ax, ay, ux, uy, nx, ny, 0, clampC + w * 0.06, 0, 0) > 0) {
    stroke(g, CABLE_OUTLINE, 1, w * 0.56);
    atStations(g, ST_CRADLE, SH_BAR, ax, ay, ux, uy, nx, ny, 0, clampC, 0, 0); stroke(g, CLAMP, 1, w * 0.42);
    atStations(g, ST_CRADLE, SH_BAR, ax, ay, ux, uy, nx, ny, -w * 0.1, clampC * 0.9, 0, 0); stroke(g, CABLE_HI, 0.35, w * 0.08);
    atStations(g, ST_CRADLE, SH_FEET, ax, ay, ux, uy, nx, ny, w * 0.09, clampC * 0.82, 0, 0); stroke(g, CABLE_OUTLINE, 1, w * 0.2);
  }
  // Strain-relief collars where the run meets each node.
  const collarC = sp + sw * 0.95;
  atStations(g, ST_COLLAR, SH_BAR, ax, ay, ux, uy, nx, ny, 0, collarC + w * 0.07, 0, 0); stroke(g, CABLE_OUTLINE, 1, w * 0.95);
  atStations(g, ST_COLLAR, SH_BAR, ax, ay, ux, uy, nx, ny, 0, collarC, 0, 0); stroke(g, TRUSS, 1, w * 0.78);
  atStations(g, ST_COLLAR, SH_BAR, ax, ay, ux, uy, nx, ny, 0, collarC, 0, 0); stroke(g, CABLE_OUTLINE, 0.8, w * 0.1);
  atStations(g, ST_COLLAR, SH_BAR, ax, ay, ux, uy, nx, ny, -w * 0.26, collarC * 0.92, 0, 0); stroke(g, CABLE_HI, 0.4, w * 0.08);
}

/** Cable flow: energy inside the core strand, glimpsed between the stations
 *  (lashings, cradles and collars hide it), a lit band riding it, and a few
 *  sparks at a cradle's clamp as the band passes through. */
function drawCableFlow(
  g: Graphics, v: ConnectorVisual, comet: CometSegment, sourceIsLo: boolean,
  ax: number, ay: number, bx: number, by: number, scale: number, w: number, ra: number, rb: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  cableLayout(len, ra, rb, w / BASE_W.cable);
  const sw = w * 0.5;
  const sp = w * 0.55;
  const pulseColor = v.pulseColor ?? 0;
  const pulseAlpha = v.pulseAlpha ?? 0;
  // Faint bleed around the bundle.
  g.moveTo(ax, ay).lineTo(bx, by); stroke(g, v.color, v.glowAlpha * 0.6, w * 1.2);
  // The lit core, in the gaps between stations.
  if (_nSeg === 0) g.moveTo(ax, ay).lineTo(bx, by);
  else {
    const gap = w * 0.45;
    for (let j = 0; j < _nSeg; j++) {
      const t0 = _s0 + j * _seg + gap;
      const t1 = _s0 + (j + 1) * _seg - gap;
      if (t1 > t0) g.moveTo(ax + ux * t0, ay + uy * t0).lineTo(ax + ux * t1, ay + uy * t1);
    }
  }
  stroke(g, v.color, v.alpha, sw * 0.42);
  // The travelling lit band.
  const c = cometSegment(comet, v.pulseT ?? 0, sourceIsLo, ax, ay, bx, by, scale);
  g.moveTo(c.x0, c.y0).lineTo(c.x1, c.y1); stroke(g, pulseColor, pulseAlpha, sw * 0.7);
  if (_nSeg === 0) return;
  // Sparks at the clamp ends of a cradle the band is passing through.
  const d = ((c.x0 + c.x1) * 0.5 - ax) * ux + ((c.y0 + c.y1) * 0.5 - ay) * uy;
  const reach = w * 1.6;
  const s = w * 0.28;
  const clampC = sp + sw * 0.8;
  let n = 0;
  for (let j = 2; j < _nSeg; j += 2) {
    const t = _s0 + j * _seg;
    if (Math.abs(t - d) > reach) continue;
    for (let side = -1; side <= 1; side += 2) {
      const cc = side * clampC;
      seg(g, ax, ay, ux, uy, nx, ny, t, -s, cc - s, s, cc + s);
      seg(g, ax, ay, ux, uy, nx, ny, t, -s, cc + s, s, cc - s);
      n++;
    }
  }
  if (n > 0) stroke(g, pulseColor, pulseAlpha * 0.9, Math.max(w * 0.1, 1 / (scale > 0 ? scale : 1)));
}
