/**
 * Pure maths for the floating thumbstick (unit-tested). Screen space, CSS px,
 * y DOWN (pointer convention).
 */

export interface StickVec {
  /** -1..1, right positive. */
  x: number;
  /** -1..1, DOWN positive (pointer convention). */
  y: number;
  /** 0..1 */
  mag: number;
}

/**
 * Where the stick base spawns for a touch at (px, py): under the finger, but
 * pulled in so the whole ring stays on screen (a touch hard against the bezel
 * would otherwise leave no room to push outward).
 */
export function clampStickOrigin(
  px: number,
  py: number,
  radius: number,
  viewW: number,
  viewH: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  const pad = radius + 6;
  out.x = Math.min(Math.max(px, pad), Math.max(pad, viewW - pad));
  out.y = Math.min(Math.max(py, pad), Math.max(pad, viewH - pad));
  return out;
}

/** Normalised stick vector from origin to the finger, clamped to the ring. */
export function stickVector(
  ox: number,
  oy: number,
  px: number,
  py: number,
  radius: number,
  out: StickVec,
): StickVec {
  const dx = px - ox;
  const dy = py - oy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6 || radius <= 0) {
    out.x = 0;
    out.y = 0;
    out.mag = 0;
    return out;
  }
  const mag = Math.min(1, d / radius);
  out.x = (dx / d) * mag;
  out.y = (dy / d) * mag;
  out.mag = mag;
  return out;
}

/**
 * Drag-follow ("leash"): when the finger runs past the ring, drag the origin
 * along behind it so reversing direction responds instantly instead of having
 * to travel back across the whole ring. Mutates origin in place; returns true
 * if it moved.
 */
export function leashOrigin(
  origin: { x: number; y: number },
  px: number,
  py: number,
  radius: number,
): boolean {
  const dx = px - origin.x;
  const dy = py - origin.y;
  const d = Math.hypot(dx, dy);
  if (d <= radius) return false;
  const k = (d - radius) / d;
  origin.x += dx * k;
  origin.y += dy * k;
  return true;
}

/** A press counts as a tap if it was short and barely moved. */
export function isTap(durationMs: number, travelPx: number): boolean {
  return durationMs < 260 && travelPx < 10;
}
