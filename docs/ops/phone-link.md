# Phone link (play a build on your phone from anywhere)

The phone lane serves a **production build** of any checkout through a
**Cloudflare tunnel**, behind a **secret-link gate**, so the owner can
install the game as a home-screen app (PWA) and play it from anywhere.

## Use

```bash
pnpm phone up            # build + start this checkout behind the tunnel; prints the link
pnpm phone up --dir <checkout>
pnpm phone status        # what is serving, and today's link
pnpm phone down          # stop the game AND the tunnel
```

`up` prints `LINK: https://<words>.trycloudflare.com/?k=<key>`. Open it on the
phone, then install: Android Chrome ⋮ → *Install app*; iPhone Safari Share →
*Add to Home Screen*.

- **The tunnel outlives `up`** and is reused while it lives: same address, same
  key, so the installed app keeps working across `up` runs (a new build is
  applied on the app's next load). A new tunnel (after `down`, a reboot or a
  crash) means a new address: reinstall from the new link.
- **`up` replaces whatever the lane served before**, whichever session started
  it. Agents: run it with the sandbox disabled, or its processes die later.
  The processes keep running after the session ends, until `pnpm phone down`.
  This is the one deliberate exception to "stop the processes this session
  started": the owner asked for the lane to stay up.
- Anything else on the lane's ports is never touched: `up` refuses and names it.

## How it works

`scripts/dev/phone-lane.ts` (CLI) and `scripts/dev/phone-lane-core.mjs` (pure:
gate decision, cookie, key, tunnel-URL parsing; unit-locked in
`tests/unit/phone-lane.test.ts`).

- **Server + client** come from `showcase/servers.ts` `CaptureServers` in
  preview mode: `vite build` into the lane's `dist/`, then `vite preview` with
  the same API proxy table and Colyseus WS bridge as `vite dev`
  (`vite.config.ts`). Single origin, so the client needs no server URL.
- **Ports** (fixed, owned by the lane): server 2590, preview 8090, cloudflared
  metrics `127.0.0.1:20590` (`/ready`).
- **State** lives in `<main checkout>/.claude/phone-lane/` (gitignored, shared
  by every worktree): `state.json` (tunnel pid/address/key, what is serving),
  `game-pids.json`, `run/` (logs and the lane's own `eqx.db`, kept across
  builds), `dist/`, `cloudflared.exe` (downloaded from Cloudflare's official
  GitHub release on first use; no install, no admin).
- **Previous lane processes** are stopped through showcase `reapStale` with the
  lane's own pid file (image-checked), so showcase runs and the lane never reap
  each other.
- **Service worker:** a lane build sets `VITE_PHONE_LANE=1`, which applies a
  waiting service worker at once instead of on the next launch
  ([web-push](../architecture/web-push.md)).
- **Logs:** `run/server.log` (server stdout/stderr: pino lines, tick-budget and
  GC warnings, no colour codes) and `run/vite.log` (build + preview). The
  lane's children are detached so they outlive `up`; on Windows they start
  under a small node relay (`loggedSpawnPlan` in `showcase/servers.ts`),
  because a detached `cmd.exe` drops its node child's output (the old 0-byte
  `server.log`).
- **No heavy queue:** a lane `up` is one `vite build` plus a server, started
  on request while the owner waits; it is not on the heavy-job list.

## Play evidence (read this after a play test)

Every lane play session leaves numbers on disk with no extra step:

- `run/server.log`: the server's own log for the whole lane run.
- `run/captures/<session>/`: the diagnostic capture each phone session
  streams ([diagnostic-captures](../architecture/diagnostic-captures.md));
  the lane sets `EQX_DIAG_DIR` (`laneServerEnv` in `phone-lane-core.mjs`), so
  captures land here, not in the served checkout. Start with:
  - `frames.ndjson`: one `perf_summary` line per 10 s of play:
    `{"source":"client","ts":<ms since page load>,"tag":"perf_summary","data":{...}}`
    with `windowMs`, `frames`, frame time `p50`/`p95`/`p99`/`maxMs` (ms),
    `hitches` (frames over 50 ms), `viewHalf` (zoom: half the visible world,
    game units; bigger = zoomed out), `ships`/`drones`/`structures`/`projectiles`
    on the client, `rttMs`/`rttMeanMs`/`jitterMs`, `corrections` (own-ship
    corrections in the window), `corrRate`, `maxDrift`. Numbers only: no ids,
    names or positions (`src/client/debug/perf/laneFrameSummary.ts`).
    Each line also carries the display-delay machinery (wall ms; field list
    in [diagnostic-captures](../architecture/diagnostic-captures.md#perf_summary-display-delay-fields)).
    Since the netcode gap-smoothing telemetry (S0) it also carries the
    netcode gap counters (`dcLastArrivalMs`, `dcReplacedTotal`,
    `swarmLateMaxMs`, `anchorHardSnaps`, ...): how late snapshots arrived and
    how often things snapped. Field meanings:
    [diagnostic-captures](../architecture/diagnostic-captures.md#netcode-gap-counters-phone-lane-only).
    Only phone-lane streaming captures carry them; manual and non-lane
    captures do not. Older lines without them still read (the fields are
    optional).
  - `perf.ndjson`: individual stutters (`raf_stutter` 30–100 ms, `raf_gap`
    over 100 ms), long animation frames (`loaf`), long tasks, heap samples,
    device info. In a lane build every `raf_stutter`, `raf_gap` and `loaf`
    also carries `viewHalf` (the zoom, as in `perf_summary`) and `mode`
    (`fly` / `command` / `build`) at the moment it fired
    (`withLaneStallContext` in `laneFrameSummary.ts`; read only when an event
    fires, never per frame), plus `phases`: the last stall frame's time by
    frame phase in ms (below), and `phasesAgeMs` (how long ago that frame
    ended: about 0 on `raf_stutter` / `raf_gap`, later on a `loaf`).
  - `corrections.ndjson`, `snapshots.ndjson`: the reconciliation detail behind
    sideways jitter.
- `run/audit/`: the gameplay audit log.

All of it is lane-only: a normal production build has `VITE_PHONE_LANE` unset,
so it streams no capture, makes no summary and adds no zoom, mode or phases to
stall events.

To grade the connection (Good / Playable / Poor) and split each gap between
server, network and device: `pnpm phone:verdict <capture dir>`
([network-quality](network-quality.md)).

### Naming the code behind a stall

The lane build is minified, so a `loaf` names its scripts as `B` or `""`.
Each `topScripts` entry also records `sourceURL` and `sourceCharPosition`
(where the entry function starts in that file), and the build writes source
maps next to the lane dist (`<phone dir>/dist/assets/*.js.map`, vite
`build.sourcemap`). Resolve a capture offline:

```
pnpm phone:names .claude/phone-lane/run/captures/<session>
pnpm phone:names <perf.ndjson> --dist <a dist folder>
```

It prints the LoAF scripts by total time as source function, file:line and
the source line, then the stall counts by control mode and by zoom
(`viewHalf` in powers of two), then the stall time by frame phase (below).
Script file names carry the build hash, so a
capture resolves only against the build it was played on: the next
`pnpm phone up` rebuilds `dist/` and the old maps are gone ("rebuilt since?").
Resolve before the next `up`, or copy `dist/` aside first. Code:
`scripts/dev/lane-stall-names.mjs` (no deps; test
`tests/unit/lane-stall-names.test.ts`).

### Which phase of the frame stalled

A lane build times each phase of every frame
(`src/client/debug/perf/lanePhaseTiming.ts`): `performance.now()` marks around
the existing calls add into one preallocated `Float64Array` (no allocation per
frame). The phases, in frame order:

| Phase | What it times |
|---|---|
| `inbound`, `physics`, `mirror` | the game RAF loop (`app/gameRafLoop.ts`): snapshot drain + apply, the prediction step, the render-mirror sync |
| `ships`, `connectors`, `swarm`, `farIcons`, `turretsLit`, `sweep` | `updateEntitySprites` (`render/pixi/worldSpriteUpdater.ts`): ship sprites, the structures' connector web, swarm sprites (structures, drones, rocks, wrecks), far-zoom icons, turret shots + lit scene, the unseen-sprite sweep |
| `projectiles`, `beamsCamera`, `backdrop`, `hudOverlays`, `feedback`, `effects` | the rest of `PixiRenderer.update()` (`render/pixi/framePasses.ts`) |
| `cameraTick`, `fleetOverlay`, `art` | the renderer's Pixi ticker callback (`rendererSetup/initTicker.ts`) |
| `pixiRender` | Pixi's own `app.render` (scene walk, batching, GL calls), bracketed by two lane-only ticker listeners just above and below its priority |

The sums roll at each processed frame where the stall detector measures the
gap; a frame over 30 ms keeps its breakdown, and the stall events carry it as
`phases` (only phases at 0.05 ms or more). `pnpm phone:names` totals the
stall time by phase over `raf_stutter` + `raf_gap` (one event per stall frame;
a `loaf` repeats the same frame), with each phase's share of the stall time
and `(untimed)`: the part of the gap no mark covers (other callbacks, React,
GC, style and layout, compositing, and the GPU, whose work is asynchronous
and shows up only as a later wait). Main-thread renderer only (the phone's
default); the renderer worker never installs it. Off the lane each mark is
one null check and reads no clock.

## Security

A quick tunnel is a public address: anyone who guesses it reaches the gate.

- **Every request needs the key** (page, assets, API, debug routes, WebSocket
  upgrade). `?k=<key>` sets an `eqx_phone` cookie (HttpOnly, Secure,
  SameSite=Lax, 2 days); everything else without it gets 403. Only the
  home-screen icons and favicon are public. The key is 18 random bytes, new
  with each tunnel, compared in constant time.
- **The manifest `start_url` carries the key**, and the manifest is fetched with
  credentials: an iPhone home-screen app has its own cookie jar, separate from
  Safari's, so it must arrive with the key itself.
- Test rooms are off (`EQX_ENABLE_TEST_ROOMS=0`); the `/dev` routes are
  behind the gate.
- Treat the link like a password: anyone with it can play and reach the debug
  routes. `pnpm phone down` (or a new tunnel) revokes it.

## Known limits

- **Google sign-in does not work** on a tunnel address (Google only accepts the
  registered redirect address). Use **Sign in as me (test build)** instead: one
  tap, no password, signs into the owner account (`owner@eqx.test`, "Owner").
  Route `POST /auth/test-signin`, on when `NODE_ENV` is not `production` or the
  lane sets `EQX_TEST_SIGNIN=1`; the button shows on dev and phone-lane builds.
  Each build keeps its own save file, so ships and progress start fresh per build.
- **A new address per tunnel**, so a reinstall after each tunnel restart.
- iPhone Safari has no fullscreen API; installed from the home screen the app
  runs fullscreen.

## Named tunnel (fixed address)

When `<phone dir>/named-tunnel.json` exists, `up` runs that tunnel instead of
a quick tunnel: the address never changes, so the app is installed once.

```json
{ "hostname": "equinox.alecvickers.co.uk",
  "tunnelId": "<id from cloudflared tunnel create>",
  "credentialsFile": "C:\Users\<you>\.cloudflared\<id>.json" }
```

- **Key:** a named tunnel keeps one key for good in `<phone dir>/named-key`
  (made on first use), so `down`, reboots and tunnel restarts keep the same
  link. Delete `named-key` and run `up` to revoke the old link.
- **No file → quick tunnel**, as before. A file that is present but
  incomplete fails `up` loudly rather than falling back to a random address
  (`parseNamedTunnel`, unit-locked).
- **Set-up, done once (2026-11-24):** `cloudflared tunnel login` (the owner
  clicks Authorize on the domain; writes `~/.cloudflared/cert.pem`), then
  `cloudflared tunnel create eqx-phone` (writes the credentials file) and
  `cloudflared tunnel route dns eqx-phone <hostname>` (adds the CNAME). Run
  them with the lane's `cloudflared.exe`.

## Future

**Cloudflare Access** (sign-in as the owner) in front of the named address,
instead of the secret link, needs an API token with Access permissions.
Google sign-in on the fixed address needs the address added as a redirect URI
in the Google console plus `GOOGLE_REDIRECT_URI` in the lane's server env.
