import type { Container } from 'pixi.js';

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
 *   - `drag` — single-pointer pan with momentum decay after release.
 *   - `pinch` — two-finger zoom around the pinch midpoint.
 *   - `wheel` — zoom around the pointer position with smooth ramp.
 *   - `clampZoom` — `minScale` / `maxScale` bounds.
 *   - `decelerate` — exponential velocity decay each tick.
 *   - `clicked` — tap-vs-drag detection via distance + duration
 *     thresholds. The caller receives the world-space position at the
 *     end of a confirmed tap and hit-tests against its own geometry.
 *   - `moveCenter` — position the camera so a given world point sits at
 *     screen-centre.
 *   - `follow` — per-tick lerp toward a moving target (gameplay camera
 *     tracking the local ship).
 *   - `screenToWorld` — coord conversion for hit-testing.
 *
 * NOT included (intentionally) — pixi-viewport features we don't use:
 * `mouseEdges`, `bounce`, `snap`, `snapZoom`, `animate`, `world*` sizing
 * helpers. Add if a future surface needs them.
 *
 * No DOM access. No postMessage. Pure state machine driven by forwarded
 * pointer/wheel events. Migrating from `pixi-viewport` to this should
 * be observably indistinguishable for in-use cases on desktop + mobile.
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

/**
 * Camera provides a pixi-viewport-compatible surface (center,
 * worldScreenWidth/Height, screenWidth/Height, scale, getVisibleBounds,
 * toScreen, addChild, parent) so renderer sub-managers can be ported
 * one-to-one — `pixi-viewport`'s `Viewport` is replaced by `Camera`,
 * not abstracted behind an interface. This is the single camera
 * implementation across both main-thread and worker contexts.
 */

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
}

interface ResolvedOpts {
  minScale: number;
  maxScale: number;
  decelFactor: number;
  tapThresholdPx: number;
  tapThresholdMs: number;
  followLerpFactor: number;
  momentumEpsilon: number;
}

const DEFAULTS: ResolvedOpts = {
  minScale: 0.4,
  maxScale: 4,
  decelFactor: 0.9,
  tapThresholdPx: 6,
  tapThresholdMs: 250,
  followLerpFactor: 0.15,
  momentumEpsilon: 0.1,
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

  // Pan state
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private lastX = 0;
  private lastY = 0;
  private vx = 0;
  private vy = 0;
  private panStartStamp = 0;

  // Pinch state
  private pinchInitialDistance = 0;
  private pinchInitialScale = 1;

  // Follow state
  private followTarget: { x: number; y: number } | null = null;

  // Screen size (for follow + moveCenter math)
  private screenW = 0;
  private screenH = 0;

  constructor(
    private readonly target: CameraTarget,
    opts: CameraOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
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
   * Subscribe to a moving target. The camera lerps toward
   * `(screenCentre − target * scale)` each `tick()` until target is
   * cleared (pass `null`). Equivalent to `pixi-viewport`'s `follow()`,
   * but with a simpler per-frame lerp instead of acceleration curves.
   */
  follow(target: { x: number; y: number } | null): void {
    this.followTarget = target;
  }

  // ---------- Pointer / wheel event consumption ----------

  onPointerDown(pointerId: number, screenX: number, screenY: number, stamp: number): void {
    this.pointers.set(pointerId, { x: screenX, y: screenY });

    if (this.pointers.size === 1) {
      this.startPan(screenX, screenY, stamp);
    } else if (this.pointers.size === 2) {
      this.startPinch();
      // Pan is suspended during pinch.
      this.isPanning = false;
    }
  }

  onPointerMove(pointerId: number, screenX: number, screenY: number): void {
    const prev = this.pointers.get(pointerId);
    if (!prev) return;
    prev.x = screenX;
    prev.y = screenY;

    if (this.pointers.size === 2) {
      this.updatePinch();
    } else if (this.isPanning && this.pointers.size === 1) {
      const dx = screenX - this.lastX;
      const dy = screenY - this.lastY;
      this.target.x += dx;
      this.target.y += dy;
      this.vx = dx;
      this.vy = dy;
      this.lastX = screenX;
      this.lastY = screenY;
    }
  }

  onPointerUp(pointerId: number, screenX: number, screenY: number, stamp: number): PointerUpResult {
    const sizeBefore = this.pointers.size;
    this.pointers.delete(pointerId);

    // Was this a single-pointer tap?
    if (sizeBefore === 1 && this.isPanning) {
      const ddx = screenX - this.panStartX;
      const ddy = screenY - this.panStartY;
      const dist = Math.hypot(ddx, ddy);
      const elapsed = stamp - this.panStartStamp;

      this.isPanning = false;

      if (dist < this.opts.tapThresholdPx && elapsed < this.opts.tapThresholdMs) {
        this.vx = 0;
        this.vy = 0;
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
        this.startPan(remaining.x, remaining.y, stamp);
      }
    }

    return { wasTap: false, worldX: 0, worldY: 0 };
  }

  onPointerCancel(pointerId: number): void {
    this.pointers.delete(pointerId);
    if (this.pointers.size === 0) {
      this.isPanning = false;
      this.vx = 0;
      this.vy = 0;
    }
  }

  /**
   * Wheel scroll → zoom. `deltaY > 0` (wheel down) = zoom out;
   * `deltaY < 0` = zoom in. The 0.9 / 1.1 step factor matches
   * pixi-viewport's default `wheel({ smooth: 4 })` roughly.
   *
   * Anchor behaviour: if a follow target is set (gameplay camera
   * tracking the ship), zoom around screen-centre — the ship stays
   * centered and the world scales around it. Otherwise (free camera,
   * e.g. galaxy overview) zoom around the cursor position so the world
   * point under the cursor stays fixed.
   */
  onWheel(deltaY: number, screenX: number, screenY: number): void {
    const factor = deltaY > 0 ? 0.9 : 1.1;
    const newScale = this.clampScale(this.target.scale.x * factor);
    if (this.followTarget) {
      this.zoomAround(this.screenW / 2, this.screenH / 2, newScale);
    } else {
      this.zoomAround(screenX, screenY, newScale);
    }
  }

  // ---------- Per-tick update ----------

  /**
   * Apply momentum + follow. Called by the Pixi ticker each frame.
   * `dtMs` is currently unused — the decel and lerp factors are
   * implicitly per-frame at 60 Hz. Pass dtMs for future adaptive timing.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tick(_dtMs: number = 16.67): void {
    // Momentum coasts only when no pointer is active.
    if (!this.isPanning && this.pointers.size === 0) {
      if (Math.abs(this.vx) > this.opts.momentumEpsilon || Math.abs(this.vy) > this.opts.momentumEpsilon) {
        this.target.x += this.vx;
        this.target.y += this.vy;
        this.vx *= this.opts.decelFactor;
        this.vy *= this.opts.decelFactor;
      } else {
        this.vx = 0;
        this.vy = 0;
      }
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
    return this.isPanning;
  }

  /** Test-only — current velocity (for momentum tests). */
  getVelocity(): { vx: number; vy: number } {
    return { vx: this.vx, vy: this.vy };
  }

  /** Test-only — active pointer count. */
  getPointerCount(): number {
    return this.pointers.size;
  }

  // ---------- Internal ----------

  private startPan(screenX: number, screenY: number, stamp: number): void {
    this.isPanning = true;
    this.panStartX = screenX;
    this.panStartY = screenY;
    this.lastX = screenX;
    this.lastY = screenY;
    this.vx = 0;
    this.vy = 0;
    this.panStartStamp = stamp;
  }

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    this.pinchInitialDistance = Math.hypot(b.x - a.x, b.y - a.y);
    this.pinchInitialScale = this.target.scale.x;
  }

  private updatePinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (this.pinchInitialDistance === 0) return;
    const ratio = dist / this.pinchInitialDistance;
    const newScale = this.clampScale(this.pinchInitialScale * ratio);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    this.zoomAround(midX, midY, newScale);
  }

  private clampScale(s: number): number {
    return Math.max(this.opts.minScale, Math.min(this.opts.maxScale, s));
  }

  private zoomAround(screenX: number, screenY: number, newScale: number): void {
    // Standard "zoom around point" — keep the world point currently
    // under (screenX, screenY) fixed in screen space as we change scale.
    const worldX = (screenX - this.target.x) / this.target.scale.x;
    const worldY = (screenY - this.target.y) / this.target.scale.y;
    this.target.scale.set(newScale);
    this.target.x = screenX - worldX * newScale;
    this.target.y = screenY - worldY * newScale;
  }
}
