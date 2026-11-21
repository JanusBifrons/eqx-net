/**
 * Where a structure's cable sockets sit against its DRAWN art (stud audit).
 *
 * The draw plan (`buildStructureVisual`, the one the forge bakes) is
 * rasterised at 1 u: every solid rect and every non-glow poly. The OUTER
 * silhouette is what the outside flood fill touches, so dark gaps between
 * modules inside the building do not count as an edge. For each socket
 * (`structureSockets`, the server's list) this reports how far it is from that
 * outer edge, and which raised part (if any) of a style's art covers it.
 *
 * Pure measurement for the audit / guard tests and the art lab: no Pixi.
 */
import { getStructureKind, isStructureKindId, structureSockets } from '../../../shared-types/structureKinds.js';
import { buildStructureVisual } from './structureVisuals.js';

/** One socket against the art. `dist`: world units from the socket to the
 *  outer drawn edge. `inside`: the socket point is covered by art. `under`:
 *  lift of the highest raised style part (lift > the deck's) covering it, or 0. */
export interface SocketArtEdge { index: number; x: number; y: number; dist: number; inside: boolean; under: number }

/** Rects fainter than this are washes / hints, not hull. */
const SOLID_ALPHA = 0.5;
/** A style part this high covers a stud (the deck plate stands at 4). */
const RAISED_LIFT = 6;

type Pt = readonly [number, number];

function inPoly(pts: readonly Pt[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[j]!;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) c = !c;
  }
  return c;
}

/** Measure every socket of `kind` against its drawn art in `style`. */
export function socketArtEdges(kind: string, style = 'c'): SocketArtEdge[] {
  const accent = isStructureKindId(kind) ? getStructureKind(kind).color : 0x888888;
  const vis = buildStructureVisual(kind, { accent, style, seed: 1, built: true, powered: true });
  const { w, h } = vis.footprint;
  const M = 24;
  const x0 = Math.floor(-w / 2 - M), y0 = Math.floor(-h / 2 - M);
  const GW = Math.ceil(w + 2 * M), GH = Math.ceil(h + 2 * M);
  const cov = new Uint8Array(GW * GH);
  for (const r of vis.rects) {
    if (r.alpha < SOLID_ALPHA) continue;
    const ia = Math.max(0, Math.floor(r.x - x0)), ib = Math.min(GW, Math.ceil(r.x + r.w - x0));
    const ja = Math.max(0, Math.floor(r.y - y0)), jb = Math.min(GH, Math.ceil(r.y + r.h - y0));
    for (let j = ja; j < jb; j++) for (let i = ia; i < ib; i++) cov[j * GW + i] = 1;
  }
  const polys = (vis.polys ?? []).filter((p) => p.mat !== 'glow');
  for (const p of polys) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of p.pts) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
    const ia = Math.max(0, Math.floor(minX - x0)), ib = Math.min(GW, Math.ceil(maxX - x0));
    const ja = Math.max(0, Math.floor(minY - y0)), jb = Math.min(GH, Math.ceil(maxY - y0));
    for (let j = ja; j < jb; j++) for (let i = ia; i < ib; i++) {
      if (inPoly(p.pts, x0 + i + 0.5, y0 + j + 0.5)) cov[j * GW + i] = 1;
    }
  }
  // Outside flood from the grid border.
  const out = new Uint8Array(GW * GH);
  const stack: number[] = [];
  for (let i = 0; i < GW; i++) { stack.push(i, (GH - 1) * GW + i); }
  for (let j = 0; j < GH; j++) { stack.push(j * GW, j * GW + GW - 1); }
  while (stack.length) {
    const k = stack.pop()!;
    if (out[k] || cov[k]) continue;
    out[k] = 1;
    const i = k % GW, j = (k - i) / GW;
    if (i > 0) stack.push(k - 1);
    if (i < GW - 1) stack.push(k + 1);
    if (j > 0) stack.push(k - GW);
    if (j < GH - 1) stack.push(k + GW);
  }
  // Outer edge: points on cell sides between a covered cell and an outside cell.
  const edge: number[] = [];
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = j * GW + i;
    if (!cov[k]) continue;
    if (i > 0 && out[k - 1]) edge.push(x0 + i, y0 + j + 0.5);
    if (i < GW - 1 && out[k + 1]) edge.push(x0 + i + 1, y0 + j + 0.5);
    if (j > 0 && out[k - GW]) edge.push(x0 + i + 0.5, y0 + j);
    if (j < GH - 1 && out[k + GW]) edge.push(x0 + i + 0.5, y0 + j + 1);
  }
  return structureSockets(kind).map((s, index) => {
    const x = s.x, y = -s.y; // pixi frame
    let best = Infinity;
    for (let e = 0; e < edge.length; e += 2) best = Math.min(best, Math.hypot(edge[e]! - x, edge[e + 1]! - y));
    // One unit in: a point on a diagonal edge can land in an uncovered cell
    // half a unit in (1-unit raster), though the deck plate covers it.
    const ci = Math.floor(x - x0 - s.nx), cj = Math.floor(y - y0 + s.ny);
    const inside = ci >= 0 && ci < GW && cj >= 0 && cj < GH && cov[cj * GW + ci] === 1;
    let under = 0;
    for (const p of polys) if (p.lift > RAISED_LIFT && p.lift > under && inPoly(p.pts, x - s.nx * 2, y + s.ny * 2)) under = p.lift;
    return { index, x: s.x, y: s.y, dist: best, inside, under };
  });
}
