import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';

/**
 * Click-to-inspect selection bracket (structures follow-up Item B4).
 *
 * Draws a 4-corner bracket around the SINGLE currently-selected entity. Mirrors
 * the `HealthBarManager` discipline (invariant #14):
 *   - ONE pooled `Graphics` for the whole component (single selection → one
 *     bracket), parented to the world container, positioned via its transform
 *     each frame (cheap matrix update).
 *   - Dirty-flag redraw: the corner geometry is rebuilt ONLY when the bracket
 *     SIZE changes (the entity radius). Position is a per-frame transform write,
 *     not a geometry rebuild.
 *   - Module-scope scratch for the interpolated asteroid/drone pose (no
 *     per-frame allocation).
 *
 * Pose resolution mirrors the `HealthBarManager` lookup convention so the id
 * the renderer owns (`_selectedId`) resolves the same live pose every frame:
 *   - ship  → `mirror.ships.get(id)`
 *   - drone / structure → `mirror.swarm.get(Number(id.slice('swarm-'.length)))`
 *   - wreck → `mirror.wrecks.get(id)`
 *
 * `update(mirror, id)` returns `true` when the entity was resolved (bracket
 * drawn), `false` when `id` is null OR the entity is gone — the caller clears
 * its selection on `false` so the panel + server stats channel tear down.
 */
const BRACKET_COLOR = 0x66ddff;
const BRACKET_THICKNESS = 2;
/** Corner arm length as a fraction of the bracket half-size. */
const CORNER_FRAC = 0.32;
/** Pad past the entity radius so the bracket sits just OUTSIDE the silhouette. */
const RADIUS_PAD = 8;
/** Min half-size so a tiny drone still gets a visible bracket. */
const MIN_HALF = 14;
/** Fallback collision radius when a ship/wreck kind can't be resolved. */
const SHIP_FALLBACK_RADIUS = 20;

// Module-scope scratch reused by the asteroid/drone interpolation read. The
// bracket never selects an asteroid (kind 0), but a drone/structure resolved by
// swarm id may need the interpolated pose for the (rare) asteroid path; we keep
// one scratch to stay alloc-free regardless.
const _poseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };

export class SelectionBracket {
  private readonly gfx: Graphics;
  /** Last-drawn half-size — the dirty-flag sentinel. -1 forces a first rebuild. */
  private drawnHalf = -1;

  constructor(parent: Container) {
    this.gfx = new Graphics();
    this.gfx.visible = false;
    parent.addChild(this.gfx);
  }

  /**
   * Position + (lazily) redraw the bracket for the selected entity.
   * Returns true if the entity was resolved this frame.
   */
  update(mirror: RenderMirror, selectedId: string | null): boolean {
    if (selectedId === null) {
      this.gfx.visible = false;
      return false;
    }

    let ex: number | undefined;
    let ey: number | undefined;
    let radius = SHIP_FALLBACK_RADIUS;

    const ship = mirror.ships.get(selectedId);
    if (ship) {
      ex = ship.x;
      ey = ship.y;
      radius = shipRadius(ship.kind);
    } else if (selectedId.startsWith('swarm-') && mirror.swarm) {
      const swarmId = parseInt(selectedId.slice('swarm-'.length), 10);
      if (!Number.isNaN(swarmId)) {
        const sw = mirror.swarm.get(swarmId);
        if (sw) {
          // Drones (kind 1) + structures (kind 2) render from `entry.x/y`
          // directly (one-pose-per-frame rule — already resolved in
          // updateMirror); only asteroids use the interpolation path. Selection
          // never targets asteroids, but mirror HealthBars' branch for safety.
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
    } else if (mirror.wrecks) {
      const wreck = mirror.wrecks.get(selectedId);
      if (wreck) {
        ex = wreck.x;
        ey = wreck.y;
        radius = shipRadius(wreck.kind);
      }
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

    // Rebuild corner geometry only when the size changed (dirty flag).
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
    // Top-left.
    g.moveTo(-half, -half + arm).lineTo(-half, -half).lineTo(-half + arm, -half);
    // Top-right.
    g.moveTo(half - arm, -half).lineTo(half, -half).lineTo(half, -half + arm);
    // Bottom-right.
    g.moveTo(half, half - arm).lineTo(half, half).lineTo(half - arm, half);
    // Bottom-left.
    g.moveTo(-half + arm, half).lineTo(-half, half).lineTo(-half, half - arm);
    g.stroke({ width: BRACKET_THICKNESS, color: BRACKET_COLOR, alpha: 0.95 });
  }

  destroy(): void {
    this.gfx.destroy();
  }
}

function shipRadius(kind: string | undefined): number {
  const k = getShipKind(kind);
  return k?.radius ?? SHIP_FALLBACK_RADIUS;
}
