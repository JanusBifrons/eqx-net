import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';

/**
 * Experimental HUD (exp/hud-mobile-first) world-space aim feedback. Drawn only
 * when the client publishes `mirror.hudVariant` (any `?ui=a|b|c`); the legacy
 * HUD never sets it, so this renderer stays hidden and costs one branch.
 *
 *  - AUTO   : cyan corner-bracket lock on the drone the turrets auto-picked
 *             (`mirror.localAutoLockId`, `swarm-<entityId>`), while engaging.
 *  - MANUAL : amber dashed aim line from the ship along `localManualAim` to the
 *             weapon's reach, with a small crosshair at its end.
 *  - Variant B: thin shield / hull / energy arcs around the local ship, fading
 *             to ~15 % alpha when everything is full.
 *
 * Game space is Y-up, the Pixi world Y-down: every point is drawn at
 * `(x, -y)`. Poses are read from the RESOLVED mirror entries (drones: the one
 * per-frame interpolated pose — never re-interpolated here). One pooled
 * Graphics per layer, cleared + redrawn per frame; no allocation (#14).
 */
export const AUTO_COLOR = 0x33ddff;
export const MANUAL_COLOR = 0xffb020;
const SHIELD_COLOR = 0x36c8ff;
const ENERGY_COLOR = 0xffc23d;
const LOCK_PAD = 10;
const LOCK_MIN_HALF = 16;
const CORNER_FRAC = 0.35;
const DASH_ON = 14;
const DASH_OFF = 10;
const CROSS_R = 9;
/** Arc ring radius as a multiple of the ship's collision radius. */
const ARC_RING_MUL = 1.9;
const ARC_GAP = 4;

/** Hull colour band — same thresholds as ShieldHullBar (green > 50 > amber > 25 > red). */
export function hullArcColor(frac: number): number {
  if (frac > 0.5) return 0x4cff7a;
  if (frac > 0.25) return 0xffb020;
  return 0xff4040;
}

/** Variant-B arc alpha: dim when every pool is full, bright otherwise. */
export function statusArcAlpha(shield: number, hull: number, energy: number): number {
  return shield >= 0.999 && hull >= 0.999 && energy >= 0.999 ? 0.15 : 0.85;
}

export class AimFeedbackRenderer {
  private readonly lock = new Graphics();
  private readonly aim = new Graphics();
  private readonly arcs = new Graphics();
  /** Test hooks: what was drawn last frame. */
  lastLockId: string | null = null;
  lastAimDrawn = false;
  lastArcsDrawn = false;

  constructor(parent: Container) {
    this.lock.visible = false;
    this.aim.visible = false;
    this.arcs.visible = false;
    parent.addChild(this.arcs);
    parent.addChild(this.aim);
    parent.addChild(this.lock);
  }

  update(mirror: RenderMirror, zoom: number): void {
    const variant = mirror.hudVariant;
    const localId = mirror.localPlayerId;
    const ship = variant && localId ? mirror.ships.get(localId) : undefined;
    if (!variant || !ship) {
      this.lock.visible = false;
      this.aim.visible = false;
      this.arcs.visible = false;
      this.lastLockId = null;
      this.lastAimDrawn = false;
      this.lastArcsDrawn = false;
      return;
    }
    // Keep strokes a steady on-screen width across zoom.
    const px = 1 / Math.max(0.05, zoom);
    this.drawLock(mirror, px);
    this.drawAim(mirror, ship.x, ship.y, px);
    if (variant === 'b') this.drawArcs(mirror, ship.x, ship.y, getShipKind(ship.kind ?? null).radius ?? 20, px);
    else { this.arcs.visible = false; this.lastArcsDrawn = false; }
  }

  private drawLock(mirror: RenderMirror, px: number): void {
    const id = mirror.localAutoLockId ?? null;
    const g = this.lock;
    if (!id || !id.startsWith('swarm-') || !mirror.swarm) {
      g.visible = false;
      this.lastLockId = null;
      return;
    }
    const entityId = Number(id.slice(6));
    const sw = mirror.swarm.get(entityId);
    if (!sw) {
      g.visible = false;
      this.lastLockId = null;
      return;
    }
    const half = Math.max(LOCK_MIN_HALF, (sw.radius ?? 16) + LOCK_PAD);
    const arm = half * CORNER_FRAC;
    const x = sw.x, y = -sw.y;
    g.clear();
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1;
      const sy = i & 2 ? 1 : -1;
      const cx = x + sx * half, cy = y + sy * half;
      g.moveTo(cx - sx * arm, cy).lineTo(cx, cy).lineTo(cx, cy - sy * arm);
    }
    g.stroke({ width: 2 * px, color: AUTO_COLOR, alpha: 0.95 });
    g.visible = true;
    this.lastLockId = id;
  }

  private drawAim(mirror: RenderMirror, sx: number, sy: number, px: number): void {
    const b = mirror.localManualAim;
    const g = this.aim;
    if (b === undefined || Number.isNaN(b)) {
      g.visible = false;
      this.lastAimDrawn = false;
      return;
    }
    const reach = mirror.localAimReach ?? 250;
    // Ship-angle convention: forward = (-sin b, cos b) in game space.
    const dx = -Math.sin(b), dy = Math.cos(b);
    g.clear();
    const on = DASH_ON * px, off = DASH_OFF * px;
    for (let d = 0; d < reach; d += on + off) {
      const e = Math.min(reach, d + on);
      g.moveTo(sx + dx * d, -(sy + dy * d)).lineTo(sx + dx * e, -(sy + dy * e));
    }
    const ex = sx + dx * reach, ey = -(sy + dy * reach);
    const r = CROSS_R * px;
    g.moveTo(ex - r, ey).lineTo(ex + r, ey).moveTo(ex, ey - r).lineTo(ex, ey + r);
    g.stroke({ width: 1.5 * px, color: MANUAL_COLOR, alpha: 0.85 });
    g.circle(ex, ey, r * 0.7).stroke({ width: 1.5 * px, color: MANUAL_COLOR, alpha: 0.85 });
    g.visible = true;
    this.lastAimDrawn = true;
  }

  private drawArcs(mirror: RenderMirror, sx: number, sy: number, radius: number, px: number): void {
    const st = mirror.localStatus;
    const g = this.arcs;
    if (!st) {
      g.visible = false;
      this.lastArcsDrawn = false;
      return;
    }
    const r = radius * ARC_RING_MUL;
    const x = sx, y = -sy;
    const alpha = statusArcAlpha(st.shield, st.hull, st.energy);
    g.clear();
    // Three 110° arcs on the left, right and bottom of the ship (screen
    // space — the ring doesn't rotate with the hull), each a dim track plus a
    // bright fill proportional to its pool.
    this.arc(g, x, y, r, Math.PI * (215 / 180), st.shield, SHIELD_COLOR, alpha, px);
    this.arc(g, x, y, r, Math.PI * (-35 / 180), st.hull, hullArcColor(st.hull), alpha, px);
    this.arc(g, x, y, r + ARC_GAP * px * 3, Math.PI * (35 / 180) + Math.PI / 2, st.energy, ENERGY_COLOR, alpha, px);
    g.visible = true;
    this.lastArcsDrawn = true;
  }

  /** One gauge arc centred on `mid` (radians, Pixi screen frame), 110° wide. */
  private arc(g: Graphics, x: number, y: number, r: number, mid: number, frac: number, color: number, alpha: number, px: number): void {
    const span = Math.PI * (110 / 180);
    const start = mid - span / 2;
    g.arc(x, y, r, start, start + span).stroke({ width: 2 * px, color, alpha: alpha * 0.25 });
    if (frac > 0.001) {
      g.moveTo(x + Math.cos(start) * r, y + Math.sin(start) * r);
      g.arc(x, y, r, start, start + span * Math.min(1, frac)).stroke({ width: 3 * px, color, alpha });
    }
  }
}
