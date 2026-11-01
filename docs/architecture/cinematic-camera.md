# Cinematic Camera — `CameraDirector`

A scriptable camera layer for showcase / trailer capture (and any future
in-game cutscene). It sits **above** the gameplay `Camera`
(`src/client/render/worker/Camera.ts`) and drives it from plain-data shot
scripts. In normal play it is inert: no script, no cost.

## Why it exists

The gameplay camera only knows how to follow the local ship (plus spectator
free-roam and the one-shot pilot-swap glide). Filming the game needs framed
groups, keyframed dollies, slow orbits and tracking of *other* entities, and it
needs them to be **repeatable**: the same script must produce the same camera
move every time the showcase is re-recorded (see
[showcase-pipeline.md](showcase-pipeline.md)).

## Moving parts

| Piece | File | Role |
|---|---|---|
| Shot data | `src/core/contracts/cameraScript.ts` | `CameraCue[]` / `CameraShot` union. Plain data, structured-clone safe, game-space (Y-up) coordinates. |
| Director | `src/client/render/camera/CameraDirector.ts` | Pure. Advances cues by time, resolves this frame's target (pixi space) from a `CameraTargetLookup`. |
| Spring | `src/client/render/camera/smoothDamp.ts` | Critically-damped spring (no overshoot), alloc-free. |
| Camera hook | `Camera.setDirectorTarget / clearDirector` | Applies the target inside `Camera.tick` with the spring; zoom damped in log space. |
| Renderer seam | `IRenderer.setCameraScript(cues \| null)` | Main-thread `PixiRenderer` + worker `SET_CAMERA_SCRIPT` message. |
| Automation hook | `window.__eqxCinema` (DEV) | `play / stop / setHud / isScripted` for Playwright. |
| HUD mode | `src/client/cinematic/hudMode.ts` | `?cinematic=1` / `?hud=full\|minimal\|none` → one class on `<html>`. |

## Shot types

| Shot | Use |
|---|---|
| `hold { x, y, zoom }` | Fixed framing. |
| `track { target, zoom, offsetX?, offsetY?, leadMs? }` | Follow an entity; `leadMs` looks ahead along its measured velocity. |
| `frame { group \| ids, padding?, minZoom?, maxZoom? }` | Fit a group (`ships`, `drones`, `structures`, `asteroids`, `scrap`, `all`) or explicit ids. |
| `path { keys[{t,x,y,zoom}], easing? }` | Keyframed dolly; zoom interpolates geometrically. |
| `orbit { x, y, radius, periodMs, zoom }` | Slow circular drift for establishing shots. |
| `release` | Hand the camera back to gameplay follow. |

Each cue carries `atMs` (relative to script start) and `smoothMs` (spring time
constant; `0` = hard cut, default 450).

Entity ids: `'local'`, a playerId, or `swarm-<entityId>` (the renderer's sprite
keys).

## Ownership rules (load-bearing)

1. **One driver.** While a script plays, the director is the only thing moving
   the camera. `Camera.tick` precedence is **director > glide > follow > pan**;
   activating the director clears the follow target, cancels any glide and
   kills momentum. `PixiRenderer.update` stops re-issuing the local-ship follow
   while a script is active (the same pattern as spectator mode). Without this,
   the follow target that `Camera` keeps between frames snaps the view back to
   the ship every tick.
2. **Read rendered poses.** Targets come from sprite positions after this
   frame's sprite update, the same source the gameplay follow uses. Never
   re-interpolate a drone (one-pose-per-frame, invariant #12).
3. **Smoothing lives in `Camera.tick`.** The director only sets the target, so
   camera motion stays at the 60 Hz ticker rate even when `update()` runs at the
   30 Hz worker render cadence.
4. **No allocation per frame** (invariant #14): director state is class fields,
   the lookup's group scan uses one pre-bound `Map.forEach` callback, and the
   `Camera` computes its centre inline (the `center` getter allocates).
   Locked by `CameraDirector.heapDelta.test.ts`.
5. **Keyframes never touch Zustand** (invariant #2). `__eqxCinema` calls the
   renderer directly; the HUD mode is a CSS class, not a store field.
6. **Halo radar re-anchors** on the camera centre while a script plays
   (`HaloRadar.setCameraRelative`), since the subject may not be the ship.

## Interest-window caveat

The client only receives full-fidelity entities inside the piloted ship's 3×3
interest window (2048 u cells, ~±3000 u). A shot that frames far from the ship
will show stale or missing entities. Keep the piloted ship near the action or
stay within that window.

## Tests

- `CameraDirector.test.ts`: each shot type, cue ordering, lead, hold-on-missing, release.
- `Camera.director.test.ts`: precedence over follow/glide/pan, spring convergence without overshoot, cut, zoom clamp, hand-back.
- `CameraDirector.heapDelta.test.ts` (`pnpm test:gc`): zero per-frame allocation.
- `protocol.test.ts`: `SET_CAMERA_SCRIPT` structured-clone round-trip.
- `tests/e2e/cinematic-camera.spec.ts`: HUD hide/show, hold lands on the game-space point, track converges on the rendered ship, release restores follow.
