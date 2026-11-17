# Phone link (play a build on your phone from anywhere)

The phone lane serves a **production build** of any checkout through a
**Cloudflare quick tunnel**, behind a **secret-link gate**, so the owner can
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
- **No heavy queue:** a lane `up` is one `vite build` plus a server, started
  on request while the owner waits; it is not on the heavy-job list.

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
  registered redirect address). Use email sign-in or *Continue as guest*.
- **A new address per tunnel**, so a reinstall after each tunnel restart.
- iPhone Safari has no fullscreen API; installed from the home screen the app
  runs fullscreen.

## Future

A **named tunnel** on an owned domain gives a fixed address (install once) and
**Cloudflare Access** (sign-in as the owner) instead of the secret link. It
needs a domain on a Cloudflare account; `cloudflared` and the gate stay.
