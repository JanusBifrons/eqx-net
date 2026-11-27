/**
 * Selection HUD S7: the dashed preview line from the selected ships'
 * centroid to a focus that is NOT one of them (an enemy you tapped with your
 * fleet selected). Drawn by `FleetOverlay` on its one Graphics, as dots
 * through `routeDots` (`routeLine.ts`); red for a hostile, else neutral.
 * Skipped while the fire-control lock link (`AimFeedbackRenderer`) already
 * joins you to that target, so the two never stack. Alloc-free (#14): the
 * dot points live in a fixed scratch buffer.
 */
import type { Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { routeDots, type RouteProjectFn } from './routeLine.js';

export const TARGET_LINE_HOSTILE = 0xff6b6b;
export const TARGET_LINE_NEUTRAL = 0xdfe8f5;
/** Screen px between dots, their radius, and the most dots one line draws. */
export const TARGET_LINE_GAP_PX = 10;
const DOT_PX = 1.5;
export const TARGET_LINE_MAX_DOTS = 96;

type LockList = RenderMirror['localGroups'];
/** Game-space pose by pick id (`FleetOverlay.resolveEntityPos`). */
export type ResolvePosFn = (mirror: RenderMirror, id: string, out: { x: number; y: number }) => boolean;

const FILL_HOSTILE = { color: TARGET_LINE_HOSTILE, alpha: 0.8 };
const FILL_NEUTRAL = { color: TARGET_LINE_NEUTRAL, alpha: 0.8 };

/** Pure, alloc-free: lock key (`s:<swarmId>` / `p:<id>`, `lockKeyFor`) names pick id
 *  (`swarm-<n>` / a ship id). */
export function lockKeyNamesPick(key: string, pickId: string): boolean {
  if (key.length < 3 || key.charCodeAt(1) !== 58 /* : */) return false;
  if (key.charCodeAt(0) === 115 /* s */) {
    if (!pickId.startsWith('swarm-') || key.length - 2 !== pickId.length - 6) return false;
    for (let i = 2; i < key.length; i++) if (key.charCodeAt(i) !== pickId.charCodeAt(i + 4)) return false;
    return true;
  }
  return key.length - 2 === pickId.length && key.endsWith(pickId);
}

/** Pure: the lock link to `targetId` is showing (any of your groups holds or
 *  builds a lock on it: `AimFeedbackRenderer` draws a line to every one). */
export function lockLinkShowing(groups: LockList, targetId: string): boolean {
  if (groups === undefined) return false;
  for (let gi = 0; gi < groups.length; gi++) {
    const l = groups[gi]!.l;
    for (let li = 0; li < l.length; li++) if (lockKeyNamesPick(l[li]!.t, targetId)) return true;
  }
  return false;
}

/** Pure: draw the preview line? Own ships selected, a focus outside them,
 *  and no lock link already joining you to it. */
export function targetLineWanted(selected: ReadonlySet<string>, focusId: string | null, groups: LockList): boolean {
  return selected.size > 0 && focusId !== null && !selected.has(focusId) && !lockLinkShowing(groups, focusId);
}

/** Pure: the target reads hostile (a drone hunting you, or anything locking you). */
export function targetLineHostile(mirror: RenderMirror, focusId: string): boolean {
  const by = mirror.localLockedBy;
  if (by !== undefined) for (let i = 0; i < by.length; i++) if (lockKeyNamesPick(by[i]!.t, focusId)) return true;
  if (!focusId.startsWith('swarm-')) return false;
  let n = 0;
  for (let i = 6; i < focusId.length; i++) n = n * 10 + (focusId.charCodeAt(i) - 48);
  return mirror.swarm?.get(n)?.isHostileToLocal === true;
}

/** Scratch: game-space points (packed x, y), centroid and target poses. */
const _pts = new Float64Array(TARGET_LINE_MAX_DOTS * 2);
const _g = { x: 0, y: 0 };
const _a = { x: 0, y: 0 };
const _b = { x: 0, y: 0 };

/**
 * Queue the dots from the selection centroid to the focus and fill them.
 * Returns the dots drawn (0 when either end is unknown or they overlap).
 */
export function drawTargetLine(
  g: Graphics, mirror: RenderMirror, selected: ReadonlySet<string>, focusId: string,
  resolveEntityPos: ResolvePosFn, project: RouteProjectFn, p: { x: number; y: number },
): number {
  let n = 0;
  let cx = 0;
  let cy = 0;
  for (const id of selected) {
    if (!resolveEntityPos(mirror, id, _g)) continue;
    cx += _g.x;
    cy += _g.y;
    n++;
  }
  if (n === 0 || !resolveEntityPos(mirror, focusId, _g)) return 0;
  cx /= n;
  cy /= n;
  project(cx, -cy, _a);
  project(_g.x, -_g.y, _b);
  const screenLen = Math.hypot(_b.x - _a.x, _b.y - _a.y);
  const dots = Math.min(TARGET_LINE_MAX_DOTS, Math.floor(screenLen / TARGET_LINE_GAP_PX));
  if (dots < 2) return 0;
  // Interior dots only: none on the ships' centre or on the target.
  for (let i = 0; i < dots - 1; i++) {
    const t = (i + 1) / dots;
    _pts[i * 2] = cx + (_g.x - cx) * t;
    _pts[i * 2 + 1] = cy + (_g.y - cy) * t;
  }
  routeDots(g, _pts, 0, dots - 1, DOT_PX, project, p);
  g.fill(targetLineHostile(mirror, focusId) ? FILL_HOSTILE : FILL_NEUTRAL);
  return dots - 1;
}
