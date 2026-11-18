import type { Container } from 'pixi.js';
import type { Camera } from '../worker/Camera';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { HaloRadar } from '../HaloRadar';
import { NAVAL_RANGE } from '@shared-types/combat/navalRange';
import { GAMEPLAY_MAX_ZOOM, GAMEPLAY_MIN_ZOOM, hullZoomFactor, zoomRangeForKind } from '@shared-types/shipScale/tuning';
import {
  CameraDirector,
  type CameraTargetLookup,
  type DirectorTarget,
  type MutableBounds,
  type MutablePoint,
} from '../camera/CameraDirector';
import { GroupBoundsScanner } from '../camera/groupBounds';
import type { CameraCue, CameraGroup } from '@core/contracts/cameraScript';
import { getShipKind } from '../../../shared-types/shipKinds';
import { zoomFloorFor } from '../../../shared-types/shipScale/commandZoom.js';
import { localCameraKey } from '../camera/localCameraKey';

// Default gameplay camera zoom (world Container scale). 1.0 preserves the
// historical framing; tune here once the `?zoom=` on-device A/B settles.
// 2026-06-03 zoom-range tweak: the gameplay camera now allows zooming
// much further OUT (clampZoom minScale 0.4 → 0.15 below) so the player can
// take in the wider battlefield. The DEFAULT start zoom moved from 1.0 to
// 0.5 — close to the OLD max zoom-out (0.4), raised slightly — so you spawn
// seeing more of the sector. `?zoom=` still overrides for on-device A/B.
export const DEFAULT_GAMEPLAY_ZOOM = 0.5;

/**
 * What the camera director reads from the renderer: a live getter view built
 * once by PixiRenderer (the camera is assigned in `init`), so reads allocate
 * nothing.
 */
export interface RendererCameraDeps {
  readonly camera: Camera;
  readonly lastMirror: RenderMirror | null;
  readonly sprites: Map<string, Container>;
  readonly swarmSpriteKinds: Map<string, number>;
  readonly spectator: boolean;
  readonly initialized: boolean;
  readonly halo: HaloRadar;
}

/**
 * PixiRenderer's camera framing: the hull zoom range and caps, and the
 * cinematic director (cue scripts) with the per-frame follow. Built once by
 * PixiRenderer; `updateFrame` runs once per `update()` and allocates only
 * the follow target it always has (`camera.follow({...})`, existing debt).
 */
export class RendererCameraDirector {
  constructor(private readonly deps: RendererCameraDeps) {
    this._directorLookup = this.createDirectorLookup();
  }

  private get camera(): Camera { return this.deps.camera; }
  private get _lastMirror(): RenderMirror | null { return this.deps.lastMirror; }
  private get sprites(): Map<string, Container> { return this.deps.sprites; }
  private get _swarmSpriteKinds(): Map<string, number> { return this.deps.swarmSpriteKinds; }
  private get _spectator(): boolean { return this.deps.spectator; }
  private get initialized(): boolean { return this.deps.initialized; }
  private get halo(): HaloRadar { return this.deps.halo; }

  /** Zoom range follows the ship you fly (capital-ship round 3 D): the kind id
   *  last applied, its hull zoom factor, and whether `?zoom=` pinned the start. */
  private _zoomKindId: string | null = null;
  private _zoomFactor = 1;
  private _viewW = 0;
  private _viewH = 0;
  _zoomPinned = false;
  private readonly _zoomRange = { minScale: GAMEPLAY_MIN_ZOOM, startZoom: 0, maxScale: GAMEPLAY_MAX_ZOOM };
  /** Cinematic camera (docs/architecture/cinematic-camera.md). While a script
   *  plays the director is the sole camera driver: `update()` stops re-issuing
   *  the local-ship follow and feeds `Camera.setDirectorTarget` instead. */
  private readonly _director = new CameraDirector();
  private readonly _directorOut: DirectorTarget = { x: 0, y: 0, zoom: 1, smoothMs: 0 };
  private readonly _directorLookup: CameraTargetLookup;

  /** The zoom range follows the ship you fly: on a change of kind, the
   *  zoom-out floor moves, and a different-sized hull starts at its own zoom
   *  (unless `?zoom=` pinned it). Compares ids only, so steady state is free. */
  applyHullZoom(mirror: RenderMirror): void {
    const ship = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId) : undefined;
    const id = ship?.kind ?? null;
    if (id === null || id === this._zoomKindId) return;
    this._zoomKindId = id;
    const kind = getShipKind(id);
    zoomRangeForKind(kind, DEFAULT_GAMEPLAY_ZOOM, this._zoomRange, NAVAL_RANGE, this._viewW, this._viewH);
    this.applyZoomCap();
    const f = hullZoomFactor(kind);
    if (f !== this._zoomFactor) {
      this._zoomFactor = f;
      if (!this._zoomPinned) this.camera.setZoom(this._zoomRange.startZoom);
    }
  }

  /** Every viewport-size change goes through here: the camera's screen size,
   *  and (once a hull is known) the zoom-out floor, which for a capital in
   *  `real` naval-range mode depends on the viewport (`zoomFloorForView`). */
  setViewSize(w: number, h: number): void {
    this._viewW = w;
    this._viewH = h;
    this.camera.setScreenSize(w, h);
    if (this._zoomKindId === null) return;
    zoomRangeForKind(getShipKind(this._zoomKindId), DEFAULT_GAMEPLAY_ZOOM, this._zoomRange, NAVAL_RANGE, w, h);
    this.applyZoomCap();
  }

  /** The zoom-in cap: the hull you fly fits on screen (`zoomCeilingForView`,
   *  owner decision 2026-11-12), eased down by the Camera, never snapped.
   *  Spectator keeps the ordinary cap (there may be no ship to fit). Also the
   *  zoom-out floor: command view reaches the widest ship floor (`zoomFloorFor`). */
  applyZoomCap(): void {
    if (this._zoomKindId !== null) this.camera.setMinScale(zoomFloorFor(getShipKind(this._zoomKindId), this._spectator, this._viewW, this._viewH, NAVAL_RANGE));
    this.camera.setMaxScale(this._spectator || this._zoomKindId === null ? GAMEPLAY_MAX_ZOOM : this._zoomRange.maxScale);
  }

  /** Per frame: the director drives the camera while a script plays, else the
   *  camera follows the local ship (not while spectating). Returns the sprite
   *  followed (the speed-FX sample reads it), or null. */
  updateFrame(mirror: RenderMirror, local: Container | null | undefined): { readonly x: number; readonly y: number } | null {
    if (this._director.isActive()) {
      // Cinematic script owns the camera — resolved from THIS frame's rendered
      // sprites (updated above), smoothed by the Camera's spring in tick().
      // eslint-disable-next-line no-restricted-properties -- real time: the camera director (UI)
      const status = this._director.update(performance.now(), this._directorLookup, this._directorOut, mirror.frameTimeMs);
      if (status === 'active') {
        const d = this._directorOut;
        this.camera.setDirectorTarget(d.x, d.y, d.zoom, d.smoothMs);
      } else if (status === 'released') {
        this.camera.clearDirector();
        this.halo.setCameraRelative(false);
      }
    } else if (local && !this._spectator) {
      // `follow` (not `moveCenter`) — the camera's per-tick interpolator
      // applies this target every Pixi frame (60 Hz), independent of
      // `update()` cadence. With `followLerpFactor: 1` the follow is
      // instant — matches the original every-frame `moveCenter` feel
      // but runs at ticker speed not MIRROR_UPDATE speed. See Camera
      // construction in init() for the rationale.
      this.camera.follow({ x: local.x, y: local.y });
      return local;
    }
    return null;
  }

  /**
   * Cinematic camera — play a cue script, or `null` to stop and hand the camera
   * back to gameplay. See `IRenderer.setCameraScript`. The halo ring re-anchors
   * on the camera centre while a script plays (the subject may not be the ship).
   */
  setCameraScript(cues: readonly CameraCue[] | null): void {
    if (cues === null || cues.length === 0) {
      this._director.stop();
      if (this.initialized) this.camera.clearDirector();
      this.halo.setCameraRelative(false);
      return;
    }
    // eslint-disable-next-line no-restricted-properties -- real time: the camera director (UI)
    this._director.play(cues, performance.now());
    this.halo.setCameraRelative(true);
  }

  /** Test/automation — true while a cinematic script owns the camera. */
  isCameraScripted(): boolean {
    return this._director.isActive();
  }

  /** Lookup over the sprite map for the director (pixi space). Built once. */
  private createDirectorLookup(): CameraTargetLookup {
    // Group bounds: `GroupBoundsScanner` (alloc-free, #14), which also counts
    // structures culled off screen (review 2026-11-12, capital-lineup).
    const groupScanner = new GroupBoundsScanner(this._swarmSpriteKinds);
    // Ids-bounds accumulator state.
    let count = 0;
    let acc: MutableBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    // A framed entity contributes its whole extent (radius `r`), not just its
    // centre: a 10x capital reaches kilometres past its centre (round 3).
    const add = (x: number, y: number, r = 0): void => {
      if (count === 0) {
        acc.minX = x - r; acc.maxX = x + r;
        acc.minY = y - r; acc.maxY = y + r;
      } else {
        if (x - r < acc.minX) acc.minX = x - r;
        if (x + r > acc.maxX) acc.maxX = x + r;
        if (y - r < acc.minY) acc.minY = y - r;
        if (y + r > acc.maxY) acc.maxY = y + r;
      }
      count++;
    };
    // Half the sprite's longer side: covers any rotation. Cinematic-only path.
    const extentOf = (sprite: Container): number => Math.max(sprite.width, sprite.height) / 2;
    return {
      pose: (id: string, out: MutablePoint): boolean => {
        const sp = this.cameraSprite(id);
        if (!sp || !sp.visible) return false;
        out.x = sp.x;
        out.y = sp.y;
        return true;
      },
      groupBounds: (g: CameraGroup, out: MutableBounds): number => groupScanner.scan(this.sprites, g, out),
      idsBounds: (ids: readonly string[], out: MutableBounds): number => {
        count = 0;
        acc = out;
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!;
          const sp = this.cameraSprite(id);
          if (sp && sp.visible) add(sp.x, sp.y, extentOf(sp));
        }
        return count;
      },
      viewport: (out: MutablePoint): void => {
        out.x = this.camera ? this.camera.screenWidth : 0;
        out.y = this.camera ? this.camera.screenHeight : 0;
      },
    };
  }

  /** The sprite a camera cue follows. `'local'` resolves through
   *  `localCameraKey`: the pilot's ship, or their parked hull while spectating
   *  (review 2026-11-12: a 'local' cue did nothing once spectating). */
  private cameraSprite(id: string): Container | undefined {
    if (id !== 'local') return this.sprites.get(id);
    const m = this._lastMirror;
    const lk = localCameraKey(m ?? null, this._isDrawnSprite);
    if (lk === null) return undefined;
    return this.sprites.get(lk.key);
  }
  private readonly _isDrawnSprite = (key: string): boolean => {
    const sp = this.sprites.get(key);
    return sp !== undefined && sp.visible;
  };
}
