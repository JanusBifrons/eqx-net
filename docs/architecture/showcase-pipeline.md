# Showcase Video Pipeline

A repeatable way to film the game. One command records every shot against a
real server in a real browser, captions it, and cuts the result into a reel.
When a feature lands, you add one shot file and re-run.

```
pnpm showcase                       # record + compose the reel from this checkout
pnpm showcase --ref origin/main     # film a snapshot of main (worktree at that ref)
pnpm showcase --shot flight,scrap   # re-take specific shots; the rest are reused
pnpm showcase --catalogue           # every shot, not just the reel
pnpm showcase --compose-only        # rebuild the reel from existing clips
pnpm showcase --fps 60              # output frame rate (default 30)
```

Output (gitignored) lands in `showcase-out/`:

- `reel-1080p.mp4`: the master.
- `reel-720p.mp4`: a small preview.
- `clips/<id>/clip.mp4`: one captioned clip per shot.
- `contact-sheets/<id>.png`: 12 frames per clip, for review.
- `manifest.json`: per-clip snapshot SHA, frame rate and QA verdict.

**Requires ffmpeg** (Windows: `winget install Gyan.FFmpeg`; macOS: `brew install ffmpeg`, or set `EQX_FFMPEG`). The pipeline finds a winget install without a shell restart.

## How a take works

1. **Isolated servers.** `showcase/servers.ts` boots `dev:server:nowatch` on
   **2767** and Vite on **5373** (`EQX_SERVER_PORT` points Vite's proxy at it),
   against a temp `DB_PATH`. It never touches a dev session on 2567/5173 or the
   dev database.
2. **Server profile per shot.** `lean` turns the living world off
   (`EQX_DISABLE_LIVING_WORLD=1`). `living` is the full galaxy. `wave` adds the
   wave base (`EQX_E2E_WAVE=1`, 5 s bot spool). Shots are recorded grouped by
   profile, then cut back into reel order.
3. **Browser.** Headless Chromium on the **real GPU** (`--use-angle=d3d11`).
   SwiftShader renders the warp/shockwave filters black, so the recorder logs
   the GPU name. Every URL carries `worker=0&diag=0`, and the take aborts if
   diag is on or `window.__eqxCinema` is missing at that ref.
4. **Enter, prepare, wait, record.**
   - Wait until in-game (store join flags), then 1.2 s more for the arrival flash.
   - Run `prepare`, then `startWhen` (event-driven takes such as the wave
     banner).
   - Record `durationMs` of CDP screencast frames to disk, each with its
     compositor timestamp.
   - The shot's camera script (`__eqxCinema.play`) and its `run` actions start
     with the recording.
5. **Encode.**
   - **Frame timing:** each frame holds until the next one's capture time, so
     a dropped frame freezes for a beat instead of speeding the clip up. Output
     is constant 30 or 60 fps H.264.
   - **Cuts:** `cuts` windows (e.g. the 30 s warp spool) are removed by
     dropping their frames.
   - **Phone shots** are pillarboxed into the 16:9 frame.
   - **Captions:** a lower-third, rendered from HTML, fades in and out.
6. **QA.** A clip is flagged for a re-take, never silently used, if:
   - it delivered < 20 fps;
   - it froze for > 1.5 s;
   - it has ≥ 1 s of blank frames (judged by the brightest pixel, since space
     is dark);
   - it captured < 30 frames.
7. **Assemble.**
   - **Cards:** title, section and end cards are HTML screenshots (system fonts
     — nothing to bundle).
   - **Joins:** clips dip to black between cards, and the concat is a stream
     copy.
   - **SHA check:** composing refuses to mix clips from different snapshot
     SHAs.

## Adding a shot (the repeatable part)

1. Create `showcase/shots/<name>.ts` exporting a `Shot` (`showcase/types.ts`):
   - **id, section, title, caption.**
   - **features:** inventory ids.
   - **docs:** the doc basenames it films.
   - **server** profile.
   - **target:** room / galaxy / landing, plus URL params.
   - **hud:** `full | minimal | none`.
   - **durationMs.**
   - Optionally a `camera` script, `run` actions, `prepare`, `startWhen` and
     `cuts`.
2. Add it to `SHOTS` in `showcase/registry.ts` (order = reel order).
3. Run `pnpm showcase --shot <id>` and check the contact sheet.
4. `tests/unit/showcaseCoverage.test.ts` fails CI if any `docs/features` or
   `docs/architecture` page is neither filmed (`shot.docs`), nor in
   `SHOWCASE_EXEMPT`, nor in `SHOWCASE_PENDING`, each with a reason. It also
   fails if a shot names a room or sector the server doesn't define. **A new
   feature doc therefore forces a decision about the video.**

### Staging a scene

Prefer an existing room plus URL params:

- `startHostile=1`: drones engage you.
- `initialHull=1000000`: you survive the take.
- `shipKind`, `spawnX/Y`, `zoom`.
- `initialXp`: one kill levels the ship.

When no room stages the scene, add one to
`src/server/rooms/showcaseRooms.ts`. It is registered inside the test-room
gate with `filterBy(['testId'])`, and `tests/integration/sectorRoom/showcaseRooms.test.ts`
boots the exact options to prove the scene is what the shot claims.

Current showcase rooms:

- `showcase-ship-gallery`: the six player hulls in a line-up.
- `showcase-defence`: a powered base with a pylon wall, battery, bolt and
  missile turrets, and a drone pack beyond the wall.
- `showcase-levelup`: roster-backed, with one target, for the level-up shot.

### Camera

See [cinematic-camera.md](cinematic-camera.md). Use `track` for a moving
subject (feed-forward cancels spring lag), `frame` for groups, `path` for
dollies and `orbit` for establishing shots. Keep the framed area within about
±3000 u of the piloted ship, because the client only receives its interest
window.

## Known limits

- **Real-time capture is host-load sensitive.** The game and the encoder share
  the machine, so record on a quiet box. QA flags clips that dropped too many
  frames; re-take them with `--shot`.
- **Galaxy shots run against the living world,** whose squads move
  non-deterministically. Use `startWhen` to wait for the action rather than a
  fixed delay.
- **WebRTC is off under automation,** so footage runs over WebSocket.
- **Procedural bases and soft CCD** are pending until the bases vertical slice
  merges (see `SHOWCASE_PENDING`).
