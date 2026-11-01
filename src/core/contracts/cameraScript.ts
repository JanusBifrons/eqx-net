/**
 * Cinematic camera script — plain-data shot descriptions consumed by the
 * client's `CameraDirector` (src/client/render/camera/CameraDirector.ts) via
 * `IRenderer.setCameraScript`.
 *
 * Everything here is structured-clone safe (it crosses the OffscreenCanvas
 * worker boundary as the `SET_CAMERA_SCRIPT` message) and carries NO behaviour.
 *
 * Coordinates authored in a script are GAME space (Y-up), matching every other
 * game-space API (`glideCameraTo`, spawn params). The director converts to the
 * renderer's pixi space (Y-down) internally.
 *
 * Entity ids: `'local'` = the local player's ship; a playerId = that player's
 * ship; `swarm-<entityId>` = a binary-swarm entity (asteroid / drone /
 * structure / scrap) — the same keys the renderer's sprite map uses.
 */

/** Named entity groups a `frame` shot can fit. */
export type CameraGroup =
  | 'ships' // every player ship (active hulls)
  | 'drones' // swarm kind 1
  | 'structures' // swarm kind 2
  | 'asteroids' // swarm kind 0
  | 'scrap' // swarm kind 3
  | 'all'; // every sprite the renderer currently draws

export type CameraShot =
  /** Fixed framing on a game-space point. */
  | { kind: 'hold'; x: number; y: number; zoom: number }
  /**
   * Follow an entity. `offsetX/Y` are game-space units added to the target;
   * `leadMs` looks ahead along the entity's measured velocity (a drone flying
   * right drifts toward the right third of the frame instead of dead-centre).
   */
  | { kind: 'track'; target: string; zoom: number; offsetX?: number; offsetY?: number; leadMs?: number }
  /**
   * Fit a group (or explicit ids) in frame. Zoom is computed from the bounding
   * box (+ `padding`, a fraction of the box, default 0.25) and clamped to
   * [`minZoom`, `maxZoom`] (defaults: the camera clamp). `ids` overrides `group`.
   */
  | { kind: 'frame'; group?: CameraGroup; ids?: readonly string[]; padding?: number; minZoom?: number; maxZoom?: number }
  /**
   * Keyframed dolly. `t` is ms since THIS cue started; sampled with smoothstep
   * easing between keys (`easing: 'linear'` to disable). Holds the last key.
   */
  | { kind: 'path'; keys: readonly CameraKey[]; easing?: 'smooth' | 'linear' }
  /** Slow circular drift around a point — establishing shots. */
  | { kind: 'orbit'; x: number; y: number; radius: number; periodMs: number; zoom: number; phase?: number }
  /** Hand the camera back to normal gameplay control (follow the local ship). */
  | { kind: 'release' };

export interface CameraKey {
  t: number;
  x: number;
  y: number;
  zoom: number;
}

/**
 * One entry in a script. `atMs` is relative to the moment the script starts
 * playing. `smoothMs` is the critically-damped spring time constant used to
 * reach this shot's target (0 = hard cut; default 450).
 */
export interface CameraCue {
  atMs: number;
  shot: CameraShot;
  smoothMs?: number;
}

export const DEFAULT_CUE_SMOOTH_MS = 450;
