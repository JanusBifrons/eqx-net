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
   the GPU name. Every URL carries `worker=0&diag=0`, the full HUD
   (`FILM_HUD`) and the player's look (`PLAYER_LOOK`), with no `cleanworld`
   (see "Filming and review rules"), and the take aborts if
   diag is on or `window.__eqxCinema` is missing at that ref.
4. **Enter, prepare, wait, record.**
   - Wait until in-game (store join flags), then 1.2 s more for the arrival flash.
   - Run `prepare`, then `startWhen` (event-driven takes such as the wave
     banner).
   - Record `durationMs` of CDP screencast frames to disk, each with its
     compositor timestamp.
   - The shot's camera script (`__eqxCinema.play`, spectator mode only) and
     its `run` actions start with the recording.
5. **Encode.**
   - **Frame timing:** each frame holds until the next one's capture time, so
     a dropped frame freezes for a beat instead of speeding the clip up. Output
     is constant 60 fps H.264 (`--fps 30` available). The concat list reads
     every frame at `option framerate 60` (`CONCAT_FRAMERATE`): without it
     ffmpeg's image demuxer uses a 25 fps time base, every 1/60 s duration
     rounds to 0 or 40 ms, and the clip shows ~25 different frames a second in
     a 2/3-slot judder even though 60 were captured (bug 2026-11-10).
   - **Cuts:** `cuts` windows (e.g. the 30 s warp spool) are removed by
     dropping their frames.
   - **Phone shots** are pillarboxed into the 16:9 frame.
   - **Captions:** a lower-third, rendered from HTML, fades in and out.
     In a spectator take the game shows its build bar along the bottom, so
     the recorder reads the bar's top edge (`bottom-control-panel`, after
     setup, after each `ctx.spectate()` and at the end; `bottomHudTop` in
     `manifest.json`) and the caption's box ends 16 px above it
     (`captionPlacement.ts`). Without the bar (pilot mode) it keeps its
     default place. The game UI is never moved or hidden (record as is).
6. **QA.** Each shot gets up to 3 takes and keeps the smoothest (see "Frame
   rate" below). A clip is flagged, never silently used, if its best take:
   - delivered < 55 fps or had a frame gap > 100 ms (at 60 fps output);
   - captured < 55 DIFFERENT frames a second (`uniqueFps`: consecutive
     byte-identical JPEGs count once), or < 55 different frames a second
     reached the encode (`encodedUniqueFps`: ffprobe reads the concat list as
     the encode does, one frame per output slot). `deliveredFps` counts
     arrivals, repeats included, so it alone said "60 fps" for clips that
     moved 25 times a second. All three, plus `longestRepeat`, are in
     `manifest.json` (`showcase/cadence.ts`);
   - the WORLD froze mid-motion (`worldStalls`, from frame-to-frame PSNR of the
     encoded clip): a run of 2–10 near-identical frames (> 55 dB) with mostly
     moving frames on both sides counts as a stall; more than one stall per
     two seconds of motion, or one of 6+ frames, flags the clip. Byte counts
     can't see this when HUD text changes on a frozen frame (the long-guns
     zoom "chug", 2026-11-12). A sparse scene at rest is not a stall;
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

**Clips film what a player sees**: the recorder no longer adds
`cleanworld=1`, so world overlays a player has on (the grid, aim guides,
callsigns) are filmed too ("Show everything", 2026-11-10; `showcase/recorder.ts`
`FILM_HUD`).

## Adding a shot (the repeatable part)

1. Create `showcase/shots/<name>.ts` exporting a `Shot` (`showcase/types.ts`):
   - **id, section, title, caption.**
   - **features:** inventory ids.
   - **docs:** the doc basenames it films.
   - **server** profile.
   - **target:** room / galaxy / landing, plus URL params.
   - **hud:** `full | minimal | none`.
   - **durationMs.**
   - Optionally `endsWithRun`: the take ends when `run` resolves (`durationMs` is then the cap) and the clip is encoded at that length. For a subject that can end early in the game itself (fleet-melee ends ~3 s after the last robot dies). `run` decides it by reading game state, never by changing play.
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

### Record as is: no cues that change play during the take (2026-11-10)

User: "Don't hide shit for a good demo... Record as is and then let me be the
judge." A cue is one of two kinds:

- **Setup, before recording starts:** arranging the scene, like choosing a
  room. Fine: the room, `shipKind`, `spawnX/Y`, `initialXp`, `startHostile=1`
  at join, ONE `test_aggro` in `prepare`/`startWhen`, prebuilt structures.
- **Changing behaviour during the take:** not allowed. Examples:
  `test_reload_turrets` (the 16" barbette fired two salvos 0.2 s apart in
  `coastal-duel`, which the owner saw as a bug), re-sending `test_aggro` to
  keep drones hostile past their real 30 s decay, `instantLock` / `anyTarget`
  / `lockTimeCapS` (lock times that aren't the game's), `initialHull=1000000`
  / `noselfdmg=1` (an unkillable pilot, its damage numbers hidden), forced
  spawns mid-take. If the pilot dies, the take shows what the game does next.

Converted so far: `pack-battle`, `coastal-duel`, `capital-guns-fighter`. The
other shots still carry such cues until the audit converts them.

### Camera: the follow camera while piloting, a pan only in spectator mode

User (2026-11-10): "It should look and feel as it would for me. If you need a
shot which is cinematic and panning, use spectator mode." So:

- While the take's pilot flies a ship, the camera is the game's normal follow
  camera. No `camera` script, no `ctx.cinema.play`.
- A shot that needs a pan or a free camera first calls `ctx.spectate()` (in
  `prepare`/`startWhen`, or mid-take). It clicks the Pilot / Spectate toggle's
  Spectate button as a player would; the ship parks in the world and the
  spectator's HUD shows. A scripted pan then stands in for a player panning.
- **Enforced:** `ctx.cinema.play` (and a shot's `camera` field, which goes
  through it) throws unless the store's `pilotMode` is `spectator`. Lock:
  `showcase/cinemaGuard.test.ts`. A shot not yet converted fails its take with
  that message rather than filming a staged camera.

See [cinematic-camera.md](cinematic-camera.md). Use `track` for a moving
subject (feed-forward cancels spring lag), `frame` for groups, `path` for
dollies and `orbit` for establishing shots. Keep the framed area within about
±3000 u of the piloted ship, because the client only receives its interest
window.

## Filming and review rules

Root `CLAUDE.md` keeps the short form of these; this is the full text.

**Record the game as it is; never stage it for the video (standing user directive).** Clips are for the owner to judge the look and feel. User: "Don't hide shit for a good demo, that's the antithesis of what I want you to do. Record as is and then let me be the judge. Genuine bugs, stutter, lag, stuff not firing, bad graphics, all fine to fix on sight. But don't be like 'this just doesn't make a good video but is working as intended so I'll change it for the video'." So:
- Never hide game UI or effects, re-stage a shot, move a scene, or change behaviour only to make a clip look better.
- The camera follows the pilot's ship as in play; a pan or free camera only in spectator mode (`ctx.spectate()`; `ctx.cinema.play` throws otherwise), and no test cue changes play during the take (setup before it is fine).
- Fix genuine bugs found while filming or reviewing (with the failing test first, invariant #13).
- A hostile reviewer's "works, but makes a poor video" findings go to the owner as notes, not into changes.
- Clips film the full HUD with no `cleanworld` (user, 2026-11-10: "Show everything"). `targetUrl` forces `FILM_HUD = 'full'` and ignores a shot's `hud`; lock `showcase/targetUrl.test.ts`.

**Shots film the player's look, not the test look.** The capture browser is automated, and automation defaults to classic art and baked lighting (`artMode.ts`). `targetUrl` therefore adds `PLAYER_LOOK` (`art=machined&fx=new&shiplight=high`, a desktop player's default) to every shot; a shot's params or `EQX_SHOWCASE_PARAMS` override it. Lock: `showcase/targetUrl.test.ts` compares it with the game's own desktop default.

**A hostile reviewer checks every clip before the user sees it (standing user directive).** The take QA gates measure frame pacing, not whether the clip shows what it should. Before handing a clip to the user, give a hostile reviewer agent full-resolution frames around every key moment (10 fps crops, not a contact sheet) plus the clip's goal in one sentence, and ask it to find anything that looks wrong: an effect not lined up with its ship, a ship jumping or appearing in the wrong place, something pointing the wrong way, old effects that should be gone. Send every reviewed clip to the user straight away: one that passes the review is presented as finished; one that fails is shared as WIP, labelled so, with the review's caveats ("share first with a caveat so I get a feeling"; "present it as finished, otherwise share as a WIP"); then fix what it found and re-film. The user's words: "this is easy to identify surely? It just doesn't look right".

**Smoothness gets its own check: 10 fps frames can't show it.** For every camera move or fast motion in a clip, compare each frame with the next at the full 60 fps (ffmpeg `psnr` with a `stats_file`, as in LESSONS 2026-11-12): runs of near-identical frames (PSNR > ~55 dB) while the scene should be moving, or one frame that jumps much further than its neighbours, are a stall or a lurch. Before blaming the recorder, check the game without recording (`?perfprobe=1`, `__eqxPerf`) and, for a camera move, the per-frame camera scale or position. Then report it or fix it like any other finding.

**Look and feature R&D happens in the game, behind a flag, on a branch (standing user directive).** Not in a parallel renderer. Film it with `EQX_SHOWCASE_PARAMS=<flag>` on existing shots and measure it with `pnpm perf:scenes --base <sha> --head-params <flag>`. Example: GPU-lit art (`?shiplight=gpu`, [gpu-lit-ships.md](gpu-lit-ships.md)).

**Before EVERY recording**, clean up first (root `CLAUDE.md` "Clean up at every stage") and check free RAM; use `EQX_SHOWCASE_PORT_OFFSET` when another session is recording.

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

Shots are flown from one player's ship on the game's follow camera (no
`camera` script; see "Camera" above), and `_pilot.ts` steers with the arrow
keys (`flyTo`, `flyRoute`, `face`). Prefer this over spectator mode for
anything a player does. (`cockpit.ts` still uses a `track local` script; it is
in the audit's conversion list.)

- **The Trade tab does not block the main thread.** The frame gaps seen with
  it open (0.9–1.9 s) were the automation ticker pause behind an open drawer
  (see "Menus no longer freeze the game in takes" above), not Trade-tab work.
  Re-record `trade-deal` and check its `DrawFrame` gaps (about 17 ms expected)
  before profiling the tab itself.
- **Trade rooms share one sector name,** so each take's Capital is saved and
  restored into the next take's room. `placeHome` tries a ring of spots.

## Phone takes and scripted touch

- **Viewports.** `viewport: 'phone'` is Pixel 5 portrait (393×727 CSS px at
  2.75× DPR). `viewport: 'phone-landscape'` is a touch phone held sideways
  (844×390 CSS px at 2× DPR, a 1688×780 capture). Both are `isMobile` +
  `hasTouch`, so the game takes its touch paths. Desktop takes use the
  `--capture` size.
- **Framing.** Phone takes are not pillarboxed any more. The compositor
  (`deviceLayout`) scales them into a screen rect on the 1920×1080 output, and
  `cards.deviceFrame` draws a dark bezel with a transparent rounded screen over
  them. Portrait sits centred with the caption in the left margin (`side`).
  Landscape leaves a ~150 px band above the device for a compact `top` caption.
  `shot.captionLayout` overrides this (`none` drops the caption).
- **Small standalone clips.** `shot.maxBitrateKbps` encodes at CRF 20 under a
  VBV ceiling (`-maxrate`/`-bufsize`), still h264 yuv420p + faststart.
  `--export <dir>` copies each new clip to `<dir>/<id>.mp4`. `--shot` accepts
  `*` wildcards, and `--no-assemble` skips cutting the picked shots together.
- **Scripted input** (`showcase/touch.ts`). `touch(page)` drives CDP
  `Input.dispatchTouchEvent` with a stable id per finger, so two thumbs can be
  down at once. Each event carries every finger still down: Chrome diffs the
  set, so `touchEnd` lists the fingers that REMAIN. Gestures (`dragTo`,
  `circle`, `wiggle`, `hold`, `tap`) sample pure curves (`showcase/touchPath.ts`)
  against wall-clock time, so a slow round-trip never stretches them. Moves
  coalesce while one is in flight. `mouse(page)` does smooth glides and sweeps
  with buttons held for desktop takes.
- **Seeing the thumbs.** `?touchviz=1` mounts `src/client/hud/TouchViz.tsx`:
  translucent finger dots under every active pointer, plus a small hover dot
  for a mouse (a screencast shows no cursor).
- **Fire Control HUD takes** (`showcase/shots/fireControl.ts`, catalogue-only):
  `pnpm showcase:fc` films the `fc-*` shots into `showcase-out/fc/`. Controls
  are found by `data-testid` at run time, with a logged warning and a
  thumb-position fallback when one is missing. (The `?ui=a|b|c` variant takes,
  the auto-fire toggle and manual aim are retired; lock-to-fire is universal.)

## History

- **Frame-rate QA counts DIFFERENT frames, at the encode (2026-11-10).** QA said "60 fps" while clips showed ~25 different frames a second: ffmpeg's concat demuxer read each JPEG at a 25 fps time base (fix: `option framerate 60` per entry, `CONCAT_FRAMERATE`). Takes now gate `uniqueFps` (captured, byte-identical repeats count once) and `encodedUniqueFps` (ffprobe of the concat list) at the same ≥ 55 as `deliveredFps`; all are in `manifest.json`. Lock: `showcase/cadence.test.ts`. See `docs/LESSONS.md` 2026-11-10.
- **Player look (2026-11-10).** User: the clips "didn't have the full graphics and shadows turned on", which led to `PLAYER_LOOK`.
- **Record as is (2026-11-10)** and **full HUD, no `cleanworld`** (2026-11-10, "Show everything"): the recorder used to add `cleanworld=1` to hide debug world overlays.
- **Hostile review (2026-11-07)**; share-first-as-WIP added 2026-11-12.
- **Smoothness check (2026-11-12, the long-guns zoom "chugs like crazy").** The reviewer passed a clip whose camera lurched and stopped six times a second on every wheel notch, and the take QA said 60 different frames a second because the HUD text kept changing while the world stood still.
- **R&D in the game (2026-11-08).** The art lab lacked turrets, the game's effects, shields, fences and sky, so its clips misled ("I just don't think doing all of this work on some weird parallel system makes sense. It should be in the game, just use flags and switches and ultimately git branches to isolate").
