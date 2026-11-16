/**
 * Fracture v13 burned gap: the part of the break-up kick (`wreckBreakKicks`,
 * the one kick model, wreckPieces.ts) that parts a heavy-beam kill's banks
 * off the beam's line. Split out of wreckPieces.ts for its size cap only.
 * capital-destruction.md "Burned gap".
 */
import { cutDirFromAngle } from './fractureHull.js';
import type { WreckPieceGeometry } from './wreckPieceFrame.js';

/** A burned gap's line for `partGap`: the normal (scaled math-up), each
 *  piece's side of it, and the speed its banks part at. */
export interface GapLine { px: number; py: number; nx: number; ny: number; side: Int8Array; reach: number; speed: number }

/** The gap line through (`px`, `py`, scaled math-up) at the u16 hull-frame
 *  cut angle `ang`; its banks are the outline points within `cutGap` of it. */
export function gapLine(geom: ReadonlyArray<WreckPieceGeometry>, slice: { px: number; py: number; ang: number }, cutGap: number, speed: number): GapLine {
  const d = cutDirFromAngle(slice.ang);
  // Hull 1× Pixi-up direction → scaled math-up (y flips); its normal.
  const nx = d.y;
  const ny = d.x;
  const side = new Int8Array(geom.length);
  for (let i = 0; i < geom.length; i++) {
    const g = geom[i]!;
    side[i] = (g.cx - slice.px) * nx + (g.cy - slice.py) * ny >= 0 ? 1 : -1;
  }
  return { px: slice.px, py: slice.py, nx, ny, side, reach: cutGap, speed };
}

/** The burned gap's banks part (owner 2026-11-16: "a very slight force
 *  pushing those parts apart"): every outline point of a piece within the
 *  gap's reach of the line moves straight away from it, on the piece's own
 *  side, at `speed` or more (spin included, so no corner swings into the
 *  beam); a piece clear of it, its centre. One Gauss–Seidel pass of the
 *  kick's guard (aiming at `aim` × `speed`); returns the worst shortfall. */
export function partGap(
  gl: GapLine, geom: ReadonlyArray<WreckPieceGeometry>, kvx: Float64Array, kvy: Float64Array, kw: Float64Array, aim: number,
): number {
  let worst = 0;
  for (let i = 0; i < geom.length; i++) {
    const g = geom[i]!;
    const sx = gl.side[i]! * gl.nx;
    const sy = gl.side[i]! * gl.ny;
    // Away speed of the centre, then of each bank point (v + ω × r).
    let away = kvx[i]! * sx + kvy[i]! * sy;
    for (const v of g.outline) {
      const dist = (g.cx + v.x - gl.px) * gl.nx + (g.cy + v.y - gl.py) * gl.ny;
      if (dist > gl.reach || dist < -gl.reach) continue;
      away = Math.min(away, (kvx[i]! - kw[i]! * v.y) * sx + (kvy[i]! + kw[i]! * v.x) * sy);
    }
    if (away >= gl.speed) continue;
    worst = Math.max(worst, gl.speed - away);
    const dv = aim * gl.speed - away;
    kvx[i] = kvx[i]! + sx * dv;
    kvy[i] = kvy[i]! + sy * dv;
  }
  return worst;
}
