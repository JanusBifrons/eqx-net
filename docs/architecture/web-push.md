# PWA + Web Push — architecture

EQX Peri ships as an installable **Progressive Web App** and uses the **Web Push**
API to notify a player when their base is attacked while they're away. This doc is
the system internals; the player-facing guide is
[docs/features/pwa-and-push-notifications.md](../features/pwa-and-push-notifications.md).

## Why a PWA at all

Push was the goal; the PWA is the prerequisite. On iOS/iPadOS, Web Push **only**
works for a web app the user has **Added to Home Screen** (installed). So to reach
the user's phone we must be an installable PWA: a web manifest + a service worker +
icons. On Android/desktop a service worker alone is enough, but the manifest gives
the installed-app experience everywhere.

## Client: manifest, icons, service worker

All driven by **`vite-plugin-pwa`** (config in `vite.config.ts`):

- **Manifest** is defined in the plugin config (single source of truth — the old
  static `public/manifest.json` was removed). The plugin injects
  `<link rel="manifest" href="/manifest.webmanifest">`.
- **Icons** are generated from one source SVG, `public/pwa-icon.svg` (the in-game
  FIGHTER silhouette in brand green `#00ff88` on `#05070f`), via
  `@vite-pwa/assets-generator`: run `pnpm gen:pwa-assets` to (re)emit
  `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`,
  `apple-touch-icon-180x180.png`, `favicon.ico` into `public/`. These are committed.
- **Service worker** is Workbox `generateSW`, registered explicitly in
  `src/client/main.tsx` (`registerSW({ immediate: true })`, gated on
  `import.meta.env.PROD`).
  - **`registerType: 'prompt'` (NOT `'autoUpdate'`)** — load-bearing. `autoUpdate`
    would force a mid-session reload and risk a new SW serving freshly-hashed
    code-split chunks (incl. the Pixi render worker) that mismatch the running app.
    `prompt` leaves the new SW *waiting*; with no prompt UI it activates on the next
    full launch. → "auto-update, apply on next launch", no mid-combat disruption.
  - **`devOptions.enabled: false`** — the SW exists only in production builds. Both
    Playwright and the netgate run against `vite dev`, so they never see it (no
    precache vs wire-format desync during tests).
  - **`navigateFallbackDenylist`** keeps the SPA navigation fallback off the proxied
    API/WS routes (`/auth`, `/push`, `/galaxy`, …).
  - **Custom push handlers** (`push`, `notificationclick`) live in
    `public/push-sw.js`, imported into the generated SW via
    `workbox.importScripts(['push-sw.js'])` — leaner than `injectManifest`.

The client opt-in helper is `src/client/push/pushClient.ts` (capability detection,
`subscribe` / `unsubscribe`, the pure `shouldOfferPushToggle` gate). The UI is
`src/client/components/PushNotificationToggle.tsx`, shown in both the desktop
`SettingsModal` and the mobile drawer `SettingsTab`. On iOS-not-installed it shows
the "Add to Home Screen" hint instead of a toggle that can't work.

## Server: VAPID, subscriptions, the trigger

Lives under `src/server/push/`:

- **`webPush.ts`** — configures the `web-push` library with the VAPID keys from env
  (`EQX_VAPID_PUBLIC_KEY` / `EQX_VAPID_PRIVATE_KEY`; generate with
  `npx web-push generate-vapid-keys`). When a key is missing, push is **disabled**
  (one boot warning, never a throw — a missing key is not a security hole, just no
  notifications). Exposes `sendWebPush()` (never throws; returns `{ ok, gone }`,
  where `gone` = HTTP 404/410 → prune).
- **`pushSubscriptions.ts`** — DB access. Writes go through the persistence worker
  (`PUSH_SUBSCRIPTION_PUT` / `_DELETE` ops on `IPersistenceSink`); reads use the
  read-only main-thread `node:sqlite` connection. The `push_subscriptions` table
  (see `db/schema.ts`) is keyed on the unique endpoint so a re-subscribe UPSERTs.
  `getUserIdForPlayer` maps a structure-owner `playerId` → account `userId` via
  `player_ships`.
- **`connectedPlayers.ts`** — a refcounted process-global presence registry,
  incremented in `SectorRoom.onJoin` / decremented in `onLeave`. The trigger only
  notifies **offline** owners.
- **`PushNotifier.ts`** — `onStructureAttacked(ownerPlayerId, kind, attackerKind,
  sector)` (scalars; fire-and-forget; never throws into the caller). Async: offline
  gate → playerId→userId → subscriptions → `Promise.allSettled(send)` → prune gone
  endpoints. Deps are injected so the logic is unit-testable without a DB
  (`PushNotifier.test.ts`).
- **`routes/pushRouter.ts`** (mounted at `/push`): `GET /push/vapid-public-key`,
  `POST /push/subscribe`, `POST /push/unsubscribe`. Auth via `Bearer` token →
  `validateToken`; bodies zod-validated.

### The trigger

In `SectorRoom.applyDamage`, co-located with the existing throttled
`structure_attacked` audit emit, a **separate, longer-windowed** throttle
(`STRUCTURE_ATTACK_PUSH_WINDOW_MS = 15 min`) calls
`pushNotifier.onStructureAttacked(...)`. The hot-path cost is one `Map.get`+compare
(alloc-free, invariant #14); the offline gate, DB read, and network send all happen
asynchronously off the tick. A phone alert is therefore rare (≤ once per base per
15 min) and only reaches a genuinely disconnected owner.

## Boundaries

- `web-push` is server-only; the client never imports it.
- The service worker cannot intercept WebSocket / WebRTC traffic — the live game
  loop is untouched by the SW.
- The browser client does not allocate `SharedArrayBuffer` and Vite sets no
  COOP/COEP, so the SW does not interact with cross-origin isolation.

## Testing it end-to-end

The SW is production-only, so build first: `pnpm build:client` then
`pnpm exec vite preview`. Install the PWA, enable the alerts toggle (grant
permission), and confirm a row lands in `push_subscriptions`. To fire a push
without staging a real siege, use the dev script:

```
node scripts/send-test-push.mjs <userId>   # requires EQX_VAPID_* in the environment
```

then attack a structure whose owner is offline to exercise the live trigger.
