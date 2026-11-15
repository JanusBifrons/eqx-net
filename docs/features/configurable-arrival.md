# Configurable hyperspace arrival

**Shipped:** 2026-05-10. Mobile UI; PC keeps the legacy departure-pose default.

## What it does

Before this change, every hyperspace warp landed the ship at the **same x/y** it occupied at commit time — `TransitOrchestrator.commitTransit` read pose from the SAB and stuffed it into the LimboPayload. The destination room's `onJoin` restored that exact pose.

Now the client can optionally specify *where* in the destination sector it wants to arrive. The wire message `EngageTransitSchema` gained an optional `arrival: { x, y }` field; if present, the server uses it (clamped to playable bounds) instead of the SAB pose. Velocity, angle, and angular velocity are still preserved from the departure pose — only the landing point is overridable.

## The three modes (mobile UI)

The Galaxy drawer tab now hosts an "Arrival" section below the **Show galaxy map** button:

| Mode | Behaviour | UI state |
|---|---|---|
| **X/Y** | User-typed coords. On blur, values are clamped to ±`SECTOR_PLAYABLE_HALF_EXTENT` (200,000 with solar-system sectors on, the default; 5,000 with `?solar=0` / `EQX_SOLAR_SECTORS=0`) with a warning toast. | Inputs editable. |
| **Same** | Server falls back to the SAB pose at commit time (legacy default). | Inputs disabled, showing a 5-second snapshot of the local ship's current x/y read from the render mirror. |
| **Home** | Lands at the per-user "home" coord. Today the UI hardcodes this to (0, 0); the value is persisted so a future feature can let the player set their own. | Inputs disabled, showing the home coord. |

The 3-way picker is a `ToggleButtonGroup` (segmented control). PC users see the same UI but the default is `Same`, which sends no `arrival` field — wire-compatible with the pre-change server and behaviourally identical to the legacy path.

## Persistence

Mode + values + home coord are stored in localStorage under the existing `eqxSettings:${userId}` key (per-user scoped via `userPrefs.ts`). The new fields on `PersistedSettings`:

- `arrivalMode: 'xy' | 'same' | 'home'`
- `arrivalTargetX: number`
- `arrivalTargetY: number`
- `homePosX: number`
- `homePosY: number`

All optional in the decoder so existing stored payloads (without these keys) load cleanly.

## Wire & server

- **Schema:** `EngageTransitSchema` (`src/shared-types/messages.ts`) gained `arrival: { x: finite-number, y: finite-number }` as an optional, strict object. Malformed payloads are dropped silently by the standard validation pipeline.
- **Bounds:** `SECTOR_PLAYABLE_HALF_EXTENT` (200,000 by default, 5,000 with solar sectors off) and `clampToSectorBounds(x, y)` live in `src/shared-types/sectorBounds.ts`. Both client (blur clamp + toast) and server (defense-in-depth) use the same helper.
- **Orchestrator:** `TransitOrchestrator.beginTransit(playerId, targetSectorKey, arrival?)` stashes the optional arrival on the in-flight record. `commitTransit` builds the `LimboPayload` x/y from the clamped arrival when present, otherwise from SAB. Velocity, angle, and angvel are always SAB.

## Render-mirror polling — the 5-second snapshot

The "Same" mode display reads the local ship's current x/y from `colyseusClient.mirror.ships.get(localPlayerId)` on a 5-second `setInterval`, gated to only run while the drawer is open AND the Galaxy tab is the active tab. The value is stored in component-local React state — **not** in Zustand — to honour the no-spatial-state-in-Zustand invariant (root CLAUDE.md #2).

Access to the singleton client is via `src/client/net/clientSingleton.ts` (`getGameClient()`), populated once by `App.tsx` after construction. This is a sanctioned low-cadence read path; do not extend it to per-frame data.

## Why this design

**Wire-optional + opt-in UI.** PC has no UI for arrival modes today — its store value stays at `'same'`, which sends `undefined` arrival, which the server interprets as "use departure pose." That's the legacy behaviour, byte-for-byte. Mobile and desktop drawer Galaxy tab both render the picker, but until the user actively changes it, behaviour is unchanged.

**Single bounds constant.** `GalaxySector` in `src/core/galaxy/galaxy.ts` doesn't carry per-sector bounds today. A single constant suffices for now and centralises the value; if per-sector bounds become necessary, widen `clampToSectorBounds` to take a sector key.

**Two clamp paths (UX + defense-in-depth).** Client clamps on blur for instant user feedback (with a toast). Server also clamps every received `arrival` field, so a hostile or buggy client can't land in the void. The two clamps use the same shared helper, so they cannot drift.

## Verification

- Unit tests: `src/shared-types/sectorBounds.test.ts`, `src/shared-types/messages.test.ts` (EngageTransitSchema fuzz), `src/server/transit/TransitOrchestrator.test.ts` (arrival used / clamped / fallback).
- E2E: `tests/e2e/configurable-arrival.spec.ts` covers UI presence, mode-toggle disabled-state, blur clamp + toast, no-toast on in-bounds input, persistence across reload, and desktop visibility.
- Server boot smoke: `timeout 8 pnpm dev:server` clean.

## Future hooks

- "Set as home" button next to the Home pill — committing `setHomePos(currentX, currentY)` and persisting.
- Per-sector bounds: widen `clampToSectorBounds(x, y, sectorKey?)` and pull overrides from `GalaxySector`.
- A `transit_state` cancel reason for "invalid_arrival" if the policy ever moves from silent-clamp to hard-reject.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Configurable arrival picker (2026-05-10)** lives in [layout/Drawer/tabs/GalaxyTab.tsx](../../src/client/layout/Drawer/tabs/GalaxyTab.tsx). 3-mode `ToggleButtonGroup` (`xy` / `same` / `home`) below the "Show galaxy map" button; mode + values persisted via `settingsStorage.ts`. `App.tsx` `handleEngageTransit` reads the mode from Zustand (non-subscribing `useUIStore.getState()`), builds an optional `arrival: { x, y }` (clamped on blur in the picker), and passes it to `engageTransit`. The default `'same'` mode sends `undefined` — wire-compatible with the legacy behaviour, so PC users (no UI flip) are unaffected. The "Same" mode also displays a 5-second snapshot of the local ship's x/y read from the render mirror via `getGameClient()` (sanctioned low-cadence mirror read path; see [net/clientSingleton.ts](../../src/client/net/clientSingleton.ts)). **Do not** extend `getGameClient()` use to per-frame data — Zustand purity #2 still rules. See [docs/features/configurable-arrival.md](configurable-arrival.md).
## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](../architecture/server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Configurable arrival (2026-05-10)**: `EngageTransitSchema` carries an optional, strict `arrival: { x: finite, y: finite }` (`src/shared-types/messages.ts`). When present, `TransitOrchestrator.beginTransit(playerId, target, arrival?)` stashes it on the in-flight record; `commitTransit` writes the LimboPayload's `x/y` from `clampToSectorBounds(arrival.x, arrival.y)` instead of the SAB pose. Velocity, angle, and angvel are **always** SAB — only the landing point is overridable. Bounds: `SECTOR_PLAYABLE_HALF_EXTENT = 5000` in `src/shared-types/sectorBounds.ts`, shared with the client. Server clamp is defense-in-depth; the client also clamps on input blur. Absent `arrival` ⇒ legacy SAB-pose path (regression-locked in `TransitOrchestrator.test.ts`). See [docs/features/configurable-arrival.md](configurable-arrival.md).
