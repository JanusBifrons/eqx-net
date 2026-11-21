import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { isShipIAmFlying } from './shipOwnership';
import { resolveSelectable, type SelectableTarget } from './SelectionBracket';

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

export class HoverBracket {
  private readonly gfx: Graphics;
  /** Last-drawn half extents — the dirty-flag sentinel. -1 forces a first rebuild. */
  private drawnHw = -1;
  private drawnHh = -1;
  /** Reused pose + half-extents scratch (#14). */
  private readonly _t: SelectableTarget = { x: 0, y: 0, r: 0, hw: 0, hh: 0 };

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
    // The ship I'm flying never gets the hover outline. `pickEntityAt` already
    // skips it, but a hovered id survives the take-controls re-key
    // (shipInstanceId -> playerId, `PixiRenderer.rekeyShip`) and then names the
    // ship I now fly; refusing it here makes the caller clear `_hoveredId`.
    if (hoveredId === null || isShipIAmFlying(mirror, hoveredId)) {
      this.gfx.visible = false;
      return false;
    }

    // Same id → pose + half-extents resolution as the selection bracket (a
    // structure is its quarter-turn footprint box, not its bounding circle).
    const t = this._t;
    if (!resolveSelectable(mirror, hoveredId, t)) {
      this.gfx.visible = false;
      return false;
    }

    const hw = Math.max(MIN_HALF, t.hw + RADIUS_PAD);
    const hh = Math.max(MIN_HALF, t.hh + RADIUS_PAD);
    // Position every frame (cheap transform). pixiY = -gameY (world container).
    this.gfx.x = t.x;
    this.gfx.y = -t.y;
    this.gfx.visible = true;

    if (hw !== this.drawnHw || hh !== this.drawnHh) {
      this.redraw(hw, hh);
      this.drawnHw = hw;
      this.drawnHh = hh;
    }
    return true;
  }

  /** Draw the 4 corner brackets in LOCAL coords (origin at entity centre). */
  private redraw(hw: number, hh: number): void {
    const g = this.gfx;
    const arm = Math.min(hw, hh) * CORNER_FRAC;
    g.clear();
    g.moveTo(-hw, -hh + arm).lineTo(-hw, -hh).lineTo(-hw + arm, -hh);
    g.moveTo(hw - arm, -hh).lineTo(hw, -hh).lineTo(hw, -hh + arm);
    g.moveTo(hw, hh - arm).lineTo(hw, hh).lineTo(hw - arm, hh);
    g.moveTo(-hw + arm, hh).lineTo(-hw, hh).lineTo(-hw, hh - arm);
    g.stroke({ width: HOVER_THICKNESS, color: HOVER_COLOR, alpha: 0.55 });
  }

  destroy(): void {
    this.gfx.destroy();
  }
}
