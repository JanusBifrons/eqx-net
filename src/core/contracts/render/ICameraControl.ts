import type { CameraCue } from '../cameraScript.js';

/** Camera: spectator free-roam, glide, pan, cinematic script. Part of `IRenderer`. */
export interface ICameraControl {
  /**
   * Phase 4 WS-A1 (Spectator / Construction mode) — toggle the free-roam
   * camera. When `active`, the renderer DETACHES the follow camera
   * (`Camera.follow(null)`) and stops re-issuing the local-ship follow each
   * `update()` frame, so the world camera free-roams the sector (drag-pan +
   * wheel/pinch zoom via the existing gameplay pointer path — no new event
   * routing). `active:false` restores normal follow-the-local-ship behaviour.
   *
   * Spatial camera state stays inside the renderer's `Camera`; only the
   * discrete `pilotMode` enum is mirrored in the store (Invariant #2).
   */
  setSpectator(active: boolean): void;
  /**
   * Phase 4 WS-A2 (Ship entry / switch) — kick off a ONE-SHOT eased camera glide
   * from the current view to the GAME-space point `(gameX, gameY)` over
   * `durationMs`. Used by the smooth same-sector ship-switch: the camera lerps to
   * the newly-piloted ship instead of snapping. It is driven by elapsed wall-clock
   * inside the `Camera` — INDEPENDENT of pose interpolation — so it never trips
   * the snapshot teleport guard (Risk #4). While the glide runs it OVERRIDES the
   * follow target, so the production `followLerpFactor:1` follow can't snap mid-
   * transition; once it completes, follow resumes on the new ship.
   */
  glideCameraTo(gameX: number, gameY: number, durationMs: number): void;
  /**
   * Phase 5 — set the SPECTATOR WASD free-pan velocity in SCREEN px/sec. The
   * main thread computes it from the held WASD/arrow keys and calls this ONLY on
   * a key state change (not per frame); the `Camera.tick` integrates it. (0, 0)
   * stops the pan. Only meaningful while spectating (follow is detached).
   */
  setPanVelocity(vx: number, vy: number): void;
  /**
   * Cinematic camera — play a cue script (`null` stops it and hands the camera
   * back to gameplay follow). While a script plays the `CameraDirector` is the
   * sole camera driver (precedence director > glide > follow > pan) and the halo
   * ring anchors on the camera centre. Used by the showcase capture pipeline;
   * inert in normal play. See docs/architecture/cinematic-camera.md.
   */
  setCameraScript(cues: readonly CameraCue[] | null): void;
}
