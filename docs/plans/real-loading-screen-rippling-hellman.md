# Plan: Real loading screen + dispose-audit + sector-pick responsiveness

## Context

User's smoke capture `2026-05-30T20-40-44Z-7cm12w` (Pixi-heap-bisect HEAD) reproduced the wb1al4 cascade locally: at 100.5 s the user died, clicked Respawn on the galaxy map (`galaxy_sector_click {mode: 'spawn'}`), and ~20 s later the heap peaked at 76 MB while RAF Hz cratered from 90 → 33. The hostility-reframe ("phone is overwhelmed, not leaking") fits exactly — non-linear heap acceleration, synchronous RAF drop, threshold cascade.

While reviewing the trigger, three user-facing defects were identified:

1. **The load curtain is purely cosmetic.** `WarpFilterChain.ts:144 setLoadCurtain()` just tweens an alpha overlay. Behind it the Pixi ticker runs, `tickPhysics` runs every RAF, `updateMirror` runs, input flows, damage lands, HUD updates. The user sees their X/Y changing through the "loading" screen, and drones can kill them through it.
2. **Death/respawn is completely untracked in diagnostics.** Zero `logEvent('died' | 'respawn' | …)` calls anywhere in the client.
3. **Dispose audit is incomplete.** `ColyseusGameClient.dispose()` (line 4276) clears 14 fields but misses 20+ surfaces. When GameSurface remounts after respawn, the OLD instance can stay alive via any leaked subscription/timer, doubling retention — the proximate cause of the 20 s post-respawn cascade.

A separate concern raised mid-research:

4. **Sector-pick on the spawn screen feels ~1 s sluggish.** Not an E2E-test artefact — `PICKER_OPEN_DELAY_MS = 200 ms` was added in commit `41117cfc` (2026-05-12) to fix a real on-device touch-bleed bug. But the MUI `<Dialog>` `Grow` transition (~225 ms default) on top of that is unjustified polish — dropping it shaves ~225 ms with zero risk.

**Outcome**: the user can no longer be killed during loading, the cascade 20 s after respawn does not fire, the picker feels snappy.

---

## Hostile review — issues incorporated below

Hostile review found 6 release blockers + 5 data-integrity must-fixes. All addressed in the revised commits below. Key changes from initial draft:

- **Curtain rendering moves to React/DOM** (was: Pixi-ticker-driven; would freeze when ticker paused). Stays inside Pixi for the warp-IN burst (which only fires on arrival, never during pause).
- **`unloadComplete=true` ownership site**: exactly one — the WarpScreen's `useEffect` listening to `useGameReady() === true` flips it. Documented + tested.
- **Server grace = 300 ticks (5 s)** to match the curtain duration. testMode default = 0 (so existing one-tick-kill specs pass unchanged).
- **`Howler.ctx.close()` removed**; replaced with `Howler.unload()` (per-Howl instance unload, leaves global context reusable).
- **Damage events queue (not drop) during curtain**, drain after curtain lift.
- **Kill-switch (`?loading=cosmetic`) moves to Commit 1** so it's verifiable BEFORE Commit 4 wires gates.
- **RAF re-arm is mandatory** on the early-return path (explicit code shape in the plan).
- **`setGameClient(null)` ordering flipped** (null before dispose).
- **Dispose-audit test uses runtime reflection** over `mirror` properties (not a hand-maintained list).
- **Bus subscription audit** added to Commit 6.
- **HUD gate carve-outs**: `HyperspaceOverlay` renders during transit even when loading; `HudTestAttributes` keeps its mirror (E2E contract) but gated stale-value E2E specs are listed for audit.

---

## Implementation order (7 commits, each independently revertible)

### Commit 1 — `feat(state): loading-state foundation + kill-switch (no behaviour change)`

Foundation. Adds the state surfaces + the URL kill-switch, but wires NO physics/input/HUD gating yet — verifiable in isolation.

**Files**:
- `src/client/state/store.ts`:
  - Add `unloadComplete: boolean` (default `true`) + `setUnloadComplete(b)` setter.
  - Add `localPoseResolved: boolean` (default `false`) + setter.
  - Add `damageEventQueue: Array<DeferredDamageEvent>` (default `[]`) + push/drain helpers.
  - Add `maxProgressSeen: number` (default `0`) + setter (used by `computeWarpProgress` for monotonicity).
  - Add `loadingCosmeticOnly: boolean` field — set ONCE at session start from `?loading=cosmetic` URL param.
  - Extend `commonReadinessRearm` to: reset `unloadComplete=true`, `localPoseResolved=false`, `maxProgressSeen=0`, drain `damageEventQueue.length=0`.
  - Export pure functions:
    - `computeGameReadyFromState(s)` — mirrors `useGameReady` for non-React callers.
    - `selectIsLoadingActive(s)` — returns `false` if `s.loadingCosmeticOnly` (kill switch), else `phase === 'connecting' || (phase === 'game' && !computeGameReadyFromState(s)) || !s.unloadComplete`.
    - `computeWarpProgress(s) → number` — returns `Math.max(s.maxProgressSeen, rawProgress(s))` for monotonicity.
  - Export hooks: `useIsLoadingActive()`, `useShouldRenderHud()`.
- `src/client/state/storeTypes.ts` — type additions.
- `src/client/net/ColyseusClient.ts` — `tryInitPredWorld` flips `localPoseResolved=true` (idempotent).
- `src/client/components/WarpScreen.tsx`:
  - Switch to `useIsLoadingActive()` + `computeWarpProgress`.
  - **OWNERSHIP SITE for `unloadComplete=true`**: a `useEffect([useGameReady() && phase === 'game'])` that calls `setUnloadComplete(true)` when game becomes ready. This is the SINGLE place that flips it back. Documented inline with a load-bearing comment.
  - Add timeout fallback: if loading-active for > 30 s, force `setUnloadComplete(true)` + log `respawn_loading_timeout` event. Prevents stuck-curtain on broken connect-flow.
  - Tick `setMaxProgressSeen(currentProgress)` on each render so monotonicity holds.
- `src/client/App.tsx:172 handleRespawn` — call `setUnloadComplete(false)` BEFORE `setDead(false)`. Guard against double-click via a `respawnInFlight: boolean` Zustand flag (set at click, cleared at `gameReady=true`).
- `src/client/app/appHooks.ts useShipSwapDispatcher` — call `setUnloadComplete(false)` before `setPhase('connecting')`. The WarpScreen's `useEffect` flips it back when game is ready in the new sector.
- `src/client/main.tsx` (entry) — parse `?loading=cosmetic` at boot, set `loadingCosmeticOnly` once. Log `loading_cosmetic_kill_switch_active` console.warn if set.

**`computeWarpProgress` weight table** (sum = 100):

| Gate | Weight | Cumulative |
|---|---:|---:|
| `connectionStatus === 'connected'` | 15 | 15 |
| `localShipInstanceId !== null` | 20 | 35 |
| `firstSnapshotApplied` | 20 | 55 |
| `localPoseResolved` (new) | 10 | 65 |
| `rendererFirstFrameRendered` | 15 | 80 |
| `joinMinimumElapsed` (5 s floor) | 20 | 100 |

**UX trade-off acknowledged**: real-gates progress can stall at 80 % for ~4.8 s on a fast LAN connection. To soften, the WarpScreen secondary text below the bar animates a `…` ellipsis at 2 Hz so the screen still feels alive even while the bar is held.

**Tests**:
- `src/client/state/store.loadingState.test.ts` — selector truth table; `selectIsLoadingActive` returns false under kill-switch regardless of other flags; `commonReadinessRearm` resets all new flags.
- `src/client/state/store.warpProgress.test.ts` — weight table; monotonic (regressing inputs don't lower output); sums to 100; `maxProgressSeen` latch works across re-renders.
- `src/client/state/store.killSwitch.test.ts` — `loadingCosmeticOnly=true` forces `selectIsLoadingActive=false`.
- `src/client/components/WarpScreen.progress.test.tsx` — text mirror matches `computeWarpProgress(state)`; 30 s timeout fallback triggers `setUnloadComplete(true)`.
- `src/client/components/WarpScreen.ownership.test.tsx` — verifies the useEffect that flips `unloadComplete=true` when `useGameReady()=true && phase==='game'`. Tests the SINGLE-OWNERSHIP-SITE contract.
- Extend `src/client/components/WarpScreen.transit.test.tsx` — transit flow correctly cycles `unloadComplete` false→true.
- `src/client/components/respawnDoubleClick.test.tsx` — second handleRespawn within 50 ms is a no-op (guarded by `respawnInFlight`).

---

### Commit 2 — `feat(server): spawn invulnerability grace (DEFAULT_GRACE_TICKS=300, testMode default 0)`

Ship before the client gate so even partial rollout protects from drone-shots-during-loading.

**Critical change from initial draft: grace = 300 ticks (5 s) to MATCH the client curtain duration.** Eliminates the 4 s window where the player would be server-vulnerable while client-occluded.

**Files**:
- `src/server/rooms/SectorRoom.ts:142 JoinOptionsSchema` — add `gracePeriodTicks: z.number().int().min(0).max(600).optional()`.
- `src/server/rooms/SectorRoom.ts` constants section — `DEFAULT_GRACE_TICKS = 300` (5 s @ 60 Hz, matches curtain).
- `src/server/rooms/schema/SectorState.ts` (or wherever ShipState lives) — add `invulnerableUntilTick: number` (default 0). Non-`@type` decorated; not broadcast on Colyseus schema diff.
- `src/server/rooms/SectorRoom.ts:1943 onJoin` (after worker SPAWN command at line 2403):
  ```ts
  const requestedGrace = parsed.success ? parsed.data.gracePeriodTicks : undefined;
  // testMode default = 0 so existing one-tick-kill specs (initialHull=1)
  // continue to pass without explicit gracePeriodTicks:0 override.
  // Production default = DEFAULT_GRACE_TICKS (5 s).
  const graceTicks = requestedGrace ?? (this.testMode ? 0 : DEFAULT_GRACE_TICKS);
  ship.invulnerableUntilTick = this.serverTick + graceTicks;
  ```
- `src/server/rooms/RespawnHandler.ts:88` — after `ship.alive = true`:
  ```ts
  // Respawn ALWAYS gets DEFAULT_GRACE_TICKS regardless of testMode — a
  // dying-and-respawning ship in a test still needs a window to receive
  // the respawn_ack before being shot again. testMode tests that need
  // instant respawn-kill use the explicit gracePeriodTicks: 0 join opt.
  ship.invulnerableUntilTick = d.serverTick() + DEFAULT_GRACE_TICKS;
  ```
- `src/server/rooms/DamageRouter.ts:182-213` — at the top of the **active-ship** branch (after `if (!ship.alive) return;`):
  ```ts
  if (d.serverTick() < ship.invulnerableUntilTick) {
    d.serverLogEvent('damage_skipped_grace', { targetId, shooterId, damage, untilTick: ship.invulnerableUntilTick });
    return;
  }
  ```
  **Do NOT mirror to the lingering branch** — lingering hulls don't go through `onJoin` and never get grace set (`invulnerableUntilTick = 0`), so the check is meaningless there (caught by hostile review §11.5).
- `src/shared-types/messages/snapshotMessages.ts` — additive optional `graceUntilServerTick?: number` on WelcomeMessage (older clients ignore; newer clients tolerant of `undefined` via `(graceUntilServerTick ?? 0) > currentTick`).

**Living World bots**: spawned via `spawnLivingWorldBot` (different code path), NOT through `onJoin`. **Bots do NOT receive grace.** Documented as accepted risk — PvB balance complaints route to director-level fix.

**Tests**:
- `tests/integration/sectorRoom/respawnGrace.test.ts` — full scenarios:
  - Fresh spawn → fire at ship → assert health unchanged → advance 300 ticks → fire → assert damage lands.
  - JoinOption `gracePeriodTicks: 0` override → instant damage works.
  - testMode default = 0 (existing one-tick-kill spec compat).
  - Respawn ALWAYS gets DEFAULT_GRACE regardless of testMode (because grace is critical for the respawn handshake).
- `tests/integration/sectorRoom/rammingDuringGrace.test.ts` — Ramming.ts batches → applyDamage → DamageRouter.apply → assert grace gates the ram damage.
- Audit + verify existing tests pass:
  - `tests/e2e/scenarios/combat-lifecycle.spec.ts` — uses `initialHull: 1` for one-tick-kill. testMode default 0 keeps these green.
  - `tests/e2e/persistence-kill.spec.ts` — same.
  - `tests/e2e/held-fire-continuous-damage.spec.ts` — must work post-respawn grace.

---

### Commit 3 — `feat(diag): death/respawn/loading lifecycle events`

Observability before behaviour change.

**Files**:
- `src/client/net/ColyseusClient.ts:1828 killEntity` — when `id === localPlayerId`: `logEvent('local_died', { shooterId, msSinceWelcome, lastHull, lastShield, atX, atY })`. Store `this.diedAtMs = clock.now()`.
- `src/client/App.tsx:172 handleRespawn` — `logEvent('respawn_clicked', { msFromDied })`.
- `src/client/state/store.ts setUnloadComplete` setter — `logEvent('respawn_unload_started')` on false transition; `logEvent('respawn_unload_complete', { msSinceStarted })` on true transition.
- `src/client/app/gameSurfaceConnectFlow.ts` enter — `logEvent('respawn_join_started', { roomName, sectorKey })`.
- `src/client/net/ColyseusClient.ts handleWelcome` — `logEvent('respawn_welcomed', { msSinceJoinStarted, shipInstanceId, graceUntilTick })`.
- `firstSnapshotApplied` setter — `logEvent('respawn_first_snapshot', { msSinceWelcomed })`.
- Existing `pixi_first_frame` — extend payload with `msSinceFirstSnapshot`.
- `gameReady → true` edge (`App.tsx` join-chain effect) — `logEvent('respawn_ready', { msSinceClicked, breakdown: {unloadMs, joinMs, welcomeMs, snapshotMs, frameMs, floorWaitMs} })`.
- `WarpScreen` timeout fallback (commit 1) — `logEvent('respawn_loading_timeout', { stuckAtPct, stuckAtGate })`.
- Server `DamageRouter.ts` — `damage_skipped_grace` (formalised here from commit 2).

All discrete-lifecycle events fire even with `?diag=0` per `src/client/CLAUDE.md` policy.

**Tests**:
- `src/client/net/ColyseusClient.lifecycleEvents.test.ts` — assert each tag fires exactly once per simulated death→respawn cycle, payload shape correct, ordering preserved.

---

### Commit 4 — `feat(client): pause boundary — RAF, input, audio, damage gates`

**RELEASE-BLOCKER FIX from hostile review §2.2**: do NOT pause the Pixi ticker (would freeze the warp curtain animation that lives on the same ticker). Instead:
- Skip the GAME WORK inside the RAF (tickPhysics, updateMirror, renderer.update) via early-return.
- Let the Pixi ticker keep running so the WarpFilterChain's per-tick `runTick` can advance the curtain alpha tween.
- The Pixi ticker's per-frame cost without `renderer.update(mirror)` is ~1ms — acceptable for the loading window.

**Files**:
- `src/client/app/gameRafLoop.ts`:
  ```ts
  const loop = (now: number): void => {
    if (isDisposed()) return;
    if (selectIsLoadingActive(useUIStore.getState())) {
      // PAUSED PATH — early return BEFORE doing any game work.
      // CRITICAL: re-arm the RAF chain. Without this the loop dies.
      // CRITICAL: do NOT update lastFrameTime — keeps post-resume deltaMs from being a 5s monster.
      // CRITICAL: do NOT call setTickerMaxFPS(null) — the Pixi ticker drives the warp curtain alpha tween.
      animFrameRef.current = requestAnimationFrame(loop);
      return;
    }
    // ── Active path unchanged ──
    ...
  };
  ```
- `src/client/input/Keyboard.ts`:
  - Add `private enabled = true; setEnabled(b: boolean): void { this.enabled = b; if (!b) { this.thrust = false; this.turnLeft = false; this.turnRight = false; this.boost = false; this.reverse = false; this.spaceDown = false; } }`.
  - On `setEnabled(true)`, all held bools are ALREADY ZEROED from the disable call — user must press fresh key for thrust (fixes "auto-thrust on lift" from hostile review §2.3).
  - `read()` early-returns `IDLE` if `!this.enabled`.
  - DOM listeners stay attached (so a press during disabled is captured + masked).
- `src/client/input/TouchInput.ts` — same `setEnabled` pattern; on disable zero out `vector`, `_fireHeld`, `_boostHeld`.
- `src/client/audio/HowlerAudioService.ts`:
  - Add `suspendAll(): Promise<void> { return Howler.ctx?.suspend?.().catch(() => {}) ?? Promise.resolve(); }`.
  - Add `resumeAll(): Promise<void> { return Howler.ctx?.resume?.().catch(() => {}) ?? Promise.resolve(); }`.
  - **DO NOT call `Howler.ctx?.close?.()` in dispose** — Howler context is GLOBAL and `close()` is IRREVERSIBLE. Subsequent service instances would have no audio.
  - `dispose()` instead: per-Howl `.unload()` (releases each sound's buffers) and clear the `sounds` map. Howler context stays alive for the next service instance.
- `src/core/contracts/IAudio.ts` — extend interface with `suspendAll/resumeAll`. `dispose` already exists.
- `src/client/App.tsx GameSurface` — `useEffect([isLoadingActive])` capturing the prior value:
  - On loading-active → true: `audio.suspendAll()`, `keyboard.setEnabled(false)`, `touchInput?.setEnabled(false)`.
  - On loading-active → false: `audio.resumeAll()`, `keyboard.setEnabled(true)`, `touchInput?.setEnabled(true)`, drain `damageEventQueue` so suppressed damages apply now.
- `src/client/net/ColyseusClient.ts:1725 handleDamage`:
  ```ts
  if (evt.targetId === localId && isLoadingActiveFromState()) {
    // Defer — drain in App.tsx GameSurface effect on loading→ready transition.
    useUIStore.getState().pushDeferredDamage(evt);
    return;
  }
  ```
  Drain on loading-lift applies queued damages in order, which the server-grace makes a no-op for any damage that landed during grace; only post-grace damages (4-5 s window between curtain lift and grace end would have been vulnerable — but commit 2's 300-tick grace closes that gap).

**Kill switch (verified in Commit 1 — re-confirmed here)**:
`?loading=cosmetic` URL param → `selectIsLoadingActive` returns false. Loading screen renders cosmetically but no gates engage. Legacy behaviour. Pre-rollout safety net.

**Tests**:
- `src/client/input/Keyboard.setEnabled.test.ts` — `read()` returns IDLE when disabled; held bools zeroed on disable; user must re-press after enable.
- `src/client/app/gameRafLoop.pause.test.ts` — inject `isLoadingActive=true` getter, drive loop, assert `tickPhysics`/`updateMirror`/`renderer.update` not called; assert `requestAnimationFrame(loop)` IS called (RAF chain alive); assert `lastFrameTime` unchanged on skip.
- `src/client/audio/HowlerAudioService.dispose.test.ts` — verify `Howler.ctx?.close` is NOT called; verify next `new HowlerAudioService()` instance can play sounds.
- `src/client/net/ColyseusClient.deferDamage.test.ts` — damage during loading queued; drained on lift in order.
- `tests/e2e/loading-screen.spec.ts` (new):
  - Invulnerable-during-curtain: spawn → die → respawn → during curtain assert no damage events processed locally.
  - Input-dropped: during curtain send keyboard W + Space → assert no `input` event reaches server (poll `/dev/events`).
  - RAF chain alive: assert RAF count advances during curtain (via `data-raf-count` attribute).
  - Curtain animation continues: assert curtain alpha tweens to peak during loading.
  - Kill-switch verification: `?loading=cosmetic` → curtain renders but ship is vulnerable + input flows.

---

### Commit 5 — `feat(client): hide HUD during loading (useShouldRenderHud) + carve-outs`

Touches many files but each is a one-line gate. Fixes the user's "I can see my X/Y updating during the curtain" complaint.

**Files (each component returns `null` when `useShouldRenderHud()` is false)**:
- `src/client/components/SectorInfoPanel.tsx` — hides X/Y + sector name.
- `src/client/components/ShieldHullBar.tsx`
- `src/client/components/Hud.tsx`
- `src/client/components/ShipStatsCard.tsx` — hides speed.
- `src/client/components/WeaponSelector.tsx`
- `src/client/components/MobileControls.tsx` — joystick + fire button.
- `src/client/components/GalaxyMapToggleButton.tsx`
- `src/client/components/RosterCountBadge.tsx` — reads Zustand (added per hostile review §5.5).
- `src/client/layout/Drawer/DrawerToggle.tsx`
- `src/client/layout/FullscreenToggle.tsx` — reads Zustand (added per hostile review §5.5).

**Carve-outs (intentionally STAY visible)**:
- `WarpScreen` — the loading screen itself.
- `DeathOverlay` — its own gate (`isDead`).
  - **Tie-break rule (hostile review §5.2)**: if both `isDead && isLoadingActive` are true (player dies during a re-loading curtain), WarpScreen wins by z-index. DeathOverlay re-shows when curtain lifts.
- `LostConnectionOverlay` — must be visible during loading if connection drops.
- `HudTestAttributes` — E2E mirror, always-on by contract.
  - **E2E spec audit (hostile review §5.1)**: confirmed via grep — no existing spec polls `ship-count`/`swarm-count`/`shield-pct`/`hull-pct` DURING the loading curtain window. The specs that poll these (`feel-test-lockstep.spec.ts`, `swarm-tidi*.spec.ts`) all wait for `gameReady` first via `waitForFunction` on `data-pred-stats`. Documented as a contract: future specs must NOT poll these testids before `gameReady=true`.
- `HyperspaceOverlay` — **CARVE-OUT (hostile review §5.4)**: gated by `transitState !== 'DOCKED'` only. During a transit, `isLoadingActive` is true but HyperspaceOverlay must render to show the spool bar + countdown. Internal gate:
  ```ts
  const transitState = useUIStore(s => s.transitState);
  const showHud = useShouldRenderHud();
  // HyperspaceOverlay renders during transit even when loading-active.
  if (!showHud && transitState === 'DOCKED') return null;
  ```

**Slot anchors** stay mounted (cheap portal hosts); only children unmount. Slot ordering preserved by the anchor host's CSS `order` property — does not depend on mount timing.

**Tests**:
- Per-component unit tests asserting `null` when `useShouldRenderHud=false`.
- `tests/e2e/loading-screen.spec.ts` extension:
  - During curtain, `data-testid` NOT in DOM for: `sector-info-panel`, `ship-stats-card`, `weapon-selector`, `mobile-joystick`, `mobile-fire`, `galaxy-map-toggle`, `roster-count-badge`, `drawer-toggle`.
  - DeathOverlay disappears within 50 ms of Respawn click (gap-fix verification).
  - Transit case: `data-testid="hyperspace-overlay"` IS in DOM during a transit even though curtain is up.
- `tests/integration/hudTestAttributes-during-loading.test.tsx` — render HudTestAttributes with Zustand in loading state, confirm the values are accessible (not removed) for the contract.

---

### Commit 6 — `fix(client): complete dispose audit + audio ownership + GameSurface cleanup`

The leak fix. The proximate cause of the 20 s post-respawn cascade.

**Files**:

#### `src/client/net/ColyseusClient.ts:4276 dispose()` — full audit

```ts
dispose(): void {
  this.disposed = true;
  this.localDead = false;
  useUIStore.getState().setDead(false);
  this.keyboard = null;
  this.touchInput = null;

  // ── Outbound transport teardown ──────────────────────────────────
  if (this._dataChannelTransport) {
    this._dataChannelTransport.close('client-dispose');
    this._dataChannelTransport = null;
  }
  this.room?.leave();
  this.room = null;

  // ── Pending state drain (must precede subsystem dispose) ────────
  this._pendingStateForSync = null;
  this.snapshotCoalescer.dispose?.();         // new method

  // ── Subsystem disposes (order: deepest dependents first) ────────
  this.transitInstr.dispose?.();              // new method
  this.rafStallDetector.dispose?.();          // new method
  this.hudDispatcher.dispose?.();             // new method — cancels pending dispatch RAF
  this.ghostManager.dispose?.();              // new method — clears ghosts map
  this._aiController.clear?.();               // new method — wipes hostility maps

  // ── Bus subscriptions audit (hostile review §6.5) ───────────────
  // ColyseusGameClient subscribes to: this._busUnsubs.push(bus.on(...)).
  // ALL handlers MUST be tracked in this._busUnsubs and unsubscribed here.
  for (const unsub of this._busUnsubs) unsub();
  this._busUnsubs.length = 0;

  // ── PredWorld + reconciler ──────────────────────────────────────
  this.predWorld?.dispose();
  this.predWorld = null;
  this.reconciler = null;

  // ── Maps + Sets cleanup (combat surfaces) ───────────────────────
  this._damageFlashFrames.clear();
  this._scheduledDamageSpawns.length = 0;
  this.remoteHistory.clear();
  this.predRemoteShipIds.clear();
  this._remoteShipOffsets.clear();
  this.predSwarmKeys.clear();

  // ── Mirror — full clear via reflection-based walk ──────────────
  this.clearMirror();  // see helper below

  // ── Stats reset ─────────────────────────────────────────────────
  this._rttWelford = null;
  this._lookaheadCtrl = null;
  this._dropDetector = null;
  this._swarmBinaryEwma = null;
  this.lastSentInputState = null;
  this.lastSentInputAtMs = 0;
  this._anchorInitialised = false;
  this._localPoseResolvedLogged = false;

  // ── Audio reference released (GameSurface owns lifecycle) ──────
  this.audio = null;

  logEvent('dispose_complete', { mirrorSnapshot: this.snapshotMirrorSizesForLog() });
}

/**
 * Reflection-based mirror clear — walks every property and clears
 * Maps/Sets/Arrays generically (hostile review §6.4). Future mirror
 * additions don't need a code change; future test additions verify
 * the new field gets cleared by the same walk.
 */
private clearMirror(): void {
  const m = this.mirror as Record<string, unknown>;
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (v instanceof Map) v.clear();
    else if (v instanceof Set) v.clear();
    else if (Array.isArray(v)) v.length = 0;
  }
}
```

**Track Bus subscriptions** — add to ColyseusGameClient constructor:
```ts
private _busUnsubs: Array<() => void> = [];
// Every bus.on(...) call MUST push its unsubscribe handle:
this._busUnsubs.push(bus.on('LASER_FIRED', this.handleLaserFired));
```

#### `src/client/App.tsx:319 GameSurface cleanup` — dispose ordering fix

**Hostile review §6.1**: `setGameClient(null)` MUST happen BEFORE `gameClient.dispose()` (between the two there's a window where consumers get a disposed client). Hostile review §6.2: renderer disposes BEFORE audio (effects subsystem fires audio events during shutdown; audio must be alive).

```ts
return () => {
  disposed = true;
  cancelAnimationFrame(animFrameRef.current);
  window.removeEventListener('keydown', onKey);
  layerRO.disconnect();
  setGameClient(null);                        // 1. Null singleton FIRST
  keyboard.dispose();
  touchInputRef.current?.dispose?.();         // new
  renderer.dispose();                         // 2. Renderer (drains effects → may fire bus → audio still alive)
  audioRef.current?.dispose?.();              // 3. Audio AFTER renderer
  galaxyLayerRef.current = null;
  gameClient.dispose();                       // 4. Client last
};
```

#### Other dispose methods (additive)

- `src/client/audio/HowlerAudioService.ts dispose()`:
  ```ts
  dispose(): void {
    for (const h of Object.values(this.sounds)) h.unload();
    this.sounds = {};
    // Do NOT close Howler.ctx — global state, irreversible.
    // The next HowlerAudioService instance reuses it.
  }
  ```
- `src/client/combat/GhostProjectile.ts GhostManager.dispose()`: `this.ghosts.clear()`.
- `src/client/state/HudDispatcher.ts dispose()`: cancel any pending RAF/timeout, null `_lastDispatched`.
- `src/client/net/SnapshotCoalescer.ts dispose()`: null pending refs, set `disposed=true`.
- `src/client/debug/TransitInstrumentation.ts dispose()`: reset marker array.
- `src/client/debug/RafStallDetector.ts dispose()`: cancel RAF + clear observers.
- `src/core/ai/AiController.ts clear()`: wipe `hostileTo` + `lastFireTick` maps.

**Tests**:
- `tests/unit/colyseusClient.disposeAudit.test.ts` (new):
  - Construct client.
  - Reflection: enumerate every Map/Set/Array on `mirror` and `client` — populate with sentinel values.
  - Call `dispose()`.
  - Reflection: re-enumerate, assert every Map.size === 0, every Set.size === 0, every Array.length === 0, every singleton ref null.
  - Adding any new mirror field automatically participates — test never goes stale.
- `tests/unit/colyseusClient.busUnsub.test.ts` — mock `bus`, verify all subscriptions added during construction are unsubscribed on dispose.
- `tests/unit/HowlerAudioService.dispose.test.ts` — assert `Howler.ctx.close` NEVER called; assert `Howler.ctx.state === 'running'` post-dispose; assert next instance can play.
- `tests/e2e/respawn-memory-stability.spec.ts` (new):
  - Spawn → die → respawn 5× (full round-trip).
  - Tighter budget: assert `mirror.ships.size`, `mirror.swarm.size` are bounded between cycles (not heap-MB-based which is noise-prone — per hostile review §7.2).
  - Assert `raf_gap > 100 ms` count in steady-state window is 0.
  - Compare cycle 1 vs cycle 5 — no monotonic growth in `pendingX` queue sizes.

**Verification**: capture a fresh smoke after merge and compare to `7cm12w` — the 90→33 Hz cascade at +20 s should be absent; the 284 stutters in 30 s should drop < 50.

---

### Commit 7 — `perf(ui): drop MUI Dialog animation on ShipPickerModal`

Quick win. Reduces sector-pick perceived lag by ~225 ms.

**Files**:
- `src/client/components/ShipPickerModal.tsx:40-47` — add `transitionDuration={{ enter: 0, exit: 0 }}` to the `<Dialog>` props.

**Do NOT touch `PICKER_OPEN_DELAY_MS = 200`** at `GalaxyOverviewScreen.tsx:29` — added in commit `41117cfc` (2026-05-12) to fix a real on-device touch-bleed bug. Load-bearing.

**Tests**:
- `src/client/components/ShipPickerModal.transitionless.test.tsx` — render Modal with `open={true}`, assert immediate DOM presence (no animation frame wait).
- Existing E2E `drawer-galaxy-overview-spawn.spec.ts` continues to pass (faster).

---

## Critical files reference

| File | Purpose |
|---|---|
| `src/client/state/store.ts` | selectors, `unloadComplete`, `localPoseResolved`, `damageEventQueue`, `maxProgressSeen`, `loadingCosmeticOnly`, `respawnInFlight` |
| `src/client/components/WarpScreen.tsx` | **SINGLE ownership site** for `setUnloadComplete(true)`; 30 s timeout fallback |
| `src/client/app/gameRafLoop.ts` | early-return with RAF re-arm |
| `src/client/App.tsx` | handleRespawn double-click guard; GameSurface cleanup ordering (setGameClient null FIRST; renderer before audio) |
| `src/client/net/ColyseusClient.ts` | reflection-based dispose; bus unsub tracking; deferred damage queue; `local_died` log; `diedAtMs` |
| `src/client/input/Keyboard.ts` + `TouchInput.ts` | `setEnabled(b)` — zero held bools on disable (prevents auto-thrust on lift) |
| `src/client/audio/HowlerAudioService.ts` | suspend/resume with promise rejection catch; dispose unloads Howl instances but DOES NOT close global Howler.ctx |
| `src/client/combat/GhostProjectile.ts` | `dispose()` |
| `src/client/components/{SectorInfoPanel,ShieldHullBar,Hud,ShipStatsCard,WeaponSelector,MobileControls,GalaxyMapToggleButton,RosterCountBadge}.tsx` | `useShouldRenderHud()` gate |
| `src/client/components/HyperspaceOverlay.tsx` | carve-out — render during transit even if loading |
| `src/client/layout/Drawer/DrawerToggle.tsx` + `src/client/layout/FullscreenToggle.tsx` | `useShouldRenderHud()` gate |
| `src/client/components/ShipPickerModal.tsx` | `transitionDuration={{enter:0,exit:0}}` |
| `src/client/main.tsx` | `?loading=cosmetic` parse at boot |
| `src/server/rooms/SectorRoom.ts` | `gracePeriodTicks` schema, `DEFAULT_GRACE_TICKS = 300`, `onJoin` sets `invulnerableUntilTick` |
| `src/server/rooms/RespawnHandler.ts` | always sets `invulnerableUntilTick` to DEFAULT_GRACE_TICKS regardless of testMode |
| `src/server/rooms/DamageRouter.ts` | grace gate in active-ship branch only |
| `src/server/rooms/schema/SectorState.ts` | `invulnerableUntilTick` field on ShipState (non-`@type`) |
| `src/shared-types/messages/snapshotMessages.ts` | optional `graceUntilServerTick` on WelcomeMessage |

## Reusable existing utilities

- `PixiRenderer.setTickerMaxFPS(null)` — NOT used by this plan (would freeze warp curtain animation).
- `JOIN_BROADCAST_GRACE_TICKS = 300` — pattern for `DEFAULT_GRACE_TICKS`.
- Test-mode primitives (`initialHull`, `startHostile`) — pattern for `gracePeriodTicks`.
- `commonReadinessRearm` in `store.ts` — extend with new flags.
- `EffectsService.resetForSectorHandoff` — pattern for sector-handoff cleanup.

---

## Verification

### Inner loop (after each commit)
```
pnpm typecheck && pnpm lint && pnpm test --reporter=dot
```

### Heap-delta locks (commit 6)
```
pnpm test:gc -- tests/unit/colyseusClient.disposeAudit.test.ts
```

### E2E (after commits 4, 5, 6)
```
pnpm e2e --project=feature tests/e2e/loading-screen.spec.ts --reporter=line
pnpm e2e --project=feature tests/e2e/respawn-memory-stability.spec.ts --reporter=line
pnpm e2e --project=feature tests/integration/sectorRoom/respawnGrace.test.ts --reporter=line
pnpm e2e --project=feature tests/integration/sectorRoom/rammingDuringGrace.test.ts --reporter=line
```

### Existing-spec regression check (after commit 2)
Run + verify pass without modification:
```
pnpm e2e --project=smoke tests/e2e/scenarios/combat-lifecycle.spec.ts --reporter=line
pnpm e2e --project=smoke tests/e2e/persistence-kill.spec.ts --reporter=line
pnpm e2e --project=feature tests/e2e/held-fire-continuous-damage.spec.ts --reporter=line
```

### On-device smoke verification (final, after commit 6)
1. Boot dev server + client.
2. Manual: play 30 s → die → respawn → play 60 s → die → respawn → play 30 s. Save autocapture.
3. Compare to baseline `2026-05-30T20-40-44Z-7cm12w`:
   - **Heap @ 150 s post-respawn**: was 76 MB peak; expect ≤ 60 MB.
   - **RAF Hz @ 150-180 s window**: was mean 50 Hz; expect ≥ 75 Hz.
   - **Stutter count 30 s window post-respawn**: was 284 lost frames over 11.9 s; expect < 50.
   - **Loading screen behaviour**: visually confirm joystick + fire button + HUD chips HIDDEN during curtain; ship cannot be damaged; X/Y not visible; curtain alpha visibly animates to peak (not frozen).
   - **No auto-thrust on lift**: hold W → die → respawn → curtain lifts → assert ship does NOT thrust.
   - **Transit during loading**: warp to a new sector → assert HyperspaceOverlay spool bar visible during transit.
4. Verify sector-pick feel: tap a sector hex from the spawn screen → modal should appear in ≤ 230 ms (was ~430 ms with the MUI Grow transition).

### Kill-switch verification (Commit 1 — pre-rollout safety check)
```
http://localhost:5173/?loading=cosmetic
```
Restores legacy curtain-only behaviour (no pause). Test by manually firing during the curtain and confirming ship takes damage.

---

## Risks + rollback

| Risk | Mitigation |
|---|---|
| **Transit regression** — `transit_ready` re-arm path shares `commonReadinessRearm` | Extended `WarpScreen.transit.test.tsx`; HyperspaceOverlay explicit carve-out; smoke-test a transit between commit 1 and commit 4 merges. |
| **Ship-swap (200 ms) regression** | `useShipSwapDispatcher` wired in commit 1 (`setUnloadComplete(false)`); flips back via WarpScreen's `useGameReady` effect. |
| **WelcomeMessage schema break for older clients** | `graceUntilServerTick` OPTIONAL; old clients ignore. Newer clients on older servers see `undefined` — `(undefined ?? 0) < currentTick` is false (no grace assumed), safe. |
| **iOS Safari audio context suspend missing** | `?.suspend?.().catch(() => {})` guards (commit 4). Audio keeps playing — non-fatal. |
| **First-frame race after pause** — `firstFrameRendered` latch could fire on a paused frame | Latch only sets inside the active-path branch of `gameRafLoop`. Asserted by `gameRafLoop.pause.test.ts`. |
| **`gracePeriodTicks=300` (5 s) perceived as cheating in PvP** | 5 s is the curtain duration; can wait it out. Configurable per-room via `gracePeriodTicks` join option. PvP-specific rooms can opt down. |
| **Removing MUI animation feels jarring** | Subjective; revert by removing `transitionDuration` override (commit 7 is independent). |
| **Progress-bar visibly stalls at 80%** (UX trade-off) | Acknowledged. Animated `…` ellipsis in status text below bar keeps screen alive. Documented as accepted trade-off — replaces "fake-smooth, but lying" with "truthful, may pause". |
| **Real `Howler.ctx` shared across instances** | Confirmed: Howler is a global; dispose unloads Howl instances but never closes the context. Test asserts this contract. |
| **Curtain Pixi-ticker dependency** (hostile review §2.2) | Pixi ticker is NOT paused. Game-work inside the RAF is skipped instead. Curtain alpha tweens normally. Verified by E2E asserting curtain reaches peak alpha during loading. |

### Rollback paths
- **Commit 4 destabilises**: URL kill-switch `?loading=cosmetic` restores legacy curtain-only behaviour. Tested in Commit 1.
- **Any commit destabilises**: `git revert <hash>`.
- **Commit graph dependencies**: Commit 1 (state foundation) is the base. Commits 2 (server grace), 3 (diag), 7 (Dialog) are independent and skippable. Commits 4 (gate) and 5 (HUD gate) depend on Commit 1's selectors. Commit 6 (dispose) depends on nothing.
- **Safe revert order**: `git revert <7> <6> <5> <4> <3> <2>` returns to current behaviour; `<1>` can stay (its added state surfaces are unused without 4/5).

### Explicitly accepted risks (documented)
- **Living World bots NOT invulnerable on spawn**: bots use a different code path (`spawnLivingWorldBot`, not `onJoin`). PvB balance route via director-level fix if complaints surface.
- **`graceUntilServerTick` wire field is decorative initially**: HUD chip showing "INVULNERABLE FOR N TICKS" is a follow-up if user feedback requests it.
- **Asteroid bounce during grace applies**: asteroid → no damage to fresh ship, but collision response (velocity bounce) still applies. Acceptable.
- **Progress-bar visible stall at 80% on fast LAN**: real-gates progress reveals where loading is bottlenecked. Status text below names the gate. Animated `…` keeps the screen alive.
