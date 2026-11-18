/**
 * Helm move marker (owner 2026-11-12): "It says tap and it sets a course, yet
 * no visible indicator of where and what was tapped? A simple RTS style move
 * icon (green) would be very good."
 *
 * Draws a green RTS move icon (a ring, a centre dot and four inward chevrons)
 * at `mirror.helmCourse`, the local pilot's active helm course point. The
 * client only fills that field for the pilot's own capital under an active
 * order (`helm/helmCourseMark.ts`), so this class just draws it.
 *
 * On each new tap (`seq` change) the icon pops: it starts larger and fully
 * bright and eases to its steady size, while a ripple ring expands and fades.
 * Then it holds steady and subtle until the order ends.
 *
 * The route line (navigation slice 14, owner 2026-11-17 "whole route line"):
 * a thin green line from the ship through the autopilot's turns still ahead
 * to the point, a small dot at each turn, traced by the shared `routeLine`
 * (as the fleet patrol pick). Redrawn per frame from the mirror (the ship
 * moves); with no route yet it runs straight to the point.
 *
 * Screen-space container on the stage (like the incoming-fire markers), so it
 * keeps one pixel size at any zoom, which capitals need (they zoom out to
 * ~0.005). Graphics are painted once; per frame only position, scale and
 * alpha move (the line's Graphics is retraced, as `FleetOverlay` does): no new collections (#14). Runs inside `PixiRenderer.update`, so the
 * main-thread and worker render paths both draw it.
 */
import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Camera } from '../worker/Camera';
import { traceRoute, routeDots, type RouteProjectFn } from '../routeLine.js';

export const HELM_MARKER_COLOR = 0x3ddc84;
/** Ring radius, px. */
export const HELM_RING_PX = 9;
/** Chevrons sit between these radii, px. */
const CHEVRON_OUTER_PX = 19;
const CHEVRON_INNER_PX = 13;
const CHEVRON_HALF_W_PX = 4;
/** Ripple ring final radius, px (it grows from ~0.3 of this). */
const RIPPLE_PX = 34;
/** Pop length, ms. */
export const HELM_POP_MS = 320;
const RIPPLE_MS = 480;
/** Pop starting scale. */
const POP_SCALE = 1.7;
/** Steady alpha after the pop. */
export const HELM_STEADY_ALPHA = 0.75;
/** Route line: width and alpha, over a dark under-stroke; turn dot radius, px. */
const LINE_PX = 2;
const LINE_ALPHA = 0.55;
const TURN_DOT_PX = 3;

export interface HelmMarkerLook { scale: number; alpha: number; ripple: number; rippleAlpha: number }

/** The marker's look `ageMs` after the tap (pure, writes `out`). */
export function helmMarkerLook(ageMs: number, out: HelmMarkerLook): HelmMarkerLook {
  const t = ageMs <= 0 ? 0 : ageMs >= HELM_POP_MS ? 1 : ageMs / HELM_POP_MS;
  const ease = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
  out.scale = t >= 1 ? 1 : POP_SCALE + (1 - POP_SCALE) * ease;
  out.alpha = t >= 1 ? HELM_STEADY_ALPHA : 1 + (HELM_STEADY_ALPHA - 1) * ease;
  const r = ageMs <= 0 ? 0 : ageMs >= RIPPLE_MS ? 1 : ageMs / RIPPLE_MS;
  out.ripple = 0.3 + 0.7 * (1 - (1 - r) * (1 - r));
  out.rippleAlpha = r >= 1 ? 0 : 0.9 * (1 - r);
  return out;
}

export class HelmCourseMarker {
  readonly container = new Container();
  private readonly root = new Container();
  private readonly icon = new Graphics();
  private readonly ripple = new Graphics();
  private readonly line = new Graphics();
  private readonly lp = { x: 0, y: 0 };
  private readonly project: RouteProjectFn = (x, y, out) => { this.camera!.toScreenInto(x, y, out); };
  private camera: Camera | null = null;
  private lastSeq = -1;
  private popAtMs = 0;
  private readonly pt = { x: 0, y: 0 };
  private readonly look: HelmMarkerLook = { scale: 1, alpha: 1, ripple: 1, rippleAlpha: 0 };

  constructor() {
    this.container.eventMode = 'none';
    this.root.eventMode = 'none';
    this.root.visible = false;
    paintIcon(this.icon);
    paintRipple(this.ripple);
    // The ripple is a sibling of the root so its scale doesn't stack on the pop.
    this.container.addChild(this.line, this.root, this.ripple);
    this.line.visible = false;
    this.root.addChild(this.icon);
    this.ripple.visible = false;
  }

  /** Attach to the camera's parent (the stage): a screen-space layer. */
  init(camera: Camera): void {
    this.camera = camera;
    const stage = camera.parent;
    if (stage) stage.addChild(this.container);
  }

  update(mirror: RenderMirror, nowMs: number): void {
    const c = mirror.helmCourse;
    const cam = this.camera;
    if (c == null || cam === null || mirror.travelling === true) {
      this.root.visible = false;
      this.ripple.visible = false;
      this.line.visible = false;
      return;
    }
    this.drawLine(mirror, c);
    if (c.seq !== this.lastSeq) {
      this.lastSeq = c.seq;
      this.popAtMs = nowMs;
    }
    cam.toScreenInto(c.x, -c.y, this.pt);
    const look = helmMarkerLook(nowMs - this.popAtMs, this.look);
    const root = this.root;
    root.x = this.pt.x;
    root.y = this.pt.y;
    root.scale.set(look.scale);
    root.alpha = look.alpha;
    root.visible = true;
    const rp = this.ripple;
    if (look.rippleAlpha > 0) {
      rp.x = this.pt.x;
      rp.y = this.pt.y;
      rp.scale.set(look.ripple);
      rp.alpha = look.rippleAlpha;
      rp.visible = true;
    } else {
      rp.visible = false;
    }
  }

  /** The route line: ship → turns still ahead → the point. */
  private drawLine(mirror: RenderMirror, c: NonNullable<RenderMirror['helmCourse']>): void {
    const g = this.line;
    const id = mirror.localPlayerId;
    const ship = id ? mirror.ships.get(id) : undefined;
    g.clear();
    if (ship === undefined) { g.visible = false; return; }
    const n = c.route !== undefined ? c.routeN ?? 0 : 0;
    this.trace(c, n, ship.x, ship.y);
    g.stroke({ color: 0x000000, width: LINE_PX + 2, alpha: LINE_ALPHA * 0.6 });
    this.trace(c, n, ship.x, ship.y);
    g.stroke({ color: HELM_MARKER_COLOR, width: LINE_PX, alpha: LINE_ALPHA });
    if (n > 1) { routeDots(g, c.route!, 0, n - 1, TURN_DOT_PX, this.project, this.lp); g.fill({ color: HELM_MARKER_COLOR, alpha: LINE_ALPHA + 0.2 }); }
    g.visible = true;
  }

  private trace(c: NonNullable<RenderMirror['helmCourse']>, n: number, sx: number, sy: number): void {
    if (n > 0) { traceRoute(this.line, c.route!, 0, n, false, sx, sy, this.project, this.lp); return; }
    const g = this.line;
    this.project(sx, -sy, this.lp); g.moveTo(this.lp.x, this.lp.y);
    this.project(c.x, -c.y, this.lp); g.lineTo(this.lp.x, this.lp.y);
  }

  /** Test / E2E: is the route line drawn this frame. */
  lineVisible(): boolean { return this.line.visible; }

  /** Test / E2E: is the marker drawn this frame. */
  isVisible(): boolean {
    return this.root.visible;
  }

  /** Sector handoff: the course point belongs to the old sector. */
  reset(): void {
    this.root.visible = false;
    this.line.visible = false;
    this.ripple.visible = false;
    this.lastSeq = -1;
  }

  destroy(): void {
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
    this.camera = null;
  }
}

/** Ring + centre dot + four chevrons pointing in at the point. */
function paintIcon(g: Graphics): void {
  g.clear();
  g.circle(0, 0, HELM_RING_PX);
  g.stroke({ color: 0x000000, width: 4, alpha: 0.45 });
  g.circle(0, 0, HELM_RING_PX);
  g.stroke({ color: HELM_MARKER_COLOR, width: 2, alpha: 1 });
  g.circle(0, 0, 2);
  g.fill({ color: HELM_MARKER_COLOR, alpha: 1 });
  // Four chevrons (V shapes) at N/E/S/W, tips pointing at the centre.
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    // Tip on the inner radius; arms back to the outer radius, ±half width.
    const tx = ca * CHEVRON_INNER_PX, ty = sa * CHEVRON_INNER_PX;
    const ox = ca * CHEVRON_OUTER_PX, oy = sa * CHEVRON_OUTER_PX;
    const px = -sa * CHEVRON_HALF_W_PX, py = ca * CHEVRON_HALF_W_PX;
    g.moveTo(ox + px, oy + py).lineTo(tx, ty).lineTo(ox - px, oy - py);
  }
  g.stroke({ color: HELM_MARKER_COLOR, width: 2, alpha: 1 });
}

function paintRipple(g: Graphics): void {
  g.clear();
  g.circle(0, 0, RIPPLE_PX);
  g.stroke({ color: HELM_MARKER_COLOR, width: 2, alpha: 1 });
}
