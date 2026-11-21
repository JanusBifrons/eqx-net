/**
 * Group-move spread (RTS stop drift, 2026-11-14), the pure half of
 * `FleetCommandSubsystem.spreadMove`: a MOVE that sends several ships to one
 * point gives each its own spot round it, a hex cluster `spacing` apart (the
 * largest mover's `flockSeparation`, #18). Outermost ships pick first, each
 * the free spot nearest its place in the group (target + its offset from the
 * group's centre), so paths don't cross. Sent to the very same point they
 * arrived hull to hull and shoved each other.
 *
 * Allocation-free (#14): the caller owns the scratch arrays.
 */

/** Reused arrays, sized for the most ships one command may name. */
export interface FleetSpreadScratch {
  /** In: each mover's position (the target point when unknown). Clobbered. */
  readonly offX: Float64Array;
  readonly offY: Float64Array;
  readonly slotX: Float64Array;
  readonly slotY: Float64Array;
  readonly used: Uint8Array;
  readonly done: Uint8Array;
  /** Out: the movers in the order they picked (outermost first). */
  readonly order: Uint8Array;
  /** Out: mover i's own spot. */
  readonly outX: Float64Array;
  readonly outY: Float64Array;
}

export function makeFleetSpreadScratch(max: number): FleetSpreadScratch {
  return {
    offX: new Float64Array(max), offY: new Float64Array(max),
    slotX: new Float64Array(max), slotY: new Float64Array(max),
    used: new Uint8Array(max), done: new Uint8Array(max), order: new Uint8Array(max),
    outX: new Float64Array(max), outY: new Float64Array(max),
  };
}

/** Give each of the `n` movers (positions in `s.offX/offY`) its own spot
 *  round (tx, ty), written to `s.outX/outY`. */
export function spreadMoveSlots(n: number, tx: number, ty: number, spacing: number, s: FleetSpreadScratch): void {
  const ox = s.offX, oy = s.offY;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += ox[i]!; cy += oy[i]!; }
  cx /= n; cy /= n;
  for (let i = 0; i < n; i++) { ox[i] = ox[i]! - cx; oy[i] = oy[i]! - cy; s.done[i] = 0; }
  // The first n spots of a hex cluster: the point, then rings of 6r.
  const sx = s.slotX, sy = s.slotY, used = s.used;
  let m = 0;
  for (let r = 0; m < n; r++) {
    if (r === 0) { sx[0] = tx; sy[0] = ty; used[0] = 0; m = 1; continue; }
    for (let side = 0; side < 6 && m < n; side++) {
      const a0 = (side * Math.PI) / 3, a1 = ((side + 1) * Math.PI) / 3;
      const x0 = Math.cos(a0) * r * spacing, y0 = Math.sin(a0) * r * spacing;
      const x1 = Math.cos(a1) * r * spacing, y1 = Math.sin(a1) * r * spacing;
      for (let j = 0; j < r && m < n; j++) {
        sx[m] = tx + x0 + ((x1 - x0) * j) / r;
        sy[m] = ty + y0 + ((y1 - y0) * j) / r;
        used[m] = 0;
        m++;
      }
    }
  }
  for (let k = 0; k < n; k++) {
    let pick = -1, far = -1;
    for (let i = 0; i < n; i++) {
      if (s.done[i] === 1) continue;
      const d = ox[i]! * ox[i]! + oy[i]! * oy[i]!;
      if (d > far) { far = d; pick = i; }
    }
    const wx = tx + ox[pick]!, wy = ty + oy[pick]!;
    let best = -1, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (used[j] === 1) continue;
      const dx = sx[j]! - wx, dy = sy[j]! - wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = j; }
    }
    used[best] = 1;
    s.outX[pick] = sx[best]!;
    s.outY[pick] = sy[best]!;
    s.done[pick] = 1;
    s.order[k] = pick;
  }
}
