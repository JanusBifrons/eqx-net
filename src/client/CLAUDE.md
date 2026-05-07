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
- **Collision and obstacle changes require E2E test coverage.** Any change to how obstacles or remote ships are synced, reset, or lerped in `ColyseusClient.ts` must be accompanied by a test in `tests/e2e/robustness.spec.ts` that would fail if the change were reverted. Use `data-obstacle-positions` and `data-ship-positions` on the game surface element to observe entity positions from Playwright. The `test-with-logs` fixture provides `getPredStats`, `getEqxLogs`, and `clearEqxLogs` helpers.
- **Remote ships must be in predWorld.** Every entity the local ship can physically collide with must have a rigid body in `predWorld`. Remote ships are spawned via `world.spawnShip()` in `syncMirror()` and reset to `snap.states[remoteId]` before `reconciler.reconcile()` in `handleSnapshot()` — identical to the obstacle pattern. Rendering reads from predWorld + lerp offsets in `updateMirror()`. Do NOT render remote ships from `remoteHistory` (the 100 ms display-delay buffer); that pattern causes collisions to be delayed by ~RTT/2 and corrections to accumulate across hits.
- **Pre-welcome guard in `syncMirror()`.** Colyseus delivers the initial state patch (`onStateChange`) BEFORE the welcome message sets `mirror.localPlayerId`. During this window, `localPlayerId` is `null` and the `playerId !== localId` guard evaluates to `true` for ALL ships — including the joining player's own ship. Any predWorld spawn in the remote-ship branch MUST be gated with `localId !== null` to prevent the local ship from being spawned as a remote body. If it is, `tryInitPredWorld()` finds `hasShip(localId) === true` and exits early without creating the Reconciler, breaking all physics. `tryInitPredWorld()` retrospectively spawns any remote ships that were seen before `localId` was set.

---

## UI Scope

- **React + MUI** is for out-of-game UI and overlays. Phase 8 sub-phase A made the **Galaxy Map the user's first screen post-auth** (replacing the original "Enter Sector Alpha" splash) — see [components/GalaxyMapScreen.tsx](components/GalaxyMapScreen.tsx) and the reusable [components/HexGalaxyMap.tsx](components/HexGalaxyMap.tsx). Sub-phase B added two in-game overlays: [components/GalaxyMapOverlay.tsx](components/GalaxyMapOverlay.tsx) (opened with `M`, neighbour-only transit selection — non-adjacent sectors are dimmed) and [components/HyperspaceOverlay.tsx](components/HyperspaceOverlay.tsx) (spool progress bar + cancel button during SPOOLING; warp-streak background during IN_TRANSIT). Both overlays read from Zustand; transit messages travel over the existing Colyseus room socket via `transitClient.engageTransit(room, key)` / `cancelTransit(room)`. Active-Limbo UX on the landing screen: if the player has a held ship, the `GalaxyMapScreen` queries `/dev/limbo?playerId=` and constrains `selectableKeys` to that single sector with a banner "Resume your ship in [name]".
- **Pixi** is the in-game surface: ships, projectiles, swarms, effects.
- Never mix: don't put MUI inside the Pixi canvas, don't draw HUD numbers with Pixi.

---

## Audio

- **Howler** is the only audio concretion. It lives behind an `IAudio` contract implementation.
- Pitch-shift on Howler sources is the Phase 6 TiDi surface — `howl.rate(serverClockRate)`.
- All SFX are triggered off bus events (`LASER_FIRED`, `ENTITY_DESTROYED`, `ENTITY_WOKE`), never polled.

---

## Client Prediction + Ghost Projectiles

- **Prediction** (Phase 3): the client predicts its own ship by stepping the same `src/core/physics/World` the server uses, then reconciles against authoritative snapshots. Drift ≥ `LERP_THRESHOLD` (0.05 u position / 0.001 rad angle, just above float32 noise) triggers a visual lerp; lerp duration scales with magnitude (3–18 frames). Remote ships interpolated with a 100 ms display-delay buffer.
- **Wall-clock-anchored input loop** (Phase 5 / sub-phase A): `tickPhysics()` derives `targetTick` from `(now − welcomePerfNow) / 16.6667` rather than running a free accumulator with a frame-cap. This is essential on mobile: any main-thread block (touch dispatch, scroll, GPU hiccup) that previously discarded elapsed time beyond 5 frames now produces at most a brief catch-up window — `inputTick` always represents real wall-clock time, so `serverTick` and `inputTick` cannot drift apart. Per-RAF catch-up is capped at `MAX_CATCH_UP_TICKS = 4` to amortise CPU after a long pause. If you re-introduce an accumulator-with-cap, you re-introduce the 30–60 % mobile `corr` regression.
- **Ghost projectiles** (Phase 4): on fire input, immediately spawn a client-only sprite (`GhostManager` in `src/client/combat/GhostProjectile.ts`). On `hit_ack` arrival, call `ghostManager.resolve(clientShotId, hit)` to fade the ghost. TTL 500 ms — if no `hit_ack` arrives, ghost fades automatically. Ghosts never declare destruction server-side.
- **Ghost mirror cleanup**: `GhostManager.update(out)` MUST `out.delete(id)` for any ghost it removes from its internal map (expired or resolved), not just delete from the internal map. `ColyseusClient.syncProjectiles()` deliberately preserves entries with `isGhost: true` during snapshot reconciliation so client-side ghosts survive a server snapshot that doesn't yet know about them — but that means the ghost manager is the **only** code path that can clean up ghost entries from `mirror.projectiles`. If you ever see laser bolts "stuck" at the spawn point or duplicate static sprites alongside the moving one, this contract has been broken. Regression test: [combat/GhostProjectile.test.ts](combat/GhostProjectile.test.ts).
- **Fire input**: `Keyboard.fire` is a one-shot boolean. `read()` returns `fire: this.firePending` and immediately clears `firePending = false`. The keydown handler sets `firePending` only when `!e.repeat` — no hold-fire. `tickPhysics()` calls `sendFire(tick)` when `fire` is true, then the field is already cleared.
- **Forward direction for fire ray**: same as thrust — `(-sin(angle), cos(angle))`. Ray origin offset 20 units ahead of ship centre to avoid self-hit.
- Prediction and ghosts are presentation only. They must not influence authoritative state or be visible to other clients.

---

## Input Throttling Discipline (2026-05-06)

The client may suppress redundant input sends ONLY when both the current and previously-sent input states are **fully idle** (every control bit false). Any held key — thrust, turn, boost — must be re-sent every tick, with an additional 250 ms heartbeat in idle to keep the server's session alive.

Why narrowed to all-idle: when a held input has been throttled, the server's worker re-applies the held state each tick under its synthesised-ack contract (see [src/core/CLAUDE.md](../core/CLAUDE.md) → Input Queue Contract). When the client THEN sends a state change at a tick higher than the synthesised ack, the worker's max-tick-clamp jumps the ack past the intermediate ticks — silently skipping a physics step that the client's local prediction DID apply. On a fast-moving ship this surfaces as a ~8 unit drift per state-change event, with `corr` rate sticking around 20–30 %. Restricting throttling to all-idle frames is safe because held all-idle adds zero impulse — the server skipping a tick is physically equivalent.

**Rule:** any future per-tick stream that adds throttling needs the same audit: when the held state is "active" (changes physics), the server's queue must stay populated. See `docs/LESSONS.md` 2026-05-06 follow-up for the full incident.

## Active weapon selection

`activeWeapon: WeaponId` is in Zustand — it is a discrete UI selection (not a per-frame field), so the purity rule allows it. `Keyboard.ts` binds `1` → hitscan, `2` → laser, `Q` → cycle. `WeaponSelector.tsx` renders the bottom-centre picker boxes. `ColyseusClient.tickPhysics()` reads the active weapon from Zustand each tick to pick the cooldown (`weaponDef.cooldownTicks`) and to clear `liveBeam` when the active mode is `projectile`. `sendFire()` sends `weapon: activeWeapon` to the server and spawns the ghost with the same id so the renderer can pick the right sprite (`buildLaserBoltGfx` for `laser`, beam for `hitscan`). Weapon-id strings are validated server-side via `isWeaponId()` from the catalogue — never trust the client's string blind. Switching mid-fire must clear the hitscan beam: regression covered in [tests/e2e/weapon-switching.spec.ts](../../tests/e2e/weapon-switching.spec.ts).

## Damage numbers and health bars

- `mirror.pendingDamageNumbers` and `mirror.pendingHealthBarHits` are per-frame **drain queues** populated by `ColyseusClient.handleDamage()` and consumed by `PixiRenderer.update()`. They are arrays, not maps — every entry is consumed once per frame.
- `DamageNumberManager` ([render/DamageNumbers.ts](render/DamageNumbers.ts)) spawns floating `-${damage}` text at the hit position (server provides `hitX`/`hitY` in `DamageEvent`; falls back to entity-pose if absent). Pool cap 20, 60-frame lifetime, drifts up and fades.
- `HealthBarManager` ([render/HealthBars.ts](render/HealthBars.ts)) shows a bar above an entity only when the local player has just hit it (`evt.shooterId === localId`). Bar fades after 2 s with no consecutive hits and removes after 2.5 s. Position is read from `mirror.ships` or `mirror.swarm` each frame so the bar tracks moving targets.

## Durable Identity

- `playerId` is persisted in `localStorage` as `eqxPlayerId`. Read at bootstrap, sent in the `identify` handshake.
- Never reuse Colyseus `sessionId` as a durable identifier — it rotates on every reconnect. `playerId` is what lets Phase 8 Limbo reconciliation work.
