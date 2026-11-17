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
const MIN_PX: Record<LineLook, number> = { pipe: 3.5, cable: 3.5, conduit: 5 };

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

/** The steady body of one edge in pixi space (static layer). */
export function drawLineLookBody(g: Graphics, look: LineLook, ax: number, ay: number, bx: number, by: number, scale: number): void {
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
  if (look === 'cable') {
    // Three-strand bundle with clamp brackets.
    const sw = w * 0.3; // one strand
    const sp = w * 0.36; // strand spacing
    run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, SHADOW, 0.5, sp * 2 + sw * 1.8);
    run(g, ax, ay, bx, by, nx, ny, -sp); stroke(g, BODY, 0.95, sw);
    run(g, ax, ay, bx, by, nx, ny, sp); stroke(g, BODY, 0.95, sw);
    run(g, ax, ay, bx, by, nx, ny, 0); stroke(g, STEEL, 0.95, sw);
    run(g, ax, ay, bx, by, nx, ny, -sp - sw * 0.2); stroke(g, RIM, 0.3, sw * 0.3);
    const reach = sp + sw * 1.1;
    if (marks(g, ax, ay, ux, uy, len, 90 * k, 34 * k, 0, nx, ny, reach) > 0) stroke(g, STEEL, 0.95, w * 0.42);
    if (marks(g, ax, ay, ux, uy, len, 90 * k, 34 * k, 0, nx, ny, reach * 0.55) > 0) stroke(g, STEEL_DARK, 0.9, w * 0.14);
    return;
  }
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
  ax: number, ay: number, bx: number, by: number, scale: number,
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
  if (look === 'cable') {
    // The core strand carries the charge; one pulse travels it.
    g.moveTo(ax, ay).lineTo(bx, by); stroke(g, v.color, v.glowAlpha, w * 1.4);
    g.moveTo(ax, ay).lineTo(bx, by); stroke(g, v.color, v.alpha, w * 0.3);
    const c = cometSegment(comet, t, sourceIsLo, ax, ay, bx, by, scale);
    g.moveTo(c.x0, c.y0).lineTo(c.x1, c.y1); stroke(g, pulseColor, pulseAlpha, w * 0.5);
    return;
  }
  // Conduit: the channel lights up, two packets run it.
  g.moveTo(ax, ay).lineTo(bx, by); stroke(g, v.color, v.glowAlpha, w * 0.9);
  g.moveTo(ax, ay).lineTo(bx, by); stroke(g, v.color, v.alpha, w * 0.16);
  for (let i = 0; i < 2; i++) {
    const c = cometSegment(comet, (t + i / 2) % 1, sourceIsLo, ax, ay, bx, by, scale);
    g.moveTo(c.x0, c.y0).lineTo(c.x1, c.y1);
  }
  stroke(g, pulseColor, pulseAlpha, w * 0.2);
}
