/**
 * The shared cuts ("seams") between neighbouring wreck pieces: the edges the
 * break-up kicks (`wreckBreakKicks`, wreckPieces.ts) part along. Pure; runs
 * once per break (allocates).
 */
import { EDGE_CUT } from './fractureHull.js';
import type { WreckPieceGeometry } from './wreckPieceFrame.js';

/** A shared cut between two neighbouring pieces: endpoints and the unit
 *  normal from piece `i` to piece `j`, in the ship's scaled math-up frame. */
export interface Seam {
  i: number;
  j: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number;
  ny: number;
}

/** Collinearity / overlap tolerances for matching cut edges (ship frame, u). */
const SEAM_LINE_EPS = 0.05;
const SEAM_MIN_LEN = 0.5;
/** Cut edges of two pieces this close (u) touch (see `findSeams`). */
const SEAM_TOUCH_EPS = 0.5;

/** Every shared cut between pieces (cut edges of two pieces that lie on one
 *  line and overlap). The cut line separates the two pieces, so parting
 *  along its normal never overlaps them. A railgun channel's two banks
 *  (`EDGE_CUT` edges facing each other `channelGap` apart: the channel's
 *  width in the ship's scaled frame) are a seam too; without it the kill
 *  push closed the channel while the cracks opened. */
export function findSeams(geom: ReadonlyArray<WreckPieceGeometry>, channelGap = 0): Seam[] {
  const seams: Seam[] = [];
  for (let i = 0; i < geom.length; i++) {
    const gi = geom[i]!;
    const ni = gi.outline.length;
    for (let ea = 0; ea < ni; ea++) {
      if (!gi.cutEdges[ea]) continue;
      const p = gi.outline[ea]!;
      const q = gi.outline[(ea + 1) % ni]!;
      const px = p.x + gi.cx, py = p.y + gi.cy;
      const dx = q.x + gi.cx - px, dy = q.y + gi.cy - py;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < SEAM_MIN_LEN) continue;
      const ux = dx / len, uy = dy / len;
      // CCW outline: the outward normal is the edge direction turned clockwise.
      const nx = uy, ny = -ux;
      for (let j = i + 1; j < geom.length; j++) {
        const gj = geom[j]!;
        const nj = gj.outline.length;
        for (let eb = 0; eb < nj; eb++) {
          if (!gj.cutEdges[eb]) continue;
          const r = gj.outline[eb]!;
          const t = gj.outline[(eb + 1) % nj]!;
          const rx = r.x + gj.cx - px, ry = r.y + gj.cy - py;
          const tx = t.x + gj.cx - px, ty = t.y + gj.cy - py;
          // On this edge's line, or (a channel's facing bank) on the line
          // `channelGap` out along its outward normal.
          const off = channelGap > 0 && gi.cutEdges[ea] === EDGE_CUT && gj.cutEdges[eb] === EDGE_CUT
            && Math.abs(rx * nx + ry * ny - channelGap) <= SEAM_LINE_EPS ? channelGap : 0;
          if (Math.abs(rx * nx + ry * ny - off) > SEAM_LINE_EPS || Math.abs(tx * nx + ty * ny - off) > SEAM_LINE_EPS) continue;
          const s0 = Math.max(0, Math.min(rx * ux + ry * uy, tx * ux + ty * uy));
          const s1 = Math.min(len, Math.max(rx * ux + ry * uy, tx * ux + ty * uy));
          if (s1 - s0 < SEAM_MIN_LEN) continue;
          seams.push({ i, j, ax: px + ux * s0, ay: py + uy * s0, bx: px + ux * s1, by: py + uy * s1, nx, ny });
        }
      }
    }
  }
  // Neighbours whose cut edges touch without lying on one line: a fan crack
  // that ends on a zone crack leaves a T-junction, and the two sides of the
  // zone crack are jagged from different endpoints, so the pass above never
  // matches them (tuning 2026-11-13: such a pair parted only at the push
  // speed, the narrowest gap on screen). Each gets one seam at the closest
  // touch, along the outward normal of the longer of the two edges.
  const n = geom.length;
  const paired = new Uint8Array(n * n);
  for (const sm of seams) paired[sm.i * n + sm.j] = 1;
  for (let i = 0; i < n; i++) {
    const gi = geom[i]!;
    for (let j = i + 1; j < n; j++) {
      if (paired[i * n + j]) continue;
      const gj = geom[j]!;
      let best: Seam | null = null;
      let bestD = SEAM_TOUCH_EPS;
      for (let ea = 0; ea < gi.outline.length; ea++) {
        if (!gi.cutEdges[ea]) continue;
        const a0 = gi.outline[ea]!, a1 = gi.outline[(ea + 1) % gi.outline.length]!;
        const ax0 = a0.x + gi.cx, ay0 = a0.y + gi.cy, ax1 = a1.x + gi.cx, ay1 = a1.y + gi.cy;
        for (let eb = 0; eb < gj.outline.length; eb++) {
          if (!gj.cutEdges[eb]) continue;
          const b0 = gj.outline[eb]!, b1 = gj.outline[(eb + 1) % gj.outline.length]!;
          const bx0 = b0.x + gj.cx, by0 = b0.y + gj.cy, bx1 = b1.x + gj.cx, by1 = b1.y + gj.cy;
          const touch = closestTouch(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1);
          if (touch.d >= bestD) continue;
          const la = Math.sqrt((ax1 - ax0) ** 2 + (ay1 - ay0) ** 2);
          const lb = Math.sqrt((bx1 - bx0) ** 2 + (by1 - by0) ** 2);
          if (Math.max(la, lb) < SEAM_MIN_LEN) continue;
          // Outward normal of the longer edge, turned to point from i to j.
          const nx = la >= lb ? (ay1 - ay0) / la : -(by1 - by0) / lb;
          const ny = la >= lb ? -(ax1 - ax0) / la : (bx1 - bx0) / lb;
          bestD = touch.d;
          best = { i, j, ax: touch.x, ay: touch.y, bx: touch.x, by: touch.y, nx, ny };
        }
      }
      if (best) seams.push(best);
    }
  }
  return seams;
}

/** Distance between segments a and b, and the midpoint of their closest
 *  points (the touch), from the four endpoint-to-segment candidates. */
function closestTouch(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): { d: number; x: number; y: number } {
  let best = { d: Infinity, x: 0, y: 0 };
  const cand = (px: number, py: number, s0x: number, s0y: number, s1x: number, s1y: number): void => {
    const dx = s1x - s0x, dy = s1y - s0y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - s0x) * dx + (py - s0y) * dy) / l2)) : 0;
    const qx = s0x + t * dx, qy = s0y + t * dy;
    const d = Math.sqrt((px - qx) ** 2 + (py - qy) ** 2);
    if (d < best.d) best = { d, x: (px + qx) / 2, y: (py + qy) / 2 };
  };
  cand(ax0, ay0, bx0, by0, bx1, by1);
  cand(ax1, ay1, bx0, by0, bx1, by1);
  cand(bx0, by0, ax0, ay0, ax1, ay1);
  cand(bx1, by1, ax0, ay0, ax1, ay1);
  return best;
}
