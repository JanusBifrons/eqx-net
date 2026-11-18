/**
 * One route line, drawn the same way wherever a route is shown (navigation
 * slice 14, owner 2026-11-17 "whole route line"): the fleet patrol pick
 * (`FleetOverlay`, a closed loop) and the helm's autopilot course
 * (`HelmCourseMarker`, open, from the ship). Traces onto the caller's
 * Graphics; the caller strokes / fills. Points are game space (Y-up), packed
 * x, y; `project` maps Pixi world (Y-down) to the layer the Graphics sits in.
 * No allocation (#14): `p` is the caller's scratch.
 */
import type { Graphics } from 'pixi.js';

export type RouteProjectFn = (pixiWorldX: number, pixiWorldY: number, out: { x: number; y: number }) => void;

/** Trace the polyline through points `first .. first + count - 1`, starting
 *  at (`startX`, `startY`) first when given (NaN = none); `closed` returns to
 *  the first point. Call `g.stroke` after. */
export function traceRoute(
  g: Graphics, pts: ArrayLike<number>, first: number, count: number, closed: boolean,
  startX: number, startY: number, project: RouteProjectFn, p: { x: number; y: number },
): void {
  if (count <= 0) return;
  const last = first + count - 1;
  if (!Number.isNaN(startX)) project(startX, -startY, p);
  else if (closed) project(pts[last * 2]!, -pts[last * 2 + 1]!, p);
  else project(pts[first * 2]!, -pts[first * 2 + 1]!, p);
  g.moveTo(p.x, p.y);
  for (let i = first; i <= last; i++) {
    project(pts[i * 2]!, -pts[i * 2 + 1]!, p);
    g.lineTo(p.x, p.y);
  }
}

/** A dot of `radiusPx` at each point `first .. first + count - 1`. Call `g.fill` after. */
export function routeDots(
  g: Graphics, pts: ArrayLike<number>, first: number, count: number, radiusPx: number,
  project: RouteProjectFn, p: { x: number; y: number },
): void {
  for (let i = first; i < first + count; i++) {
    project(pts[i * 2]!, -pts[i * 2 + 1]!, p);
    g.circle(p.x, p.y, radiusPx);
  }
}
