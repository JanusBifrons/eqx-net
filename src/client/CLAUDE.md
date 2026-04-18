# CLAUDE.md — src/client (Eyes and Ears)

`src/client` is everything the player sees and hears. It is **not** the source of truth — the server is. The client's job is to make latency invisible through prediction (Phase 3) and ghost projectiles (Phase 4), while deferring to server reality whenever the two disagree.

Read the root [CLAUDE.md](../../CLAUDE.md) for project-wide invariants before editing.

---

## Forbidden Imports (CI-enforced)

Never import from `src/client/`:

- Server-only networking: `colyseus` (the *server* Colyseus package; use `colyseus.js`)
- `@colyseus/ws-transport`
- Persistence / Node-only APIs: `better-sqlite3`, `express`, `pino`, `worker_threads`, `node:worker_threads`, `fs`, `node:fs`, `http`, `node:http`
- Anything under `src/server/**`

Allowed: `colyseus.js`, `react`, `react-dom`, `@mui/material`, `@emotion/*`, `pixi.js` v8, `pixi-viewport`, `howler`, `zustand`, `src/core`, `src/shared-types`.

---

## Zustand Purity (invariant #2, strictly enforced)

**No spatial fields may live in the Zustand store.** This is the single most important client-side rule.

- Forbidden keys (lint-blocked in `src/client/state/store.ts`): `x`, `y`, `vx`, `vy`, `angle`, `rotation`, `position`, `velocity`.
- What Zustand *is* for: `connectionStatus`, `sectorName`, `hullPct`, `ammo`, `sectorAlert`, `playerId`, dev-overlay toggles, HUD flags.
- What Zustand is *not* for: anything that updates every frame.

Why: Zustand triggers React re-renders on subscription changes. Putting per-frame spatial data in Zustand would cause 60 Hz React re-renders, which is a performance catastrophe. Spatial state lives in a plain-object render mirror that Pixi polls directly — no React involvement.

---

## Renderer Rules

- `PixiRenderer` implements `IRenderer` from `src/core/contracts/`.
- The renderer **polls** the state mirror every frame. It **never** subscribes to the event bus for positions. Lint blocks `bus.on` imports inside `src/client/render/`.
- Camera (`pixi-viewport`) follows the local ship. No global-space UI overlay in Pixi — HUD elements are React/MUI outside the Pixi surface.

---

## UI Scope

- **React + MUI** is for out-of-game UI: splash, join screen, Galaxy Map (Phase 9), hyperspace spool-up (Phase 8), HUD readouts driven by Zustand.
- **Pixi** is the in-game surface: ships, projectiles, swarms, effects.
- Never mix: don't put MUI inside the Pixi canvas, don't draw HUD numbers with Pixi.

---

## Audio

- **Howler** is the only audio concretion. It lives behind an `IAudio` contract implementation.
- Pitch-shift on Howler sources is the Phase 6 TiDi surface — `howl.rate(serverClockRate)`.
- All SFX are triggered off bus events (`LASER_FIRED`, `ENTITY_DESTROYED`, `ENTITY_WOKE`), never polled.

---

## Client Prediction + Ghost Projectiles

- **Prediction** (Phase 3): the client predicts its own ship by stepping the same `src/core/physics/World` the server uses, then reconciles against authoritative snapshots. Drift ≥ 2 units → 5-frame lerp. Remote ships interpolated with a 100 ms display-delay buffer.
- **Ghost projectiles** (Phase 4): on fire input, immediately spawn a client-only sprite and play SFX. Match to authoritative projectile by `clientShotId` when it arrives; fade ghost, fade authoritative in. Ghosts never declare destruction — that is server-authoritative.
- Prediction and ghosts are presentation only. They must not influence authoritative state or be visible to other clients.

---

## Durable Identity

- `playerId` is persisted in `localStorage` as `eqxPlayerId`. Read at bootstrap, sent in the `identify` handshake.
- Never reuse Colyseus `sessionId` as a durable identifier — it rotates on every reconnect. `playerId` is what lets Phase 8 Limbo reconciliation work.
