import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { getStructureKind, isStructureKindId } from '../../shared-types/structureKinds.js';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';
import { mainThreadNowMs } from './mainThreadNow.js';

/**
 * THE selection marker (structures follow-up Item B4; RTS Part A: one
 * selection concept).
 *
 * Draws the same 4-corner bracket around EVERY selected entity: each selected
 * ship (the command-view ship selection) plus the focus (the entity whose
 * details panel shows; with ships selected it is one of them). There is no
 * second marker style: `FleetOverlay` draws only order lines, the drag box,
 * pick previews and the hold cue.
 *
 * Screen space: ONE `Graphics` on the stage (one draw call however many ships
 * are selected; the fleet-fight scene sits near the draw-call budget), cleared
 * and redrawn by {@link draw} in the Pixi ticker AFTER the frame's camera tick,
 * so the brackets project through the transform the world renders with (a
 * world-follower drawn before the tick lags a frame of camera motion; lock
 * `tests/e2e/fleet-overlay-camera.spec.ts`). A bracket is the entity's half
 * extents (radius for round things, the quarter-turn footprint box for a
 * structure) plus a pad at the current zoom, never smaller than {@link MIN_HALF_PX}, so it
 * reads at far command-view zoom too; at zoom 1 it is the pre-Part-A look.
 *
 * Pose resolution follows the `HealthBarManager` id convention:
 *   - ship (pilot-flown or AI-flown hull) → `mirror.ships.get(id)`
 *   - drone / structure / asteroid → `mirror.swarm.get(n)` for `swarm-<n>`
 * Alloc-free (#14): the swarm id is parsed by hand, the pose read goes into
 * reused scratch.
 */
const BRACKET_COLOR = 0x66ddff;
const BRACKET_THICKNESS = 2;
/** Corner arm length as a fraction of the bracket half-size. */
const CORNER_FRAC = 0.32;
/** Pad past the entity radius so the bracket sits just OUTSIDE the silhouette. */
const RADIUS_PAD = 8;
/** Min half-size: in WORLD units for the focus anchor, in px for the drawn bracket. */
const MIN_HALF = 14;
export const MIN_HALF_PX = MIN_HALF;
/** Fallback collision radius when a ship kind can't be resolved. */
const SHIP_FALLBACK_RADIUS = 20;

const _poseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };

/** A selectable entity's game-space centre and half extents (`hw` along x,
 *  `hh` along y). Round things (ships, drones, rocks) have `hw = hh = r`; a
 *  structure is its quarter-turn catalogue footprint box, like the pick. */
export interface SelectableTarget { x: number; y: number; r: number; hw: number; hh: number }

/** Game-space pose + half extents of a selectable entity into `out`; false when gone. */
export function resolveSelectable(mirror: RenderMirror, id: string, out: SelectableTarget): boolean {
  const ship = mirror.ships.get(id);
  if (ship !== undefined) {
    out.x = ship.x;
    out.y = ship.y;
    out.r = getShipKind(ship.kind)?.radius ?? SHIP_FALLBACK_RADIUS;
    out.hw = out.r;
    out.hh = out.r;
    return true;
  }
  if (mirror.swarm === undefined || id.length <= 6 || !id.startsWith('swarm-')) return false;
  let n = 0;
  for (let i = 6; i < id.length; i++) {
    const c = id.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return false;
    n = n * 10 + c;
  }
  const sw = mirror.swarm.get(n);
  if (sw === undefined) return false;
  // Drones (kind 1) + structures (kind 2) render from `entry.x/y` (resolved
  // once per frame in updateMirror); asteroids use the interpolation path.
  if (sw.kind === 1 || sw.kind === 2) {
    out.x = sw.x;
    out.y = sw.y;
  } else {
    const lerped = interpolateSwarmPose(sw, mainThreadNowMs(mirror, performance.now()), _poseScratch);
    out.x = lerped.x;
    out.y = lerped.y;
  }
  out.r = sw.radius;
  if (sw.kind === 2 && sw.shipKind !== undefined && isStructureKindId(sw.shipKind)) {
    // A structure's bounding radius is its footprint's half-DIAGONAL: a long
    // kind (the 960x600 Shipyard) would get a box far taller than the yard.
    // Frame its (quarter-turn) footprint box instead, as `pickEntityAt` hits it.
    const fp = getStructureKind(sw.shipKind).footprint;
    const quarter = Math.round((sw.angle * 2) / Math.PI) % 2 !== 0;
    out.hw = (quarter ? fp.h : fp.w) / 2;
    out.hh = (quarter ? fp.w : fp.h) / 2;
  } else {
    out.hw = sw.radius;
    out.hh = sw.radius;
  }
  return true;
}

export type BracketProjectFn = (pixiWorldX: number, pixiWorldY: number, out: { x: number; y: number }) => void;

export class SelectionBracket {
  private readonly gfx: Graphics;
  private readonly _t: SelectableTarget = { x: 0, y: 0, r: 0, hw: 0, hh: 0 };
  private readonly _s = { x: 0, y: 0 };
  /** WS-9 (R2.30) — the Pixi-WORLD point just ABOVE the focus (its bracket
   *  top), or null when there is no focus. The renderer projects this to
   *  screen each frame so the world-anchored stats box floats over it.
   *  Pixi-world coords (x = gameX, y = -(gameY + half)). */
  lastWorldX: number | null = null;
  lastWorldY: number | null = null;
  /** Bracket half-size in WORLD units for the focus (0 when there is none):
   *  the box's centre is this far below `lastWorldY`. */
  lastWorldHalf = 0;
  /** Brackets drawn in the last {@link draw} (test/diag hook). */
  lastMarkerCount = 0;
  /** First bracket drawn in the last {@link draw}: its id and screen centre (test/diag hook). */
  lastMarkerId: string | null = null;
  readonly lastMarker = { x: NaN, y: NaN };

  constructor(parent: Container) {
    this.gfx = new Graphics();
    this.gfx.visible = false;
    parent.addChild(this.gfx);
  }

  /**
   * Per frame (in `update()`): resolve the focus. Returns true when it is
   * present; the caller clears the focus on false so the panel and the server
   * stats stream tear down. Sets the details-panel anchor.
   */
  resolveFocus(mirror: RenderMirror, focusId: string | null): boolean {
    if (focusId === null || !resolveSelectable(mirror, focusId, this._t)) {
      this.lastWorldX = null;
      this.lastWorldY = null;
      this.lastWorldHalf = 0;
      return false;
    }
    const half = Math.max(MIN_HALF, this._t.hh + RADIUS_PAD);
    this.lastWorldHalf = half;
    this.lastWorldX = this._t.x;
    this.lastWorldY = -(this._t.y + half);
    return true;
  }

  /**
   * In the ticker after the camera tick: one bracket per selected ship, plus
   * the focus when it is not one of them. Hidden when there is nothing.
   */
  draw(
    mirror: RenderMirror,
    ships: ReadonlySet<string>,
    focusId: string | null,
    project: BracketProjectFn,
    zoom: number,
  ): void {
    const g = this.gfx;
    const extraFocus = focusId !== null && !ships.has(focusId);
    if (ships.size === 0 && !extraFocus) {
      if (g.visible) {
        g.clear();
        g.visible = false;
      }
      this.lastMarkerCount = 0;
      this.lastMarkerId = null;
      return;
    }
    g.clear();
    let n = 0;
    for (const id of ships) if (this.bracket(mirror, id, project, zoom, n)) n++;
    if (extraFocus && this.bracket(mirror, focusId, project, zoom, n)) n++;
    if (n > 0) g.stroke({ width: BRACKET_THICKNESS, color: BRACKET_COLOR, alpha: 0.95 });
    else this.lastMarkerId = null;
    g.visible = n > 0;
    this.lastMarkerCount = n;
  }

  /** Queue the 4 corners for `id` (screen px); false when it can't be resolved. */
  private bracket(mirror: RenderMirror, id: string, project: BracketProjectFn, zoom: number, index: number): boolean {
    const t = this._t;
    if (!resolveSelectable(mirror, id, t)) return false;
    const s = this._s;
    project(t.x, -t.y, s);
    const hw = Math.max(MIN_HALF_PX, (t.hw + RADIUS_PAD) * zoom);
    const hh = Math.max(MIN_HALF_PX, (t.hh + RADIUS_PAD) * zoom);
    const arm = Math.min(hw, hh) * CORNER_FRAC;
    const x = s.x;
    const y = s.y;
    const g = this.gfx;
    g.moveTo(x - hw, y - hh + arm).lineTo(x - hw, y - hh).lineTo(x - hw + arm, y - hh);
    g.moveTo(x + hw - arm, y - hh).lineTo(x + hw, y - hh).lineTo(x + hw, y - hh + arm);
    g.moveTo(x + hw, y + hh - arm).lineTo(x + hw, y + hh).lineTo(x + hw - arm, y + hh);
    g.moveTo(x - hw + arm, y + hh).lineTo(x - hw, y + hh).lineTo(x - hw, y + hh - arm);
    if (index === 0) {
      this.lastMarkerId = id;
      this.lastMarker.x = x;
      this.lastMarker.y = y;
    }
    return true;
  }

  destroy(): void {
    this.gfx.destroy();
  }
}
