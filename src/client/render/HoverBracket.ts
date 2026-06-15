import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';

/**
 * Hover outline (WS-10 / R2.4) — a SIBLING of {@link SelectionBracket} drawn
 * around the entity the desktop pointer is HOVERING over (set from pointer-move
 * via `pickEntityAt`, renderer-local — never Zustand, invariant #2).
 *
 * It is a SEPARATE concern from the click-selected entity: `SelectionBracket` is
 * single-selection and owns the clicked id; hover is a concurrent second entity,
 * so it gets its own pooled `Graphics`. The style is deliberately LIGHTER +
 * thinner than the selection bracket so the two read distinctly when both are up
 * (the caller suppresses hover on the already-selected entity so they never
 * stack on the same target).
 *
 * Same `update(mirror, hoveredId)` discipline as the selection bracket
 * (invariant #14): ONE pooled Graphics, dirty-flag redraw (geometry rebuilt only
 * when the bracket SIZE changes), module-scratch for any interpolated pose. The
 * pose resolution mirrors the `HealthBarManager` / `SelectionBracket` lookup
 * convention so the same id resolves the same live pose every frame.
 */
const HOVER_COLOR = 0xbfe6ff;
const HOVER_THICKNESS = 1;
/** Corner arm length as a fraction of the bracket half-size. */
const CORNER_FRAC = 0.32;
/** Pad past the entity radius so the outline sits just OUTSIDE the silhouette. */
const RADIUS_PAD = 6;
/** Min half-size so a tiny drone still gets a visible outline. */
const MIN_HALF = 13;
/** Fallback collision radius when a ship kind can't be resolved. */
const SHIP_FALLBACK_RADIUS = 20;

// Module-scope scratch reused by the (rare) asteroid/drone interpolation read,
// matching SelectionBracket — stays alloc-free regardless of the resolved kind.
const _poseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };

export class HoverBracket {
  private readonly gfx: Graphics;
  /** Last-drawn half-size — the dirty-flag sentinel. -1 forces a first rebuild. */
  private drawnHalf = -1;

  constructor(parent: Container) {
    this.gfx = new Graphics();
    this.gfx.visible = false;
    parent.addChild(this.gfx);
  }

  /**
   * Position + (lazily) redraw the hover outline for `hoveredId`. Returns true
   * if the entity was resolved this frame; false when `hoveredId` is null or the
   * entity is gone (the caller clears `_hoveredId` on false).
   */
  update(mirror: RenderMirror, hoveredId: string | null): boolean {
    if (hoveredId === null) {
      this.gfx.visible = false;
      return false;
    }

    let ex: number | undefined;
    let ey: number | undefined;
    let radius = SHIP_FALLBACK_RADIUS;

    const ship = mirror.ships.get(hoveredId);
    if (ship) {
      ex = ship.x;
      ey = ship.y;
      radius = shipRadius(ship.kind);
    } else if (hoveredId.startsWith('swarm-') && mirror.swarm) {
      const swarmId = parseInt(hoveredId.slice('swarm-'.length), 10);
      if (!Number.isNaN(swarmId)) {
        const sw = mirror.swarm.get(swarmId);
        if (sw) {
          // Drones (kind 1) + structures (kind 2) render from `entry.x/y`
          // directly (one-pose-per-frame); only asteroids use interpolation.
          if (sw.kind === 1 || sw.kind === 2) {
            ex = sw.x;
            ey = sw.y;
          } else {
            const lerped = interpolateSwarmPose(sw, performance.now(), _poseScratch);
            ex = lerped.x;
            ey = lerped.y;
          }
          radius = sw.radius;
        }
      }
    } else if (mirror.lingeringShips?.has(hoveredId)) {
      const l = mirror.lingeringShips.get(hoveredId)!;
      ex = l.x;
      ey = l.y;
      radius = shipRadius(l.kind);
    }

    if (ex === undefined || ey === undefined) {
      this.gfx.visible = false;
      return false;
    }

    const half = Math.max(MIN_HALF, radius + RADIUS_PAD);
    // Position every frame (cheap transform). pixiY = -gameY (world container).
    this.gfx.x = ex;
    this.gfx.y = -ey;
    this.gfx.visible = true;

    if (half !== this.drawnHalf) {
      this.redraw(half);
      this.drawnHalf = half;
    }
    return true;
  }

  /** Draw the 4 corner brackets in LOCAL coords (origin at entity centre). */
  private redraw(half: number): void {
    const g = this.gfx;
    const arm = half * CORNER_FRAC;
    g.clear();
    g.moveTo(-half, -half + arm).lineTo(-half, -half).lineTo(-half + arm, -half);
    g.moveTo(half - arm, -half).lineTo(half, -half).lineTo(half, -half + arm);
    g.moveTo(half, half - arm).lineTo(half, half).lineTo(half - arm, half);
    g.moveTo(-half + arm, half).lineTo(-half, half).lineTo(-half, half - arm);
    g.stroke({ width: HOVER_THICKNESS, color: HOVER_COLOR, alpha: 0.55 });
  }

  destroy(): void {
    this.gfx.destroy();
  }
}

function shipRadius(kind: string | undefined): number {
  const k = getShipKind(kind);
  return k?.radius ?? SHIP_FALLBACK_RADIUS;
}
