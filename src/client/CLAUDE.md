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
- **Every collidable entity must be in predWorld.** This is a load-bearing rule we have re-discovered TWICE (Phase 4 wrecks, Phase 6b lingering hulls — see `docs/LESSONS.md`). The render mirror (`mirror.ships`, `mirror.wrecks`, `mirror.lingeringShips`, future maps) is what the **renderer** reads. The render mirror is NOT what the prediction physics reads. **Any time you add a new entity type that the local player can collide with or shoot, you MUST register a body in predWorld** — mirroring the existing wreck and lingering-hull patterns. The local hitscan ray-test runs against predWorld, not the render mirror; without a body, the player flies through AND shoots through. Pattern: (1) namespace the body id with a prefix (`wreck-`, `linger-`, ...), (2) lazily `predWorld.spawnShip(bodyId, x, y, kind)` once `kind` is known, (3) `setShipState` every snapshot tick to keep the authoritative pose tracked, (4) `despawnShip` when the entity disappears from `mirror.X`, (5) track spawned bodies in a `predXIds: Set<string>` for room-teardown cleanup. Server-side counterpart: the new entity needs to be iterated in BOTH `advanceProjectiles` AND `handleFire`'s hitscan loop, AND `applyDamage` must route the new targetId form. Remote ships are spawned via `world.spawnShip()` in `syncMirror()` and reset to `snap.states[remoteId]` before `reconciler.reconcile()` in `handleSnapshot()` — identical to the obstacle pattern. Rendering reads from predWorld + lerp offsets in `updateMirror()`. Do NOT render remote ships from `remoteHistory` (the 100 ms display-delay buffer); that pattern causes collisions to be delayed by ~RTT/2 and corrections to accumulate across hits.
- **Pre-welcome guard in `syncMirror()`.** Colyseus delivers the initial state patch (`onStateChange`) BEFORE the welcome message sets `mirror.localPlayerId`. During this window, `localPlayerId` is `null` and the `playerId !== localId` guard evaluates to `true` for ALL ships — including the joining player's own ship. Any predWorld spawn in the remote-ship branch MUST be gated with `localId !== null` to prevent the local ship from being spawned as a remote body. If it is, `tryInitPredWorld()` finds `hasShip(localId) === true` and exits early without creating the Reconciler, breaking all physics. `tryInitPredWorld()` retrospectively spawns any remote ships that were seen before `localId` was set.

---

## UI Scope

- **React + MUI** is for out-of-game UI and overlays. Phase 8 sub-phase A made the **Galaxy Map the user's first screen post-auth** (replacing the original "Enter Sector Alpha" splash); the SVG `HexGalaxyMap` was retired in 2026-05-10 in favour of two distinct **Pixi-rendered** maps:
  - **Map A — `GalaxyOverviewScreen`** ([components/GalaxyOverviewScreen.tsx](components/GalaxyOverviewScreen.tsx)) wraps **`GalaxyOverviewRenderer`** ([render/galaxy/GalaxyOverviewRenderer.ts](render/galaxy/GalaxyOverviewRenderer.ts)), which spins up its own `Application` + `pixi-viewport` for full drag/pinch/wheel pan & zoom. Two modes: `'spawn'` is the post-auth landing role (any sector pickable; limbo override forces resume with an in-canvas RESUME pulse and the React-side stats banner kept for E2E parity); `'warp'` is the in-game viewer reached from the drawer's Galaxy tab (only neighbours of the current sector are tappable; non-neighbours render as faint outlines for spatial context). The React-side limbo banner / ship picker / engineering rooms / single-player diagnostic only mount in spawn mode.
  - **Map B — `GalaxyMapLayer`** ([render/galaxy/GalaxyMapLayer.ts](render/galaxy/GalaxyMapLayer.ts)) is a Pixi `Container` attached to the **gameplay canvas's `app.stage`** above the viewport via the new `IRenderer.addOverlayContainer` seam. **Highly transparent** — fills at alpha ~0.30 so gameplay continues fully visible underneath; tap-to-warp on neighbours, faint outlines on non-neighbours, no opaque background. Toggled by the bottom-center [GalaxyMapToggleButton](components/GalaxyMapToggleButton.tsx) ("MAP" — plain styled `<Box component="button">`, **not** nipplejs; nipplejs is the joystick library) and the keyboard `M` shortcut. Layer state is driven by Zustand effects in `GameSurface`: `isGalaxyMapOpen → setVisible`, `currentSectorKey → setCurrentSector`, `transitState → setTransitDocked`. A separate `ResizeObserver` calls `layer.resize(w, h)` on canvas-size changes (the renderer's own observer only resizes the world viewport).
- [components/HyperspaceOverlay.tsx](components/HyperspaceOverlay.tsx) is unchanged: left-edge vertical spool bar with rocket icon, ms-precision countdown, bottom-up green fill, and red abort button during SPOOLING; warp-streak background during IN_TRANSIT. Reads from Zustand; transit messages travel over the existing Colyseus room socket via `transitClient.engageTransit(room, key, arrival?)` / `cancelTransit(room)`. The spool duration is mirrored into Zustand as `transitSpoolMs: number | null` (set by `ColyseusClient`'s `transit_state` SPOOLING handler, cleared on DOCKED/ARRIVED) so the overlay can render an ms-precision countdown without re-deriving timing.
- **Limbo UX**: if the player has a held ship, `GalaxyOverviewScreen` (spawn-mode) queries `/dev/limbo?playerId=` and the renderer constrains `isSelectable` to that single sector with an animated RESUME label drawn directly on the limbo hex; the React banner above the canvas keeps `data-testid="limbo-resume-banner"` + the stats grid for E2E.
- **Configurable arrival picker (2026-05-10)** lives in [layout/Drawer/tabs/GalaxyTab.tsx](layout/Drawer/tabs/GalaxyTab.tsx). 3-mode `ToggleButtonGroup` (`xy` / `same` / `home`) below the "Show galaxy map" button; mode + values persisted via `settingsStorage.ts`. `App.tsx` `handleEngageTransit` reads the mode from Zustand (non-subscribing `useUIStore.getState()`), builds an optional `arrival: { x, y }` (clamped on blur in the picker), and passes it to `engageTransit`. The default `'same'` mode sends `undefined` — wire-compatible with the legacy behaviour, so PC users (no UI flip) are unaffected. The "Same" mode also displays a 5-second snapshot of the local ship's x/y read from the render mirror via `getGameClient()` (sanctioned low-cadence mirror read path; see [net/clientSingleton.ts](net/clientSingleton.ts)). **Do not** extend `getGameClient()` use to per-frame data — Zustand purity #2 still rules. See [docs/features/configurable-arrival.md](../../docs/features/configurable-arrival.md).
- **Pixi** is the in-game surface: ships, projectiles, swarms, effects.
- Never mix: don't put MUI inside the Pixi canvas, don't draw HUD numbers with Pixi.

---

## Sizing default: start tiny, grow on request

When you build any new UI element — modal, panel, card, button, chip — **default to as small as humanly possible**. Especially on mobile. We will iterate it bigger when the user reports it's hard to hit or read; the reverse direction (shipping huge and shrinking back down) wastes review cycles and feels worse.

Concretely:
- Card silhouettes / icons: start ~24–36 px. Don't reach for 64 px without a reason.
- Body text in HUD / overlays / cards: 9–11 px. Captions 8–9 px. Reserve 12+ px for primary CTAs.
- Dialog `maxWidth`: prefer `xs`; only step up to `sm` if content genuinely needs it.
- Padding inside cards / dialogs: `p: 0.5`–`0.75` (4–6 px). Avoid MUI defaults (which are 16–24 px).
- Touch targets that absolutely must be 44 px (iOS HIG) — only fight for that on PRIMARY confirm actions, not every chip.
- Buttons: `size="small"` by default, with `fontSize: 11`.

The bias: it's easier to hear "this is too small, bump it 10 %" than to undo the visual heaviness of a default-sized MUI component cluster. The 2026-05-12 ship-picker rebuild is the canonical example — `maxWidth="sm"` + full kind descriptions + 64 px silhouettes + 22 px stat chips read as "absolutely huge" in playtest; the rebuild dropped to `xs`, 36 px silhouettes, a one-line stat readout, and 11 px buttons.

---

## Layout Slot System (2026-05-10)

In-game React overlays are positioned via **named slot anchors**, never hand-placed. The system lives in [layout/](layout/) — see [docs/features/mobile-layout.md](../../docs/features/mobile-layout.md) for the full story.

- **Anchors are defined in [layout/anchors.ts](layout/anchors.ts).** A 3×3 grid (`top-left` … `bottom-right`) plus two specials (`fullscreen`, `transit`). Adding an anchor is fine; mutating an existing anchor's CSS is a code-review prompt because every widget already depends on it.
- **`--mobile-edge-inset` CSS var** ([index.html](index.html)): default `16px`, bumped to `40px` by `(orientation: landscape) and (pointer: coarse)`. The `bottom-left` and `bottom-right` anchor hosts use it so joystick / fire / boost sit further from the bezel when a phone is held sideways. Other anchors keep `16px` everywhere — they're not thumb-territory.
- **Widgets render into a slot via `<Slot anchor="...">`** ([layout/Slot.tsx](layout/Slot.tsx)). Slots `createPortal` into the matching host element registered by `<LayoutProvider>`. **No widget sets its own `position`, `top/left/right/bottom`, `zIndex`, or safe-area insets** — those are owned by the anchor host. If you find yourself reaching for `position: fixed` in a HUD component, you are bypassing the system.
- **Z-index tokens are in [layout/zIndex.ts](layout/zIndex.ts)** (`Z.canvas` < `Z.hud` < `Z.mobileControls` < `Z.drawer` < `Z.appBar` < `Z.overlay` < `Z.transit`). Anchor hosts pick a tier from this table once; widgets never reference `zIndex` directly.
- **Safe-area insets are baked into the anchor host CSS.** `env(safe-area-inset-*)` and the AppBar height (`var(--app-bar-h, 48px)` set on `:root` in [index.html](index.html)) are applied uniformly. Per-component safe-area maths are obsolete.
- **The `top-*` anchors clear the AppBar automatically.** This used to be a per-widget bug — the original HUD chip cluster paint into the notch on iOS — fixed structurally by the anchor host's `padding-top` calc.
- **Advanced / hidden UI lives in the right-edge `Drawer`** ([layout/Drawer/AdvancedDrawer.tsx](layout/Drawer/AdvancedDrawer.tsx)) with a vertical icon-only tab rail. **The drawer must NOT be a `SwipeableDrawer`** — SwipeableDrawer attaches global touch listeners that fire on every joystick movement and regressed mobile RTT from ~50 ms to ~2.4 s. **`ModalProps.keepMounted` is now ON** (2026-05-13, commit `2aa7d4f`) because Modal cold-mount was the dominant first-open cost — pre-mounting drops CLICK→VISIBLE from ~13.7 s to ~1.22 s; see `docs/LESSONS.md` 2026-05-13 "Drawer perf paradigm". The historic 17 Hz background-render objection still applies to snapshot-rate subscribers in hidden tabs (`tabs/DebugTab.tsx`, `components/ConnectionDiagnostics.tsx`, `components/DevOverlay.tsx`, `components/LogPanel.tsx`) — each MUST gate on `drawerTab === '<id>' && isDrawerOpen` so they pay zero cost when their tab isn't on screen. **Verify the gate exists before adding new snapshot-rate work in any drawer tab.** Adding a new tab: append a `TabSpec { id, label, icon, node, bottom? }` to the `TABS` array in `AdvancedDrawer.tsx`. Tab catalogue today: `galaxy` (top + default-selected), `profile`, `settings`, `debug` (last is sticky-bottom). `isDrawerOpen` and `drawerTab` are discrete UI flags in Zustand, purity-clean. The drawer toggle (`<DrawerToggle>`) is rendered into the `top-right` slot.
- **`HudTestAttributes`** ([components/HudTestAttributes.tsx](components/HudTestAttributes.tsx)) keeps the `data-testid="ship-count"` / `swarm-count` / `clock-rate` / `server-tick-hz` text mirrors in the always-mounted DOM at `display: none`. The real diagnostics now only mount when the drawer's Debug tab is open; the existing E2E suite reads these via `textContent`, so the hidden mirrors are a perf-safe contract surface. Do NOT delete them without auditing every spec that polls those testids.
- **Mobile vs desktop split**: `AppHeader` is hidden via MUI `display: { xs: 'none', sm: 'flex' }` below the `sm` breakpoint (600 px). The `--app-bar-h` CSS var is responsive to match (`0px` below 600 px, `48px` at and above). Mobile users only have the drawer for settings/profile/galaxy/debug; desktop users keep the existing `ProfileModal` + `SettingsModal` paths as well as the drawer. **Do not delete `ProfileModal.tsx`, `SettingsModal.tsx`, or `AvatarMenu.tsx`** — they are the desktop access path.
- **Portrait works by default; landscape is opt-in via the fullscreen toggle.** Portrait playability is the default — slot anchors adapt, no overlay blocks input. The only landscape lock is initiated by the user tapping `<FullscreenToggle>` ([layout/FullscreenToggle.tsx](layout/FullscreenToggle.tsx)), which calls `useFullscreen.enterFullscreen()` → `requestFullscreen()` + best-effort `screen.orientation.lock('landscape')`. `exitFullscreen()` releases the orientation lock first. The toggle is gated by `isTouchDevice()` so it's exclusively a mobile affordance, and auto-hides while in fullscreen / standalone PWA. Manifest declares `orientation: any`. **Do not** reintroduce a first-gesture lock or a portrait-block overlay — both were removed because they made the app user-hostile (forced rotation against the user's grip, blocked legitimate portrait sessions). iOS Safari has no JS API to remove its address bar, so on iOS the toggle opens an "Add to Home Screen" install dialog instead.
- **`useIsCompact()` (`useMediaQuery(theme.breakpoints.down('sm'))`)** and **`isTouchDevice()`** are independent axes — touch on a desktop monitor and pointer on a tablet are real cases. Don't fuse them.
- **Phase machine lives in Zustand** (`phase: 'meta' | 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local'`). Drawer tabs use `useUIStore(s => s.setPhase)` to drive navigation (Settings `Return to menu`, Profile Logout). The initial phase is `meta` for everyone; `?room=…` / `?galaxy=…` URL escape hatches still skip straight to `game` for E2E specs and deep links. The `MetaLandingScreen` is the canonical "main menu" with a `Join the fight!` CTA + a deterministic-but-living fake player count.
- Regression lock: [tests/e2e/layout-slots.spec.ts](../../tests/e2e/layout-slots.spec.ts) covers HUD vs AppBar clearance, HUD vs joystick non-overlap, portrait-keeps-joystick-interactive, mobile AppBar hidden, vertical tab order (galaxy first), debug-tab content gating, MAP-button removal, meta-landing visibility, Return-to-menu flow, Logout confirm.

---

## Audio

- **Howler** is the only audio concretion. It lives behind an `IAudio` contract implementation.
- Pitch-shift on Howler sources is the Phase 6 TiDi surface — `howl.rate(serverClockRate)`.
- All SFX are triggered off bus events (`LASER_FIRED`, `ENTITY_DESTROYED`, `ENTITY_WOKE`), never polled.

---

## Client Prediction + Ghost Projectiles

- **Prediction** (Phase 3): the client predicts its own ship by stepping the same `src/core/physics/World` the server uses, then reconciles against authoritative snapshots. Drift ≥ `LERP_THRESHOLD` (0.05 u position / 0.001 rad angle, just above float32 noise) triggers a visual lerp; lerp duration scales with magnitude (3–18 frames). Remote ships interpolated with a 100 ms display-delay buffer.
- **Drone prediction is reconciled, not just dead-reckoned (chapter 2, 2026-05-09)**: drones run the same `HostileDroneBehaviour` on both sides (`src/core/ai/`); the client constructs its own `AiController` bound to `predWorld.applyImpulse`. Snapshot's `drones[]` slice is the SINGLE source of truth for in-interest drone state — `Reconciler.reconcile()` accepts a `replaySeed.drones` map and re-anchors each drone before replay, then `tickClientAi` runs in `perReplayTick` so drones are re-ticked through the same input window the player is replayed across. The `_droneSnapshotAnchored: Set<number>` field tracks which drones the most recent snapshot anchored; `syncSwarmIntoPredWorld` skips its `predWorld.setShipState` call (and the spring-offset capture) for those drones. Out-of-interest drones (not in the anchor set) fall through to the legacy binary-packet path. **Do NOT reintroduce `setShipState` from the binary swarm packet for in-snapshot drones** — that's the dual-correction-path bug captured in [docs/architecture/ai-lockstep.md](../../docs/architecture/ai-lockstep.md), where snap distance tripled because the snapshot path pulled drones forward and the binary path pulled them back. Regression lock: [tests/e2e/feel-test-lockstep.spec.ts](../../tests/e2e/feel-test-lockstep.spec.ts) — its `swarmSnapP50 < 15` assertion fails the moment two correction paths fight.
- **Wall-clock-anchored input loop** (Phase 5 / sub-phase A): `tickPhysics()` derives `targetTick` from `(now − welcomePerfNow) / 16.6667` rather than running a free accumulator with a frame-cap. This is essential on mobile: any main-thread block (touch dispatch, scroll, GPU hiccup) that previously discarded elapsed time beyond 5 frames now produces at most a brief catch-up window — `inputTick` always represents real wall-clock time, so `serverTick` and `inputTick` cannot drift apart. Per-RAF catch-up is capped at `MAX_CATCH_UP_TICKS = 4` to amortise CPU after a long pause. If you re-introduce an accumulator-with-cap, you re-introduce the 30–60 % mobile `corr` regression.
- **Ghost projectiles** (Phase 4): on fire input, immediately spawn a client-only sprite (`GhostManager` in `src/client/combat/GhostProjectile.ts`). On `hit_ack` arrival, call `ghostManager.resolve(clientShotId, hit)` to fade the ghost. TTL 500 ms — if no `hit_ack` arrives, ghost fades automatically. Ghosts never declare destruction server-side.
- **Ghost mirror cleanup**: `GhostManager.update(out)` MUST `out.delete(id)` for any ghost it removes from its internal map (expired or resolved), not just delete from the internal map. `ColyseusClient.syncProjectiles()` deliberately preserves entries with `isGhost: true` during snapshot reconciliation so client-side ghosts survive a server snapshot that doesn't yet know about them — but that means the ghost manager is the **only** code path that can clean up ghost entries from `mirror.projectiles`. If you ever see laser bolts "stuck" at the spawn point or duplicate static sprites alongside the moving one, this contract has been broken. Regression test: [combat/GhostProjectile.test.ts](combat/GhostProjectile.test.ts).
- **Fire input**: `Keyboard.fire` is a one-shot boolean. `read()` returns `fire: this.firePending` and immediately clears `firePending = false`. The keydown handler sets `firePending` only when `!e.repeat` — no hold-fire. `tickPhysics()` calls `sendFire(tick)` when `fire` is true, then the field is already cleared.
- **Forward direction for fire ray**: same as thrust — `(-sin(angle), cos(angle))`. Ray origin offset 20 units ahead of ship centre to avoid self-hit.
- Prediction and ghosts are presentation only. They must not influence authoritative state or be visible to other clients.
- **Sector handoff resets prediction state.** The `transit_ready` handler hot-swaps the room's WebSocket via `consumeSeatReservation` but reuses the same `ColyseusGameClient` instance. Any state that contributes to the prediction window — Welford RTT (`_rttWelford`), the spring-smoothed `LookaheadController` (`_lookaheadCtrl`), the snapshot drop detector (`_dropDetector`), the clock anchor (`_anchorInitialised` / `clockAnchorServerTick`), the rolling interval/correction buffers, `leadTicks`, and `reconciler.lastRtt` — MUST be re-initialised in `resetPredictionState()` on transit. Surviving state is poisoned by the 5+ s warp gap: clamped-but-still-pushed RTT samples drift the welford mean up, `mean + 2σ` saturates the 30-tick `CEILING_TICKS`, and the client predicts ~600 ms ahead for tens of seconds post-arrival (visible as `srvTick − ackedTick` locked at ~−37, 60–70 % correction rate, ship rendered far from server-authoritative position). Adding new prediction-window-feeding state? Either reset it here or comment why it's safe to inherit. See [docs/LESSONS.md](../../docs/LESSONS.md) 2026-05-09 entry. Lock test: [net/ColyseusClient.resetPredictionState.test.ts](net/ColyseusClient.resetPredictionState.test.ts).

---

## Input Throttling Discipline (2026-05-06)

The client may suppress redundant input sends ONLY when both the current and previously-sent input states are **fully idle** (every control bit false). Any held key — thrust, turn, boost — must be re-sent every tick, with an additional 250 ms heartbeat in idle to keep the server's session alive.

Why narrowed to all-idle: when a held input has been throttled, the server's worker re-applies the held state each tick under its synthesised-ack contract (see [src/core/CLAUDE.md](../core/CLAUDE.md) → Input Queue Contract). When the client THEN sends a state change at a tick higher than the synthesised ack, the worker's max-tick-clamp jumps the ack past the intermediate ticks — silently skipping a physics step that the client's local prediction DID apply. On a fast-moving ship this surfaces as a ~8 unit drift per state-change event, with `corr` rate sticking around 20–30 %. Restricting throttling to all-idle frames is safe because held all-idle adds zero impulse — the server skipping a tick is physically equivalent.

**Rule:** any future per-tick stream that adds throttling needs the same audit: when the held state is "active" (changes physics), the server's queue must stay populated. See `docs/LESSONS.md` 2026-05-06 follow-up for the full incident.

## Active weapon selection

`activeWeapon: WeaponId` is in Zustand — it is a discrete UI selection (not a per-frame field), so the purity rule allows it. `Keyboard.ts` binds `1` → hitscan, `2` → laser, `Q` → cycle. `WeaponSelector.tsx` renders the bottom-centre picker boxes. `ColyseusClient.tickPhysics()` reads the active weapon from Zustand each tick to pick the cooldown (`weaponDef.cooldownTicks`) and to clear `liveBeam` when the active mode is `projectile`. `sendFire()` sends `weapon: activeWeapon` to the server and spawns the ghost with the same id so the renderer can pick the right sprite (`buildLaserBoltGfx` for `laser`, beam for `hitscan`). Weapon-id strings are validated server-side via `isWeaponId()` from the catalogue — never trust the client's string blind. Switching mid-fire must clear the hitscan beam: regression covered in [tests/e2e/weapon-switching.spec.ts](../../tests/e2e/weapon-switching.spec.ts).

## Multi-mount mirror surfaces (Phase 2c–4c, 2026-05-11)

The renderer mirror exposes per-mount data on three surfaces, all keyed by mount id (from the ship-kind catalogue):

- `ShipRenderState.mountAngles?: number[]` — per-mount slewed angle in arc-local frame, indexed by catalogue mount-order. For the **local player**, populated each tick by `ColyseusClient.tickLocalMountAim` (predicted). For **remote players**, populated by the snapshot handler from `snap.states[id].mountAngles` (authoritative). Undefined ⇒ renderer falls back to `baseAngle`.
- `SwarmRenderState.mountAngles?: number[]` — same field on drones. Populated only for **in-interest drones** from `snap.drones[].mountAngles`. Out-of-interest drones leave it undefined and their barrels render at `baseAngle` until they re-enter interest.
- `RenderMirror.liveBeams: Map<mountId, BeamData>` and `RenderMirror.remoteLasers: Map<shooterId, Map<mountId, BeamData>>` — per-mount beam state. The pre-2c single `liveBeam` and flat `remoteLasers` shapes are gone.

**Per-frame `mirror.ships.set()` rebuild MUST preserve `mountAngles`.** The local-ship update in `ColyseusClient.updateMirror()` and the remote-ship update in `syncMirror()` both reconstruct each ship's mirror entry from scratch (predWorld pose + lerp offset). Non-spatial fields need explicit `...(prev?.X ? { X: prev.X } : {})` preservation or they wipe at 60 Hz. The fields currently in this category: `kind`, `displayName`, `mountAngles`. Adding any new non-spatial field to `ShipRenderState`? Add it to BOTH rebuild sites or it disappears silently.

The visible bug when this rule was broken: the local player's interceptor showed two correctly-rotated wing beams via the one-shot ghost projectile path (which carries pre-computed endpoints) but the continuous `liveBeam` rendered straight forward — because the renderer re-derives beam direction from `mirror.ships.get(localId).mountAngles` each frame, and that field was being wiped between `tickLocalMountAim`'s write and the renderer's read.

`MountVisualManager` ([src/client/render/MountVisualManager.ts](render/MountVisualManager.ts)) owns per-mount Pixi `Graphics` (turret sprite + dotted aim line). One cluster per ship sprite (player AND drone), pooled across the ship's lifetime. The `applyMountAngles(shipId, mounts, angles?)` method updates rotations each frame; undefined `angles` snaps every mount to baseAngle. Renderer despawn path calls `removeShip(shipId)` to free the cluster.

`BARREL_LENGTH = 20` deliberately matches the 20 u server-side self-hit clearance in `SectorRoom.handleFire`/`handleAiFire` so beams emerge from the *visible* barrel tip. Don't change one without the other.

The aim-line preview is drawn as a dotted chain (Pixi v8 `Graphics` has no native dashed stroke — we draw short segments manually). 500 u long, `6 u on / 4 u off`, alpha 0.25. The dash chain rotates with the parent mount container; no per-frame redraw.

See [docs/architecture/weapon-mounts.md](../../docs/architecture/weapon-mounts.md) for the call-graph and the "do not add a second correction path" rule.

## Damage numbers and health bars

- `mirror.pendingDamageNumbers` and `mirror.pendingHealthBarHits` are per-frame **drain queues** populated by `ColyseusClient.handleDamage()` and consumed by `PixiRenderer.update()`. They are arrays, not maps — every entry is consumed once per frame.
- `DamageNumberManager` ([render/DamageNumbers.ts](render/DamageNumbers.ts)) spawns floating `-${damage}` text at the hit position (server provides `hitX`/`hitY` in `DamageEvent`; falls back to entity-pose if absent). Pool cap 20, 60-frame lifetime, drifts up and fades.
- `HealthBarManager` ([render/HealthBars.ts](render/HealthBars.ts)) shows a bar above an entity only when the local player has just hit it (`evt.shooterId === localId`). Bar fades after 2 s with no consecutive hits and removes after 2.5 s. Position is read from `mirror.ships` or `mirror.swarm` each frame so the bar tracks moving targets.

## Durable Identity

- `playerId` is persisted in `localStorage` as `eqxPlayerId`. Read at bootstrap, sent in the `identify` handshake.
- Never reuse Colyseus `sessionId` as a durable identifier — it rotates on every reconnect. `playerId` is what lets Phase 8 Limbo reconciliation work.

---

## Phase 5 — In-game roster access (2026-05-13)

The drawer's Galaxy tab ([layout/Drawer/tabs/GalaxyTab.tsx](layout/Drawer/tabs/GalaxyTab.tsx)) mounts `<ShipRosterPanel>` above the existing configurable-arrival picker, so players can switch ships **mid-game** without disconnecting to the post-auth galaxy map. Spawn-from-card routes through `engageTransit(room, sectorKey, arrival?, shipId)` — the new optional `shipId` arg is on the wire schema and the destination room's existing Phase 3 `JoinOptionsSchema.shipId` path hydrates the named roster entry on arrival. The drawer closes on submit so the `HyperspaceOverlay` is visible.

`ShipDetailModal` ([components/ShipDetailModal.tsx](components/ShipDetailModal.tsx)) gates abandon-on-active-ship behind a **second-tier confirm** dialog with copy "This is your active ship — abandoning will eject you to the galaxy map. Continue?" The non-active path is unchanged (single confirm). The confirm dialog is conditionally rendered (not just `open={false}`) so its `data-testid` disappears from the DOM on Cancel — important for E2E and component-test assertions.

`RosterCountBadge` ([components/RosterCountBadge.tsx](components/RosterCountBadge.tsx)) lives next to `DrawerToggle` and reads the roster count from a Zustand singleton. Visual states via `data-state` attribute: `empty` (muted grey), `normal` (default green), `full` (red at 10/10) — surface the affordance without loud UI clutter at 0/10. Test lock: [components/RosterCountBadge.test.tsx](components/RosterCountBadge.test.tsx).

**Roster source-of-truth is the Zustand singleton** (`shipRoster: RosterEntry[]` in `state/store.ts`). `ShipRosterPanel` owns the `/dev/player-ships` poll loop but writes results into `setShipRoster`, so multiple panel mounts (galaxy-map landing + drawer Galaxy tab) keep `RosterCountBadge` and any other consumer in lockstep without each mount running its own consumer-local state. The roster-fetch dedupe (single-fetch-on-player-id-known) is a follow-up; today each panel polls every 3 s independently — wasted bandwidth at worst, never inconsistent.

**Test layers** (introduced for Phase 5):
- `vitest` `*.test.tsx` files run under `jsdom` (per-file env via `vitest.config.ts` `environmentMatchGlobs`); `*.test.ts` continues to run under `node` (server logic, schemas, helpers).
- `@testing-library/react` + `@testing-library/jest-dom` for component assertions. Matchers registered in `vitest.setup.ts` (dynamic-imported only when `typeof document !== 'undefined'` so node-env tests don't pay the cost).
- `@testing-library/user-event` available for keyboard/text-input flows when needed; the existing Phase 5 tests use `fireEvent.click` for button activations.
- `fast-check` is installed for property-based testing of pure functions (use when the surface naturally benefits — Phase 6 has more candidates than Phase 5).
- `@colyseus/testing` is installed for in-process room integration tests; the version pinned in `package.json` reports a peer-dep mismatch (0.17.x vs colyseus 0.16) — re-pin to 0.16-compat when Phase 6b lands and actually exercises it.
- `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` are installed for mutation testing; configuration deferred until Phase 6 ships (the suite needs stable tests to mutate).

---

## Phase A3 — Renderer decision logic extraction (2026-05-13)

Per-entity sprite-update decisions (create / rebuild / reposition / skip) live in `src/client/render/spriteUpdateDecisions.ts` as pure functions, NOT inlined inside `PixiRenderer.ts`. The Pixi calls (Graphics instantiation, `addChild`, `tint`, `alpha`, `destroy`) stay in the renderer; only the branching lives in the pure module.

**Why**: the Phase 6b "lingering hull permanently invisible" bug was a too-aggressive `if (!ship.kind) continue;` skip in the renderer that left the sprite uncreated forever when the schema diff with `kind` arrived late. A unit test on a pure decision helper would have failed loudly: "no cache + unknown kind should `create` with the fallback kind, not `skip`." The extraction makes that contract explicit and testable.

**The rule**: when you add a new entity-update method on the renderer (`updateXxx` taking `RenderMirror`), the per-entity decision logic MUST live in `spriteUpdateDecisions.ts` with unit tests covering every branch + a property-based test (fast-check, already installed). Don't inline new decision branches in `PixiRenderer.ts`.

Current functions:
- `decideLingeringSpriteAction({ cached, currentKind, fallbackKind })` — Phase 6b lingering hulls. Falls back to `fallbackKind` when `currentKind` is undefined and there's no cache hit (don't lock in the wrong silhouette but also don't go invisible).
- `decideWreckSpriteAction({ cached, currentKind })` — Phase 4 wrecks. Surfaces a `skip` with a `reason` when `currentKind` is unexpectedly missing (server wire-format break diagnostic).

Tests: `src/client/render/spriteUpdateDecisions.test.ts` (12 cases incl. fast-check properties).

---

## Phase 6a foundation (2026-05-13)

`SnapshotMessage.states` is now keyed by `shipInstanceId` on the wire (was `playerId` pre-6a) and each entry carries `playerId` + `isActive` so the client can recover owner identity + skip lingering hulls. **The mirror, predWorld, and reconciler remain playerId-keyed internally** — `ColyseusClient.handleSnapshot` translates the wire format to a playerId-keyed local view at the top of the function (C-ii strategy). Render / HUD / radar code is unchanged. `isActive === false` entries (Phase 6b lingering hulls — not yet emitted by the server) are filtered out at the translation boundary so they're invisible to existing snapshot-apply logic until 6b chooses to surface them. The server's `state.ships` MapSchema also stays keyed by playerId in 6a; only `SnapshotMessage` and the future Phase 6b schema-rekey use shipInstanceId as the key.
