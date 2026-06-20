import type { Container } from 'pixi.js';
import { DragGesture } from './camera/dragGesture.js';
import { PinchGesture } from './camera/pinchGesture.js';
import { MomentumDecay } from './camera/momentumDecay.js';
import { classifyTap } from './camera/tapVsDrag.js';
import { zoomAround, wheelZoomFactor } from './camera/zoomAround.js';

/**
 * Pure camera math, designed to be a drop-in replacement for the
 * `pixi-viewport` `Viewport` we previously used. The migration was
 * triggered by OffscreenCanvas-worker context: `pixi-viewport`'s
 * `Drag` plugin calls `addEventListener` on `events.domElement` —
 * undefined in worker context. Spike-verified 2026-05-14 (commit
 * `2dd11d3`). Replacing it everywhere — main-thread legacy AND
 * worker — gives us one camera implementation to maintain.
 *
 * Operates on a Pixi-like target with `{ x, y, scale: { x, y, set } }`
 * — typically a `pixi.js` `Container`, but the interface is local so
 * the Camera is unit-testable without a Pixi runtime.
 *
 * Features (feature-parity with the subset of `pixi-viewport` we used):
 *
 *   - `drag` — single-pointer pan with momentum decay after release
 *     (`camera/dragGesture.ts` + `camera/momentumDecay.ts`).
 *   - `pinch` — two-finger zoom around the pinch midpoint
 *     (`camera/pinchGesture.ts`).
 *   - `wheel` — zoom around the pointer position with smooth ramp
 *     (`camera/zoomAround.ts`).
 *   - `clampZoom` — `minScale` / `maxScale` bounds.
 *   - `clicked` — tap-vs-drag detection (`camera/tapVsDrag.ts`).
 *   - `moveCenter` — position the camera so a given world point sits
 *     at screen-centre.
 *   - `follow` — per-tick lerp toward a moving target.
 *   - `screenToWorld` — coord conversion for hit-testing.
 *
 * No DOM access. No postMessage. Pure state machine driven by forwarded
 * pointer/wheel events.
 */

/**
 * Minimal contract the Camera mutates. A `pixi.js` `Container` satisfies
 * this directly; tests pass a plain object with the same shape.
 */
export interface CameraTarget {
  x: number;
  y: number;
  scale: {
    x: number;
    y: number;
    /** Set both x and y to the given value (Pixi `Container.scale.set(s)`). */
    set(s: number): void;
  };
}

export interface CameraOptions {
  /** Minimum scale (zoom-out limit). Default 0.4. */
  minScale?: number;
  /** Maximum scale (zoom-in limit). Default 4. */
  maxScale?: number;
  /**
   * Per-tick momentum decay multiplier. `1` = no decay (infinite
   * coast); `0` = instant stop on release. Default 0.9.
   */
  decelFactor?: number;
  /**
   * Tap pixel-distance threshold. A pointerdown→up that moved less
   * than this counts as a tap (not a pan). Default 6 px.
   */
  tapThresholdPx?: number;
  /**
   * Tap duration threshold (ms). A pointerdown→up that took longer
   * than this is NOT a tap, regardless of distance. Default 250 ms.
   */
  tapThresholdMs?: number;
  /**
   * Per-tick lerp factor toward the follow target. `1` = teleport;
   * `0` = no follow. Default 0.15 — soft camera that doesn't snap.
   */
  followLerpFactor?: number;
  /**
   * Below this velocity magnitude (px/tick), momentum stops entirely.
   * Default 0.1.
   */
  momentumEpsilon?: number;
  /**
   * Exponential time-constant (ms) for the wheel-zoom ease applied in
   * `tick()`. Lower = snappier, higher = floatier. Default 90. Pinch is
   * exempt (direct manipulation stays 1:1); follow is a separate path and
   * is unaffected. This decoupling is what lets the zoom feel smooth
   * without reintroducing the zoom-vs-follow vibration that pinned
   * `followLerpFactor` to 1 in production.
   */
  zoomSmoothTimeMs?: number;
}

interface ResolvedOpts {
  minScale: number;
  maxScale: number;
  decelFactor: number;
  tapThresholdPx: number;
  tapThresholdMs: number;
  followLerpFactor: number;
  momentumEpsilon: number;
  zoomSmoothTimeMs: number;
}

/** Below this absolute scale-delta the zoom ease snaps to target + clears. */
const ZOOM_SNAP_EPSILON = 0.001;

const DEFAULTS: ResolvedOpts = {
  minScale: 0.4,
  maxScale: 4,
  decelFactor: 0.9,
  tapThresholdPx: 6,
  tapThresholdMs: 250,
  followLerpFactor: 0.15,
  momentumEpsilon: 0.1,
  zoomSmoothTimeMs: 90,
};

/** Result of `onPointerUp`. Caller hit-tests `worldX/Y` when `wasTap`. */
export interface PointerUpResult {
  wasTap: boolean;
  worldX: number;
  worldY: number;
}

/** Active-pointer state. Keyed by `pointerId`. */
interface PointerState {
  x: number;
  y: number;
}

export class Camera {
  private readonly opts: ResolvedOpts;
  private readonly pointers = new Map<number, PointerState>();
  /** True once a gesture has had ≥2 simultaneous pointers (a pinch). Latches for
   *  the WHOLE gesture and only clears when the last finger lifts, so the final
   *  single-finger release of a pinch can never register as a tap/select. Without
   *  it, lifting one pinch finger resumes a single-pointer drag from the remaining
   *  finger with a fresh stamp, and a quick release then classifies as a tap →
   *  the mobile "pinch-to-zoom selects a sector" bug (Equinox Tweaks Phase 2 #1). */
  private hadMultiTouch = false;
  private readonly drag = new DragGesture();
  private readonly pinch = new PinchGesture();
  private readonly momentum: MomentumDecay;

  // Follow state
  private followTarget: { x: number; y: number } | null = null;

  // One-shot glide state (Phase 4 WS-A2 smooth ship-switch). When active, the
  // camera centre eases from `glideFromX/Y` to `glideToX/Y` over `glideDurMs`,
  // OVERRIDING the follow target each tick so a high-`followLerpFactor` follow
  // (production gameplay = 1, i.e. instant snap) cannot yank the view to the new
  // ship mid-transition. It is driven by `glideElapsedMs` (NOT pose
  // interpolation), so it never trips the snapshot teleport guard (Risk #4).
  private gliding = false;
  private glideFromX = 0;
  private glideFromY = 0;
  private glideToX = 0;
  private glideToY = 0;
  private glideDurMs = 1;
  private glideElapsedMs = 0;

  // Screen size (for follow + moveCenter math)
  private screenW = 0;
  private screenH = 0;

  // Smoothed zoom — onWheel sets targetScale + the anchor; tick() eases
  // the live scale toward it via zoomAround. Decoupled from follow, so it
  // cannot reintroduce the zoom-vs-follow vibration (followLerpFactor:1).
  private targetScale = 1;
  private zoomAnchorX = 0;
  private zoomAnchorY = 0;
  private hasZoomTarget = false;

  constructor(
    private readonly target: CameraTarget,
    opts: CameraOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.momentum = new MomentumDecay({
      decelFactor: this.opts.decelFactor,
      epsilon: this.opts.momentumEpsilon,
    });
    this.targetScale = this.target.scale.x;
  }

  // ---------- Screen size ----------

  setScreenSize(width: number, height: number): void {
    this.screenW = width;
    this.screenH = height;
  }

  // ---------- Camera positioning ----------

  /**
   * Position the camera so world coord `(worldX, worldY)` sits at the
   * screen centre. Equivalent to `pixi-viewport`'s `moveCenter(x, y)`.
   */
  moveCenter(worldX: number, worldY: number): void {
    this.target.x = this.screenW / 2 - worldX * this.target.scale.x;
    this.target.y = this.screenH / 2 - worldY * this.target.scale.y;
  }

  /**
   * Set the zoom level immediately (no ease), keeping the world point at
   * screen-centre fixed. For the bootstrap default-gameplay-zoom and any
   * programmatic caller. Clamped to [minScale, maxScale].
   */
  setZoom(scale: number): void {
    const s = this.clampScale(scale);
    zoomAround(this.target, this.screenW / 2, this.screenH / 2, s);
    this.targetScale = s;
    this.hasZoomTarget = false;
  }

  /**
   * Subscribe to a moving target. The camera lerps toward
   * `(screenCentre − target * scale)` each `tick()` until target is
   * cleared (pass `null`). Equivalent to `pixi-viewport`'s `follow()`,
   * but with a simpler per-frame lerp instead of acceleration curves.
   */
  follow(target: { x: number; y: number } | null): void {
    this.followTarget = target;
  }

  /**
   * Phase 4 WS-A2 — kick off a ONE-SHOT eased camera glide from the current
   * screen-centre world point to `(worldX, worldY)` over `durationMs`. Used by
   * the smooth ship-switch: the camera lerps from the old view to the new ship
   * instead of snapping. While gliding, `tick()` ignores the follow target (so a
   * `followLerpFactor: 1` follow can't snap mid-glide) and drives the centre by
   * the eased fraction. It is driven by elapsed wall-clock ms — INDEPENDENT of
   * pose interpolation — so it never trips the snapshot teleport guard. Caller
   * passes the destination in the camera's own (pixi-down) world space.
   */
  glideTo(worldX: number, worldY: number, durationMs: number): void {
    const c = this.center;
    this.glideFromX = c.x;
    this.glideFromY = c.y;
    this.glideToX = worldX;
    this.glideToY = worldY;
    this.glideDurMs = Math.max(1, durationMs);
    this.glideElapsedMs = 0;
    this.gliding = true;
  }

  /** True while a one-shot glide is in progress. */
  isGliding(): boolean {
    return this.gliding;
  }

  /** Abort an in-flight glide and hand the camera back to follow/pan. */
  cancelGlide(): void {
    this.gliding = false;
  }

  // ---------- Pointer / wheel event consumption ----------

  onPointerDown(pointerId: number, screenX: number, screenY: number, stamp: number): void {
    this.pointers.set(pointerId, { x: screenX, y: screenY });

    if (this.pointers.size === 1) {
      this.drag.begin(screenX, screenY, stamp);
      this.momentum.clear();
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      if (a && b) this.pinch.begin(a, b, this.target.scale.x);
      // Pan is suspended during pinch.
      this.drag.suspend();
      // Latch the gesture as multi-touch so no release in it counts as a tap.
      this.hadMultiTouch = true;
    }
  }

  onPointerMove(pointerId: number, screenX: number, screenY: number): void {
    const prev = this.pointers.get(pointerId);
    if (!prev) return;
    prev.x = screenX;
    prev.y = screenY;

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const step = this.pinch.step(a, b);
      if (step) {
        const newScale = this.clampScale(this.pinch.startScale() * step.ratio);
        zoomAround(this.target, step.midX, step.midY, newScale);
        // Pinch is direct (no ease). Keep targetScale synced + cancel any
        // in-flight wheel ease so the two don't fight.
        this.targetScale = newScale;
        this.hasZoomTarget = false;
      }
    } else if (this.drag.isPanning() && this.pointers.size === 1) {
      const { dx, dy } = this.drag.step(screenX, screenY);
      this.target.x += dx;
      this.target.y += dy;
      this.momentum.seed(dx, dy);
    }
  }

  onPointerUp(pointerId: number, screenX: number, screenY: number, stamp: number): PointerUpResult {
    const sizeBefore = this.pointers.size;
    this.pointers.delete(pointerId);
    // Snapshot the multi-touch latch for this release, then clear it once the
    // gesture is fully over (last finger up) so the NEXT clean single tap works.
    const wasMultiTouch = this.hadMultiTouch;
    if (this.pointers.size === 0) this.hadMultiTouch = false;

    // Was this a single-pointer tap?
    if (sizeBefore === 1 && this.drag.isPanning()) {
      const start = this.drag.startState();
      const cls = classifyTap(
        start.x,
        start.y,
        screenX,
        screenY,
        start.stamp,
        stamp,
        { tapThresholdPx: this.opts.tapThresholdPx, tapThresholdMs: this.opts.tapThresholdMs },
      );
      this.drag.end();

      // A tap only counts if the WHOLE gesture stayed single-touch — a pinch's
      // final release must never select (Phase 2 #1).
      if (cls.isTap && !wasMultiTouch) {
        this.momentum.clear();
        const { x: worldX, y: worldY } = this.screenToWorld(screenX, screenY);
        return { wasTap: true, worldX, worldY };
      }
      return { wasTap: false, worldX: 0, worldY: 0 };
    }

    // Two→one transition: resume single-pointer pan from the remaining
    // pointer's current position. Without this, releasing one of two
    // pinch fingers would leave the camera with stale pan state and
    // the next move would `jump`.
    if (sizeBefore === 2 && this.pointers.size === 1) {
      const [remaining] = [...this.pointers.values()];
      if (remaining) {
        this.drag.begin(remaining.x, remaining.y, stamp);
        this.momentum.clear();
      }
    }

    return { wasTap: false, worldX: 0, worldY: 0 };
  }

  onPointerCancel(pointerId: number): void {
    this.pointers.delete(pointerId);
    if (this.pointers.size === 0) {
      this.drag.end();
      this.momentum.clear();
      this.hadMultiTouch = false;
    }
  }

  /**
   * Wheel scroll → zoom. `deltaY > 0` (wheel down) = zoom out;
   * `deltaY < 0` = zoom in.
   *
   * Anchor behaviour: if a follow target is set (gameplay camera
   * tracking the ship), zoom around screen-centre — the ship stays
   * centered and the world scales around it. Otherwise (free camera,
   * e.g. galaxy overview) zoom around the cursor position so the world
   * point under the cursor stays fixed.
   */
  onWheel(deltaY: number, screenX: number, screenY: number): void {
    // Set a target scale + anchor; the zoom itself eases in tick() so the
    // wheel feels smooth instead of stepping. Accumulate off targetScale
    // (not the live scale) so rapid wheel ticks compound mid-ease.
    this.targetScale = this.clampScale(this.targetScale * wheelZoomFactor(deltaY));
    if (this.followTarget) {
      // Following: zoom around screen-centre (the ship stays centred).
      this.zoomAnchorX = this.screenW / 2;
      this.zoomAnchorY = this.screenH / 2;
    } else {
      // Free camera: keep the world point under the cursor fixed.
      this.zoomAnchorX = screenX;
      this.zoomAnchorY = screenY;
    }
    this.hasZoomTarget = true;
  }

  // ---------- Per-tick update ----------

  /**
   * Apply zoom-ease + momentum + follow. Called by the Pixi ticker each
   * frame. `dtMs` drives the framerate-independent zoom ease; momentum +
   * follow remain per-frame factors (unchanged behaviour).
   */
  tick(dtMs: number = 16.67): void {
    // Zoom ease toward targetScale (framerate-independent via dtMs). Runs
    // first so the follow/momentum below use this frame's scale. zoomAround
    // keeps the stored anchor's world point fixed as the scale changes.
    if (this.hasZoomTarget) {
      const current = this.target.scale.x;
      const k = 1 - Math.exp(-dtMs / this.opts.zoomSmoothTimeMs);
      let next = current + (this.targetScale - current) * k;
      if (Math.abs(this.targetScale - next) < ZOOM_SNAP_EPSILON) {
        next = this.targetScale;
        this.hasZoomTarget = false;
      }
      zoomAround(this.target, this.zoomAnchorX, this.zoomAnchorY, next);
    }

    // Momentum coasts only when no pointer is active.
    if (!this.drag.isPanning() && this.pointers.size === 0) {
      this.momentum.step(this.target);
    }

    // One-shot glide (WS-A2) — OVERRIDES follow while active. Eased (ease-out
    // cubic) fraction from the captured start point to the destination, driven
    // by elapsed ms (framerate-independent). On completion it snaps exactly to
    // the destination and clears, handing the camera back to follow.
    if (this.gliding && this.screenW > 0 && this.screenH > 0) {
      this.glideElapsedMs += dtMs;
      const t = Math.min(1, this.glideElapsedMs / this.glideDurMs);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const cx = this.glideFromX + (this.glideToX - this.glideFromX) * e;
      const cy = this.glideFromY + (this.glideToY - this.glideFromY) * e;
      this.target.x = this.screenW / 2 - cx * this.target.scale.x;
      this.target.y = this.screenH / 2 - cy * this.target.scale.y;
      if (t >= 1) this.gliding = false;
      return;
    }

    // Follow — lerp toward target, regardless of momentum state.
    if (this.followTarget && this.screenW > 0 && this.screenH > 0) {
      const targetX = this.screenW / 2 - this.followTarget.x * this.target.scale.x;
      const targetY = this.screenH / 2 - this.followTarget.y * this.target.scale.y;
      this.target.x += (targetX - this.target.x) * this.opts.followLerpFactor;
      this.target.y += (targetY - this.target.y) * this.opts.followLerpFactor;
    }
  }

  // ---------- Coord conversion ----------

  /** Screen-space → world-space using the current pan + scale. */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.target.x) / this.target.scale.x,
      y: (screenY - this.target.y) / this.target.scale.y,
    };
  }

  // ---------- IWorldView surface (viewport-API parity) ----------
  //
  // Sub-managers (HaloRadar, BackgroundGrid, StarfieldBackground) read
  // these properties to compute screen-relative positions, visible
  // bounds, and parallax offsets. The Camera derives them all from the
  // target Container's transform + the screen size.

  /** World coord currently at screen-centre. */
  get center(): { x: number; y: number } {
    return this.screenToWorld(this.screenW / 2, this.screenH / 2);
  }

  /** Visible-world width in world units. */
  get worldScreenWidth(): number {
    return this.target.scale.x > 0 ? this.screenW / this.target.scale.x : this.screenW;
  }

  /** Visible-world height in world units. */
  get worldScreenHeight(): number {
    return this.target.scale.y > 0 ? this.screenH / this.target.scale.y : this.screenH;
  }

  get screenWidth(): number {
    return this.screenW;
  }

  get screenHeight(): number {
    return this.screenH;
  }

  /**
   * Read-only proxy of the target's scale. The Camera mutates the
   * target's scale internally (zoom); external readers see the live
   * value here.
   */
  get scale(): { readonly x: number; readonly y: number } {
    return this.target.scale;
  }

  getVisibleBounds(): { x: number; y: number; width: number; height: number } {
    const halfW = this.worldScreenWidth * 0.5;
    const halfH = this.worldScreenHeight * 0.5;
    const c = this.center;
    return {
      x: c.x - halfW,
      y: c.y - halfH,
      width: this.worldScreenWidth,
      height: this.worldScreenHeight,
    };
  }

  toScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: this.target.x + worldX * this.target.scale.x,
      y: this.target.y + worldY * this.target.scale.y,
    };
  }

  /** Allocation-free `toScreen` — writes into `out` (WS-9 R2.30: the selection
   *  projection runs EVERY FRAME while something is selected, so the allocating
   *  `toScreen` would violate invariant #14). */
  toScreenInto(worldX: number, worldY: number, out: { x: number; y: number }): void {
    out.x = this.target.x + worldX * this.target.scale.x;
    out.y = this.target.y + worldY * this.target.scale.y;
  }

  /**
   * Pixi parent of the camera's world container — typically `app.stage`.
   * `HaloRadar` etc. attach screen-space children here so they sit
   * above the world without inheriting the camera's pan/zoom transform.
   */
  get parent(): Container | null {
    return (this.target as unknown as { parent: Container | null }).parent;
  }

  /**
   * Add a child into the camera's world container (world-space). Sub-
   * managers that draw in world coords (`BackgroundGrid`,
   * `DamageNumberManager`, `HealthBarManager`, `LabelManager`,
   * `MountVisualManager`) use this exactly as they would `viewport.addChild`.
   */
  addChild<T extends Container>(child: T): T {
    return (this.target as unknown as { addChild<U extends Container>(c: U): U }).addChild(child);
  }

  // ---------- Test / debug accessors ----------

  /** Test-only — current panning state. */
  isPanningNow(): boolean {
    return this.drag.isPanning();
  }

  /** Test-only — current velocity (for momentum tests). */
  getVelocity(): { vx: number; vy: number } {
    return this.momentum.velocity();
  }

  /** Test-only — active pointer count. */
  getPointerCount(): number {
    return this.pointers.size;
  }

  // ---------- Internal ----------

  private clampScale(s: number): number {
    return Math.max(this.opts.minScale, Math.min(this.opts.maxScale, s));
  }
}
