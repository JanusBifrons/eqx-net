/**
 * CameraDirector — the cinematic layer above the world `Camera`.
 *
 * Pure (no Pixi, no DOM): given a cue list (`CameraCue[]`, plain data from
 * `@core/contracts/cameraScript`) and a `CameraTargetLookup` that reports the
 * RENDERED sprite poses, `update()` resolves where the camera should be this
 * frame (pixi space, Y-down) plus how quickly to get there. The `Camera` owns
 * the actual smoothing (`setDirectorTarget` → critically-damped spring inside
 * `Camera.tick`), so motion stays 60 Hz even when `update()` runs at the 30 Hz
 * worker render cadence.
 *
 * Ownership rules (see docs/architecture/cinematic-camera.md):
 *  - While a script plays, the director is the ONLY camera driver. The renderer
 *    stops re-issuing the local-ship follow; `Camera.tick` gives the director
 *    precedence over glide, follow and pan.
 *  - Targets are read from rendered sprite positions (the same source the
 *    gameplay follow uses), never raw mirror poses — so the camera tracks what
 *    is drawn (one-pose-per-frame, invariant #12).
 *  - `update()` allocates nothing (invariant #14): all state is class fields and
 *    caller-owned out-objects.
 */
import {
  DEFAULT_CUE_SMOOTH_MS,
  type CameraCue,
  type CameraGroup,
  type CameraKey,
  type CameraShot,
} from '@core/contracts/cameraScript.js';

export interface MutablePoint {
  x: number;
  y: number;
}

export interface MutableBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Implemented by the renderer over its sprite map. All coordinates pixi space. */
export interface CameraTargetLookup {
  /** Rendered position of an entity (`'local'` = the local ship). False if not drawn. */
  pose(id: string, out: MutablePoint): boolean;
  /** Bounds of a named group; returns the member count (0 ⇒ `out` untouched). */
  groupBounds(group: CameraGroup, out: MutableBounds): number;
  /** Bounds of explicit ids; returns how many were found. */
  idsBounds(ids: readonly string[], out: MutableBounds): number;
  /** Current viewport size in screen px. */
  viewport(out: MutablePoint): void;
}

/** Resolved camera target for this frame (pixi space). */
export interface DirectorTarget {
  x: number;
  y: number;
  zoom: number;
  smoothMs: number;
}

export type DirectorStatus = 'idle' | 'active' | 'released';

/** Smallest box a `frame` shot fits, so a single entity doesn't zoom to max. */
export const FRAME_MIN_EXTENT = 400;
const DEFAULT_FRAME_PADDING = 0.25;
const DEFAULT_FRAME_MIN_ZOOM = 0.15;
const DEFAULT_FRAME_MAX_ZOOM = 3;
/** EMA weight for the tracked entity's velocity estimate (per update). */
const LEAD_VELOCITY_ALPHA = 0.25;

export class CameraDirector {
  private cues: readonly CameraCue[] = [];
  private startMs = 0;
  private playing = false;
  private cueIndex = -1;
  private cueStartMs = 0;

  // Last resolved target — held when the current shot's subject is missing.
  private hasLast = false;
  private lastX = 0;
  private lastY = 0;
  private lastZoom = 1;

  // `track` lead: velocity estimate of the tracked entity (pixi units / ms).
  private trackId: string | null = null;
  private trackPrevX = 0;
  private trackPrevY = 0;
  private trackPrevMs = 0;
  private trackVx = 0;
  private trackVy = 0;

  private readonly _pt: MutablePoint = { x: 0, y: 0 };
  private readonly _vp: MutablePoint = { x: 0, y: 0 };
  private readonly _bounds: MutableBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  /** Start a script. Cues are sorted by `atMs` once here (not per frame). */
  play(cues: readonly CameraCue[], nowMs: number): void {
    this.cues = [...cues].sort((a, b) => a.atMs - b.atMs);
    this.startMs = nowMs;
    this.playing = this.cues.length > 0;
    this.cueIndex = -1;
    this.hasLast = false;
    this.trackId = null;
  }

  stop(): void {
    this.playing = false;
    this.cues = [];
    this.cueIndex = -1;
    this.trackId = null;
  }

  isActive(): boolean {
    return this.playing;
  }

  /** Index of the cue currently driving the camera (-1 before the first cue). */
  currentCueIndex(): number {
    return this.cueIndex;
  }

  /**
   * Resolve this frame's camera target into `out`.
   * - `'idle'`: no script playing — leave the camera alone.
   * - `'active'`: `out` holds the target.
   * - `'released'`: the script hit a `release` cue; the caller should hand the
   *   camera back to gameplay. The director stops itself.
   */
  update(nowMs: number, lookup: CameraTargetLookup, out: DirectorTarget): DirectorStatus {
    if (!this.playing) return 'idle';
    const elapsed = nowMs - this.startMs;

    // Advance to the latest cue whose start time has passed.
    let idx = this.cueIndex;
    while (idx + 1 < this.cues.length && this.cues[idx + 1]!.atMs <= elapsed) idx++;
    if (idx !== this.cueIndex) {
      this.cueIndex = idx;
      this.cueStartMs = this.startMs + this.cues[idx]!.atMs;
    }
    if (idx < 0) {
      // Before the first cue: hold wherever the camera already is.
      return this.emitLast(out, 0) ? 'active' : 'idle';
    }

    const cue = this.cues[idx]!;
    const smoothMs = cue.smoothMs ?? DEFAULT_CUE_SMOOTH_MS;
    const shot = cue.shot;
    if (shot.kind === 'release') {
      this.stop();
      return 'released';
    }
    const resolved = this.resolveShot(shot, nowMs, nowMs - this.cueStartMs, lookup, smoothMs);
    if (!resolved) {
      return this.emitLast(out, smoothMs) ? 'active' : 'idle';
    }
    this.lastX = this._pt.x;
    this.lastY = this._pt.y;
    this.hasLast = true;
    out.x = this.lastX;
    out.y = this.lastY;
    out.zoom = this.lastZoom;
    out.smoothMs = smoothMs;
    return 'active';
  }

  private emitLast(out: DirectorTarget, smoothMs: number): boolean {
    if (!this.hasLast) return false;
    out.x = this.lastX;
    out.y = this.lastY;
    out.zoom = this.lastZoom;
    out.smoothMs = smoothMs;
    return true;
  }

  /** Writes the target centre into `_pt` and zoom into `lastZoom`. */
  private resolveShot(
    shot: Exclude<CameraShot, { kind: 'release' }>,
    nowMs: number,
    cueElapsedMs: number,
    lookup: CameraTargetLookup,
    smoothMs: number,
  ): boolean {
    switch (shot.kind) {
      case 'hold':
        this._pt.x = shot.x;
        this._pt.y = -shot.y;
        this.lastZoom = shot.zoom;
        return true;

      case 'orbit': {
        const theta = (shot.phase ?? 0) + (cueElapsedMs / shot.periodMs) * Math.PI * 2;
        this._pt.x = shot.x + Math.cos(theta) * shot.radius;
        this._pt.y = -(shot.y + Math.sin(theta) * shot.radius);
        this.lastZoom = shot.zoom;
        return true;
      }

      case 'path':
        return this.samplePath(shot.keys, shot.easing ?? 'smooth', cueElapsedMs);

      case 'track': {
        if (!lookup.pose(shot.target, this._pt)) return false;
        const px = this._pt.x;
        const py = this._pt.y;
        this.updateTrackVelocity(shot.target, px, py, nowMs);
        // Feed-forward: a critically-damped spring trails a constant-velocity
        // target by ≈ v × smoothTime, so aim that far ahead to cancel the lag;
        // `leadMs` is then a genuine look-ahead on top.
        const lead = (shot.leadMs ?? 0) + smoothMs;
        this._pt.x = px + (shot.offsetX ?? 0) + this.trackVx * lead;
        this._pt.y = py - (shot.offsetY ?? 0) + this.trackVy * lead;
        this.lastZoom = shot.zoom;
        return true;
      }

      case 'frame': {
        const b = this._bounds;
        const n = shot.ids ? lookup.idsBounds(shot.ids, b) : lookup.groupBounds(shot.group ?? 'all', b);
        if (n === 0) return false;
        lookup.viewport(this._vp);
        const pad = shot.padding ?? DEFAULT_FRAME_PADDING;
        const w = Math.max(FRAME_MIN_EXTENT, b.maxX - b.minX) * (1 + 2 * pad);
        const h = Math.max(FRAME_MIN_EXTENT, b.maxY - b.minY) * (1 + 2 * pad);
        let zoom = Math.min(this._vp.x / w, this._vp.y / h);
        const lo = shot.minZoom ?? DEFAULT_FRAME_MIN_ZOOM;
        const hi = shot.maxZoom ?? DEFAULT_FRAME_MAX_ZOOM;
        if (zoom < lo) zoom = lo;
        if (zoom > hi) zoom = hi;
        this._pt.x = (b.minX + b.maxX) / 2;
        this._pt.y = (b.minY + b.maxY) / 2;
        this.lastZoom = zoom;
        return true;
      }
    }
  }

  private samplePath(keys: readonly CameraKey[], easing: 'smooth' | 'linear', t: number): boolean {
    if (keys.length === 0) return false;
    let a = keys[0]!;
    if (t <= a.t || keys.length === 1) {
      this._pt.x = a.x;
      this._pt.y = -a.y;
      this.lastZoom = a.zoom;
      return true;
    }
    for (let i = 1; i < keys.length; i++) {
      const b = keys[i]!;
      if (t <= b.t) {
        const span = b.t - a.t;
        let f = span > 0 ? (t - a.t) / span : 1;
        if (easing === 'smooth') f = f * f * (3 - 2 * f);
        this._pt.x = a.x + (b.x - a.x) * f;
        this._pt.y = -(a.y + (b.y - a.y) * f);
        // Interpolate zoom geometrically so zooming in/out feels even.
        this.lastZoom = a.zoom * Math.pow(b.zoom / a.zoom, f);
        return true;
      }
      a = b;
    }
    this._pt.x = a.x;
    this._pt.y = -a.y;
    this.lastZoom = a.zoom;
    return true;
  }

  private updateTrackVelocity(id: string, x: number, y: number, nowMs: number): void {
    if (this.trackId !== id) {
      this.trackId = id;
      this.trackVx = 0;
      this.trackVy = 0;
    } else {
      const dt = nowMs - this.trackPrevMs;
      if (dt > 0) {
        const vx = (x - this.trackPrevX) / dt;
        const vy = (y - this.trackPrevY) / dt;
        this.trackVx += (vx - this.trackVx) * LEAD_VELOCITY_ALPHA;
        this.trackVy += (vy - this.trackVy) * LEAD_VELOCITY_ALPHA;
      }
    }
    this.trackPrevX = x;
    this.trackPrevY = y;
    this.trackPrevMs = nowMs;
  }
}
