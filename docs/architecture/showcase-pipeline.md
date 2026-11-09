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
pnpm showcase --capture 900p          # render size (default 720p; see "Frame rate")
pnpm exec tsx showcase/bench-capture.ts out/  # can this machine film smoothly right now?
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
   the GPU name. Every URL carries `worker=0&diag=0&cleanworld=1` (no debug
   world overlays: spatial grid, turret aim guides, NPC callsigns), and the take aborts if
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
     is constant 60 fps H.264 (`--fps 30` available).
   - **Cuts:** `cuts` windows (e.g. the 30 s warp spool) are removed by
     dropping their frames.
   - **Phone shots** are pillarboxed into the 16:9 frame.
   - **Captions:** a lower-third, rendered from HTML, fades in and out.
6. **QA.** Each shot gets up to 3 takes and keeps the smoothest (see "Frame
   rate" below). A clip is flagged, never silently used, if its best take:
   - delivered < 55 fps or had a frame gap > 100 ms (at 60 fps output);
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

## Frame rate — why 720p, and the smoothness gate

Capture is real time: the game runs while frames are grabbed, so the machine
must render AND capture at 60 fps. `showcase/bench-capture.ts` measures it.
On the dev laptop (Iris Xe):

| Mode | Game fps | Captured fps |
|---|---|---|
| 1080p, no capture | 47 | — |
| 1080p, CDP screencast | 20 | 19 |
| 720p, no capture | 59 | — |
| 720p, CDP screencast (JPEG q80) | 53 | 52 |
| 720p, canvas MediaRecorder (VP8) | 53 | 49 |

The GPU cannot render the game at 1080p60 even before capture, and 1080p
screencasting halves it. **Takes render at 1280×720** (`--capture`), are
upscaled to 1080p with Lanczos, and output at **60 fps**. Shot zooms are
authored against a 1920-wide frame and scaled to the capture width
(`scaleCues`), so framing is identical at any capture size; mouse positions go
through `ctx.px()` / `toScreen(..., ctx.viewport)`.

**Smoothness gate** (`showcase/smoothness.ts`): a take must deliver ≥ 55 fps
with no frame gap over 100 ms. Each shot gets **up to 3 takes**; the smoothest
is kept and only it is encoded. A clip that never passes is flagged in the
manifest. (The first gate, ≥ 20 fps, let visibly choppy clips through.)

**Debug overlays never reach footage**: the recorder always adds
`cleanworld=1` (no spatial grid, turret aim guides, NPC callsigns or
server-position ghost) and `noselfdmg=1` on invulnerable takes.

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

- **Real-time capture is host-load sensitive.** Memory pressure and other
  sessions cause hitches; the smoothness gate and best-of-3 takes absorb some
  of it, but record on a quiet machine. Run `bench-capture.ts` first if unsure.
- **Galaxy shots run against the living world,** whose squads move
  non-deterministically. Use `startWhen` to wait for the action rather than a
  fixed delay.
- **WebRTC is off under automation,** so footage runs over WebSocket.
- **Not yet filmed** (see `SHOWCASE_PENDING`): AI-vs-AI allegiances, which need a
  staged two-faction room. **Wave attacks** are catalogue-only: the squad holds
  at the sector edge for more than 45 s before committing, so the assault needs
  a fast-approach trigger to land inside a take.
- **DOM panels opened inside the world-anchored inspector** (the cargo panel)
  do not appear in the screencast frames, although the DOM has them and a page
  screenshot shows them. The `break-in` shot is catalogue-only until that is
  understood. Drawers, dialogs and toasts record fine.
- **Menus no longer freeze the game in takes (corrected 2026-11-08).** The
  `trade-deal` smoothness failures (~34 fps, 1.2–1.5 s frame gaps) were NOT the
  Trade tab's cost. The client stopped the Pixi ticker whenever a drawer or the
  galaxy overview was open under `navigator.webdriver` (an E2E workaround for
  CDP starvation), and the recorder is Playwright, so it filmed a paused game
  behind every menu. The pause is now keyed on an explicit flag only the e2e
  projects set (`localStorage.eqxE2ePause`, or `?e2ePause=1`; see
  `src/client/app/automationTickerPause.ts`), so takes run the game live.

## Failure handling

- A take whose scripted actions throw (`shot.run`) is a failed take, never an
  encoded clip: the recorder stops the screencast, then rethrows.
- A shot with no usable take after `MAX_TAKES` is logged and skipped; the rest
  of the run continues and the run exits non-zero naming the skipped shots.
- After a crashed take restarts the server, the recorder warms up again before
  the next take (the first take after a boot is the unstable one).
- Moving a take into `clips/<id>` retries: Windows briefly locks folders.
- Every Vite proxy entry must target `SERVER_PORT` (locked by
  `tests/unit/viteProxyPort.test.ts`). A hard-coded `localhost:2567` sends the
  isolated capture's requests to whatever dev server owns that port.
- **Parallel sessions: `EQX_SHOWCASE_PORT_OFFSET=<n>`** moves the capture
  servers to 2767+n / 5373+n (`defaultPorts()` in `showcase/servers.ts`; the
  perf runner uses the same base, its head arm +1). The capture servers kill
  whatever listens on their own ports at start, so two recorders on one machine
  MUST use different offsets.
- **Host load is recorded per take (2026-11-08).** `showcase/hostLoad.ts`
  samples system CPU, free RAM and foreign game servers / Vites (listeners on
  the known game ports, or EQX node processes, outside this run's process
  tree) before and after each take; the kept take's samples and any flags go
  in `manifest.json` (`hostLoad`). Record only: a take is never failed on it,
  but a hitchy take with a "host busy" flag was filmed on a loaded machine.
- The pid file (`showcase-out/.showcase-pids.json`, override
  `EQX_SHOWCASE_PID_FILE`) records each child's owning run; `reapStale()` never
  kills the children of a run that is still alive, and every write creates
  `showcase-out/` first (a fresh checkout crashed with ENOENT).

## Piloted shots

Shots in `showcase/shots/cockpit.ts` are flown from one player's ship: the
camera tracks `local`, the HUD is `clean` (shield/hull, cargo, wallet stay on
screen), and `_pilot.ts` steers with the arrow keys (`flyTo`, `flyRoute`,
`face`). Prefer this over a free camera for anything a player does.

- **The Trade tab does not block the main thread.** The frame gaps seen with
  it open (0.9–1.9 s) were the automation ticker pause behind an open drawer
  (see "Menus no longer freeze the game in takes" above), not Trade-tab work.
  Re-record `trade-deal` and check its `DrawFrame` gaps (about 17 ms expected)
  before profiling the tab itself.
- **Trade rooms share one sector name,** so each take's Capital is saved and
  restored into the next take's room. `placeHome` tries a ring of spots.
