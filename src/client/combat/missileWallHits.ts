/**
 * Missile `wall_hit`s held for the drawn missile (off-pilot event timing,
 * slice 4b/6). A fence that stops a missile sends `wall_hit` (kind
 * `missile`) in the same tick as the missile's `missile_detonated`, so it
 * gets the same stamp and deadline (`MissileMirror.holdMissileWallHit`) and
 * is released by the same per-frame step, against the missile read point
 * (`releaseMissileDetonations`): the wall flash shows the frame the drawn
 * missile explodes on it. The event names no missile, so this is a plain
 * stamped list, not a field on a missile.
 *
 * Flat pooled storage `[x, y, stampMs, deadlineMs]`; no allocation once warm
 * (#14) beyond the trigger the release pushes (as the arrival path did).
 */
import type { RenderMirror } from '@core/contracts/IRenderer';

const STRIDE = 4;
const _held: number[] = [];
let _len = 0;

/** Draw a fence impact now (the `wall_hit` visual). */
export function pushWallHit(mirror: RenderMirror, x: number, y: number): void {
  mirror.pendingEffectTriggers?.push({ kind: 'wall-hit', worldX: x, worldY: y });
}

/** Hold a fence impact at (x, y) until the read point reaches `stampMs` or
 *  wall `deadlineMs` passes. */
export function holdWallHit(x: number, y: number, stampMs: number, deadlineMs: number): void {
  const i = _len;
  _held[i] = x; _held[i + 1] = y; _held[i + 2] = stampMs; _held[i + 3] = deadlineMs;
  _len = i + STRIDE;
}

/** Release each held impact whose stamp `readPointMs` (NaN: none this frame)
 *  reached or whose deadline `nowMs` passed. */
export function releaseWallHits(mirror: RenderMirror, nowMs: number, readPointMs: number): void {
  let i = 0;
  while (i < _len) {
    if (!(readPointMs >= _held[i + 2]! || nowMs >= _held[i + 3]!)) { i += STRIDE; continue; }
    pushWallHit(mirror, _held[i]!, _held[i + 1]!);
    // Swap-remove with the last entry.
    const last = _len - STRIDE;
    for (let k = 0; k < STRIDE; k++) _held[i + k] = _held[last + k]!;
    _len = last;
  }
}

/** Drop every held impact (welcome / sector change: the old room's). */
export function clearWallHits(): void { _len = 0; }

/** Held impacts (tests). */
export function heldWallHitCount(): number { return _len / STRIDE; }
