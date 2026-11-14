import { Container, Graphics } from 'pixi.js';
import type { FleetOverlayShip, RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import type { BoxRect, HoldArmed } from './input/commandPointerRouter.js';

/**
 * Command-view fleet overlay (RTS stream slice 13a).
 *
 * ONE screen-space `Graphics` (one draw call, draw-call budget) cleared and
 * redrawn each frame with:
 *  - a ring around every selected own ship,
 *  - the drag-selection box (screen px),
 *  - a short-lived flash at the latest order point,
 *  - an expanding ring at a touch held long enough to draw a box (slice 12),
 *  - order lines for SELECTED ships (slice 15a): to the move destination, to
 *    the attack target's current pose, to the escorted ship, and the patrol
 *    route loop; capped at {@link MAX_ORDER_SEGMENTS} per frame.
 * Nothing is created per ship. Hidden when there is nothing to draw.
 *
 * Positions are resolved from the mirror (game space, y up) and projected to
 * screen through the injected `project` (pixi-world in, so y is negated).
 */
const RING_COLOR = 0x7dff9a;
const BOX_COLOR = 0x7dff9a;
const MOVE_FLASH_COLOR = 0x7dff9a;
const ATTACK_FLASH_COLOR = 0xff5a4a;
const RING_PAD = 6;
const MIN_RING_PX = 8;
export const ORDER_FLASH_MS = 450;
/** Hold cue: ring grows from HOLD_RING_R0 by HOLD_RING_GROW px over HOLD_RING_MS. */
export const HOLD_RING_MS = 300;
const HOLD_RING_R0 = 18;
const HOLD_RING_GROW = 14;
const HOLD_COLOR = 0x7dff9a;
const SHIP_FALLBACK_RADIUS = 20;
const ORDER_LINE_COLOR = 0x7dff9a;
const ATTACK_LINE_COLOR = 0xff5a4a;
const DEST_DOT_PX = 3;
/** Draw-cost guard: order segments (lines + dest dots) per frame. */
export const MAX_ORDER_SEGMENTS = 256;

/**
 * Game-space pose of an entity by pick id (playerId / shipInstanceId /
 * `swarm-<n>`) into `out`; false when unknown. Alloc-free (the swarm id is
 * parsed by hand, no substring).
 */
export function resolveEntityPos(mirror: RenderMirror, id: string, out: { x: number; y: number }): boolean {
  const ship = mirror.ships.get(id);
  if (ship !== undefined) { out.x = ship.x; out.y = ship.y; return true; }
  const l = mirror.lingeringShips?.get(id);
  if (l !== undefined) { out.x = l.x; out.y = l.y; return true; }
  if (mirror.swarm !== undefined && id.length > 6 && id.startsWith('swarm-')) {
    let n = 0;
    for (let i = 6; i < id.length; i++) {
      const c = id.charCodeAt(i) - 48;
      if (c < 0 || c > 9) return false;
      n = n * 10 + c;
    }
    const sw = mirror.swarm.get(n);
    if (sw !== undefined) { out.x = sw.x; out.y = sw.y; return true; }
  }
  return false;
}

export interface OrderFlash {
  /** Game space. */
  x: number;
  y: number;
  attack: boolean;
  /** Real-time ms when the order was given; -1 = none. */
  t0: number;
}

export type ProjectFn = (pixiWorldX: number, pixiWorldY: number, out: { x: number; y: number }) => void;

export class FleetOverlay {
  private readonly gfx: Graphics;
  private readonly _scratch = { x: 0, y: 0 };
  private readonly _from = { x: 0, y: 0 };
  private readonly _game = { x: 0, y: 0 };
  private _segments = 0;
  /** Rings drawn in the last update (test/diag hook). */
  lastRingCount = 0;
  /** The hold-to-box cue was drawn in the last update (test/diag hook). */
  lastHoldCue = false;
  /** Order segments drawn in the last update (test/diag hook). */
  lastOrderSegments = 0;

  constructor(parent: Container) {
    this.gfx = new Graphics();
    this.gfx.visible = false;
    parent.addChild(this.gfx);
  }

  update(
    mirror: RenderMirror,
    selected: ReadonlySet<string>,
    box: BoxRect | null,
    flash: OrderFlash,
    nowMs: number,
    project: ProjectFn,
    zoom: number,
    /** Touch held past the box threshold (screen px), or null. */
    hold: HoldArmed | null = null,
    /** Own ships' squads + orders by id (slice 15a), or null. */
    orders: ReadonlyMap<string, FleetOverlayShip> | null = null,
  ): void {
    const g = this.gfx;
    const flashAge = flash.t0 < 0 ? Infinity : nowMs - flash.t0;
    const flashLive = flashAge >= 0 && flashAge < ORDER_FLASH_MS;
    this.lastHoldCue = hold !== null;
    if (selected.size === 0 && box === null && !flashLive && hold === null) {
      if (g.visible) {
        g.clear();
        g.visible = false;
      }
      this.lastRingCount = 0;
      this.lastOrderSegments = 0;
      return;
    }
    g.clear();
    g.visible = true;
    const s = this._scratch;
    let rings = 0;
    for (const id of selected) {
      let x: number;
      let y: number;
      let kind: string | undefined;
      const ship = mirror.ships.get(id);
      if (ship !== undefined) {
        x = ship.x; y = ship.y; kind = ship.kind;
      } else {
        const l = mirror.lingeringShips?.get(id);
        if (l === undefined) continue;
        x = l.x; y = l.y; kind = l.kind;
      }
      project(x, -y, s);
      const r = Math.max(MIN_RING_PX, ((getShipKind(kind)?.radius ?? SHIP_FALLBACK_RADIUS) + RING_PAD) * zoom);
      g.circle(s.x, s.y, r);
      rings++;
    }
    if (rings > 0) g.stroke({ width: 1.5, color: RING_COLOR, alpha: 0.9 });
    this.lastRingCount = rings;

    this._segments = 0;
    if (orders !== null && orders.size > 0 && selected.size > 0) {
      // Two passes, one stroke each: friendly lines, then attack lines.
      this.drawOrders(g, mirror, selected, orders, project, false);
      this.drawOrders(g, mirror, selected, orders, project, true);
    }
    this.lastOrderSegments = this._segments;

    if (box !== null) {
      const x = Math.min(box.x0, box.x1);
      const y = Math.min(box.y0, box.y1);
      const w = Math.abs(box.x1 - box.x0);
      const h = Math.abs(box.y1 - box.y0);
      g.rect(x, y, w, h);
      g.fill({ color: BOX_COLOR, alpha: 0.08 });
      g.rect(x, y, w, h);
      g.stroke({ width: 1, color: BOX_COLOR, alpha: 0.85 });
    }

    if (flashLive) {
      const t = flashAge / ORDER_FLASH_MS;
      project(flash.x, -flash.y, s);
      g.circle(s.x, s.y, 4 + 14 * t);
      g.stroke({ width: 2, color: flash.attack ? ATTACK_FLASH_COLOR : MOVE_FLASH_COLOR, alpha: 1 - t });
    }

    if (hold !== null) {
      const t = Math.min(1, hold.armedMs / HOLD_RING_MS);
      g.circle(hold.x, hold.y, HOLD_RING_R0 + HOLD_RING_GROW * t);
      g.stroke({ width: 2, color: HOLD_COLOR, alpha: 0.9 - 0.4 * t });
    }
  }

  private drawOrders(
    g: Graphics,
    mirror: RenderMirror,
    selected: ReadonlySet<string>,
    orders: ReadonlyMap<string, FleetOverlayShip>,
    project: ProjectFn,
    attack: boolean,
  ): void {
    const from = this._from;
    const to = this._scratch;
    const pos = this._game;
    const start = this._segments;
    for (const id of selected) {
      if (this._segments >= MAX_ORDER_SEGMENTS) break;
      const o = orders.get(id);
      if (o === undefined) continue;
      if (!resolveEntityPos(mirror, id, pos)) continue;
      project(pos.x, -pos.y, from);
      if (attack) {
        if (o.targetId === undefined || !resolveEntityPos(mirror, o.targetId, pos)) continue;
        project(pos.x, -pos.y, to);
        g.moveTo(from.x, from.y).lineTo(to.x, to.y);
        this._segments++;
        continue;
      }
      if (o.destX !== undefined && o.destY !== undefined) {
        project(o.destX, -o.destY, to);
        g.moveTo(from.x, from.y).lineTo(to.x, to.y);
        g.circle(to.x, to.y, DEST_DOT_PX);
        this._segments += 2;
      }
      if (o.escortId !== undefined && this._segments < MAX_ORDER_SEGMENTS && resolveEntityPos(mirror, o.escortId, pos)) {
        project(pos.x, -pos.y, to);
        g.moveTo(from.x, from.y).lineTo(to.x, to.y);
        this._segments++;
      }
      const route = o.route;
      if (route !== undefined && route.length > 1) {
        // Closed loop: last waypoint back to the first.
        const last = route[route.length - 1]!;
        project(last[0], -last[1], to);
        g.moveTo(to.x, to.y);
        for (let i = 0; i < route.length && this._segments < MAX_ORDER_SEGMENTS; i++) {
          const p = route[i]!;
          project(p[0], -p[1], to);
          g.lineTo(to.x, to.y);
          this._segments++;
        }
      }
    }
    if (this._segments > start) {
      g.stroke({ width: 1, color: attack ? ATTACK_LINE_COLOR : ORDER_LINE_COLOR, alpha: 0.55 });
    }
  }

  destroy(): void {
    this.gfx.destroy();
  }
}
