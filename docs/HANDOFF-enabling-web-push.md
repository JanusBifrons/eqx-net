# HANDOFF — Enabling Web Push (the on-device step)

**Status (2026-06-17):** The PWA + Web Push feature is **code-complete and merged-pending in PR #93**. What's left is *turning push on in a real environment* — and that's deliberately **not done yet** (owner's call). This doc is the step-by-step so it can be picked up later without re-deriving anything.

Nothing here changes code. It's an **ops / on-device** procedure.

---

## Why there's a separate step at all

Push can't be exercised in the normal dev loop (LAN `vite dev` on your phone). It needs three things that only exist in a production-like setup:

1. **A service worker** — the background script that receives a push and shows the notification. It's **production-build-only on purpose** (so it never pollutes the test suite / netgate). `vite dev` ships none.
2. **HTTPS** — browsers only allow service workers + push over a secure connection. `http://<lan-ip>` is *not* secure, so a phone won't even register the worker. (Desktop `localhost` is the one exception.)
3. **VAPID keys** — a one-time crypto key pair proving "this server may push to this device." Without them the browser refuses to subscribe and the server can't send.

So the recipe is **VAPID keys + a production build + served over HTTPS**.

---

## Steps

### 1. Generate the VAPID keys (once, ~1 min)

```
npx web-push generate-vapid-keys
```

Put the two values in the **server's** environment (`.env` locally, or your host's env settings — see `.env.example`):

```
EQX_VAPID_PUBLIC_KEY=<the public key it prints>
EQX_VAPID_PRIVATE_KEY=<the private key it prints>
# optional contact, mailto: or https URL
EQX_VAPID_SUBJECT=mailto:you@example.com
```

*Why:* the server signs every push with the private key; the browser got the public key when it subscribed and verifies the signature. Until both are set, the server logs `Web Push DISABLED` and the in-app toggle reports "not configured." **The private key is a secret — never commit it.**

### 2. Serve it over HTTPS (pick the path that fits)

- **A — Real deployment (cleanest):** set the two env vars on the server, deploy the latest client build. It's already HTTPS; you're done with infra.
- **B — Test on your phone from your machine:** build the client, run client + server locally, and expose them through a tunnel (`cloudflared tunnel --url …` or `ngrok`) so the phone gets an `https://…` URL pointing at your box.
- **C — Quickest functional test (desktop, no HTTPS):** desktop `localhost` counts as a secure context, so a local production build works there — **but** the dev proxy that bridges client→server (`/push`, `/auth`, the WebSocket) only runs under `vite dev`, not `vite preview`. To make `pnpm build:client && pnpm exec vite preview` fully work locally you'd add a `preview` proxy to `vite.config.ts` (mirroring `server.proxy`). **This is not wired yet** — it's the one small code follow-up that makes local end-to-end testing painless. (Offered but deferred; do it first if you choose path C.)

### 3. Build the client (paths B/C only)

```
pnpm build:client
```

*Why:* this is the step that actually emits the service worker (`dist/client/sw.js`) — it doesn't exist in dev.

### 4. On the device: install, then enable

1. Open the HTTPS URL.
2. **Install it:** iPhone/iPad Safari → Share → **Add to Home Screen**; Android Chrome → **Install app**. Then **open it from the new home-screen icon**.
3. Log in → **Settings → Base-attack alerts** → toggle on → **Allow** when the browser asks.

*Why install (especially iOS):* Apple only delivers push to an installed home-screen app, never a Safari tab. (The toggle shows an "Add to Home Screen" hint until you install.)

### 5. Verify it fires

- **Fast check (no siege needed):** with the server env keys set,
  ```
  node scripts/send-test-push.mjs <yourUserId>
  ```
  sends a test "Base under attack" to your subscribed device(s) — proves the whole subscribe → store → send chain.
- **Real path:** have one of your bases attacked **while you're disconnected** (the trigger only notifies offline owners, throttled to once per base per 15 min).

---

## Handoff checklist

- [ ] VAPID keys generated and set on the server (`EQX_VAPID_PUBLIC_KEY` + `EQX_VAPID_PRIVATE_KEY`).
- [ ] Server boots without the `Web Push DISABLED` warning; `GET /push/vapid-public-key` returns the key + `enabled: true`.
- [ ] Client served over HTTPS (deploy / tunnel / desktop-localhost).
- [ ] PWA installed on the test device; **Base-attack alerts** toggled on; permission granted.
- [ ] `scripts/send-test-push.mjs <userId>` delivers a notification to the device.
- [ ] Live trigger confirmed: an offline-owned base under attack produces a "Base under attack" notification.
- [ ] (Optional, path C) `preview` proxy added to `vite.config.ts` for painless local end-to-end testing.

## References

- Internals: [docs/architecture/web-push.md](architecture/web-push.md)
- Player guide: [docs/features/pwa-and-push-notifications.md](features/pwa-and-push-notifications.md)
- Env vars: [.env.example](../.env.example)
- Test-send script: [scripts/send-test-push.mjs](../scripts/send-test-push.mjs)
