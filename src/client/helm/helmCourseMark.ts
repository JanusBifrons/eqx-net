/**
 * Helm move marker: whether the local pilot sees the green course marker,
 * and where. The order lives in `ColyseusClient` (main thread); the marker
 * rides `RenderMirror.helmCourse` to the renderer (spatial ⇒ never Zustand,
 * #2). Shown only for the ship you fly, only a capital (helm `available`),
 * only while an order is active, never while spectating. Other players' and
 * NPC ships have no helm order on this client, so they never get a marker.
 *
 * No allocation: the caller owns `out` (#14).
 */
import type { HelmOrder } from '@core/helm/helm';

export interface HelmCourseMark {
  /** Course point, game space (Y-up). */
  x: number;
  y: number;
  /** Bumps on every new course tap: the renderer replays its "pop". */
  seq: number;
}

export function makeHelmCourseMark(): HelmCourseMark {
  return { x: 0, y: 0, seq: 0 };
}

export function resolveHelmCourseMark(
  order: Readonly<HelmOrder>,
  available: boolean,
  spectating: boolean,
  seq: number,
  out: HelmCourseMark,
): boolean {
  if (!order.active || !available || spectating) return false;
  out.x = order.tx;
  out.y = order.ty;
  out.seq = seq;
  return true;
}
