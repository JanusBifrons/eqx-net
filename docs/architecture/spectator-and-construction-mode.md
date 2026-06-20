# Spectator / Construction Mode (Equinox Phase 4, WS-A1)

Spectator mode is the macro-level "view + build without an active ship" state.
On the local ship's death the client transitions **instantly** into spectator —
no death modal, no curtain — and the player free-roams the whole sector as an
invulnerable, un-networked local camera with **full construction** (place /
manage / upgrade / deconstruct structures). This *is* "construction mode."

This document covers the WS-A1 deliverable: the spectator state machine, the
free-roam camera, the input swap, and construction without a ship. Re-entering a
ship by clicking an owned ship's in-world overlay (the "Pilot" action) + the
smooth camera lerp is **WS-A2** and lands separately.

## Locked design decisions (authoritative)

- **D3.** On ship death, transition **instantly into spectator — no death
  modal**. The old blocking `DeathOverlay` "You Died / Respawn" path is removed.
- **D4.** In spectator the camera **detaches and free-roams the whole sector**
  (drag + WASD-disabled pan, wheel/pinch zoom) and the player has **full
  construction** with no ship.
- **D5.** The spectator is a **local camera only**: invulnerable, **not
  networked**, invisible to other players. No wire / netgate cost. The player's
  structures are still attacked while they watch.
- **D7.** A **pilot↔spectator toggle** lives on the speed-dial.

## The discrete flag (Invariant #2 safe)

`pilotMode: 'pilot' | 'spectator'` is the single discrete enum in the Zustand
store (`storeTypes.ts`). It carries **no spatial data** — the free-roam camera
pose lives entirely in the renderer's `Camera`, never the store. `setPilotMode`
is the one setter; the death transition and the speed-dial toggle are its only
writers.

```
death (local ship)  ─┐
speed-dial toggle    ─┼─►  setPilotMode('spectator')  ──►  renderer.setSpectator(true)
                      │                                      Keyboard/Touch setEnabled(false)
toggle / fresh join  ─┴─►  setPilotMode('pilot')       ──►  renderer.setSpectator(false)
```

## Death → spectator (D3)

`ColyseusClient.killEntity(localId)` (the client-local destroy path) flips
`pilotMode='spectator'` via the pure `shouldEnterSpectatorOnDeath(destroyedId,
localPlayerId)` guard (`src/client/spectator/spectatorMode.ts`) — only the LOCAL
ship's death triggers it; a remote death never changes the local mode. `isDead`
is **intentionally not set** (it used to gate the modal); the dial + build UI
stay live so the player builds immediately.

The blocking `DeathOverlay` component is deleted. `RespawnHandler` (server) is no
longer on the player-facing death path — the server already only sets
`ship.alive=false` on death and leaves the player roomed (it never required a
respawn message to keep the session); the in-place revive there is preserved for
engineering-room E2E specs. Re-entry to a ship is via the galaxy map or (WS-A2)
an owned ship's in-world Pilot action.

`pilotMode` resets to `'pilot'` on `ColyseusGameClient.dispose()` (a fresh
GameSurface mount / new join builds a new client), so spectator never crosses a
room boundary.

## Free-roam camera

The renderer already pans/zooms the gameplay `Camera` from the canvas
pointer/wheel path (drag-pan, wheel + pinch zoom) — the **same** code the galaxy
selector free-pan uses. The only thing that pins the camera to the ship is the
per-frame `camera.follow({ ship pose })` re-issue in `PixiRenderer.update()`.

`IRenderer.setSpectator(active)`:
- `true` → `camera.follow(null)` (detach) **and** `update()` stops re-issuing the
  local-ship follow (`if (local && !this._spectator)`), so the camera holds
  wherever the player panned it (and there may be no local ship at all).
- `false` → restores follow-the-local-ship.

No new pointer/wheel routing is needed — free-roam is just "stop following." The
worker path mirrors this via the `SET_SPECTATOR` protocol message
(`mainToWorker.ts` → `renderer.worker.ts` → `PixiRenderer.setSpectator`).

App.tsx drives it off `pilotMode` with a one-line effect:
`rendererRef.current?.setSpectator(pilotMode === 'spectator')`.

## Input swap (pan, not thrust/fire)

A spectator has no ship to steer or fire. The App.tsx loading-pause effect is
extended: `Keyboard` + `TouchInput` are `setEnabled(false)` when
`isLoadingActive || spectating`. With input disabled, WASD/Space produce no
thrust/fire intent, while the canvas pointer/wheel path (untouched by the gate)
keeps panning/zooming the camera — so the same surface becomes "pan/zoom only."
The held thumb cluster (`MobileControls`) and the `AutoFireToggleButton` also
hide while spectating.

## Construction without an active ship (D4)

`place_structure` (and `remove_structure` / future `upgrade_structure`) are pure
client→server messages keyed by `sessionToPlayer.get(sessionId)` — **the server
never requires an active ship to place**. The only ship-coupling was client-side:

1. The placement-preview ghost in `ColyseusClient.updateMirror` is built inside
   the local-ship branch and anchored AHEAD of the ship. After death there's no
   local ship, so a **separate spectator block** sets
   `mirror.pendingPlacementPreview` from a zeroed placeholder pose.
2. The renderer re-anchors that ghost to the **camera centre** via the extended
   `shouldCentreGhostOnActivate(isTouch, hasChosen, isPending, spectator)` —
   spectator forces the screen-centre seed even on desktop (the free-roam camera
   *is* the placement cursor). The ghost then follows the player's view.
3. Commit uses the existing `placementChosen` channel → `placeStructureAt(kind,
   x, y)`, which needs only a live room (no ship). Desktop one-click and the
   touch Confirm banner both flow through `commitChosenPlacement` unchanged.

## Files

| Concern | File |
|---|---|
| Discrete flag + setter | `src/client/state/store.ts`, `storeTypes.ts` (`pilotMode`/`setPilotMode`) |
| Death → spectator guard | `src/client/spectator/spectatorMode.ts` |
| Death transition + reset | `src/client/net/ColyseusClient.ts` (`killEntity`, `dispose`, `devKillLocalShip`) |
| Free-roam camera | `IRenderer.setSpectator`, `PixiRenderer.setSpectator` + the `update()` follow gate, `WorkerRendererClient` + `SET_SPECTATOR` protocol |
| Input swap | `src/client/App.tsx` (input-gate + `setSpectator` effects), `AutoFireToggleButton`, `MobileControls` |
| Speed-dial toggle | `src/client/components/SpeedDialMenu.tsx` (`data-testid="spectator-toggle"`, gated `phase==='game'`) |
| Spectator placement | `ColyseusClient.updateMirror` spectator block + `shouldCentreGhostOnActivate(..., spectator)` |
| Server (no change needed) | `RespawnHandler.ts` (doc only — no longer on the death path) |

## Tests

- `src/client/spectator/spectatorMode.test.ts` — death→spectator guard + `isSpectating`.
- `src/client/components/SpeedDialMenu.spectator.test.tsx` — toggle gated to `phase==='game'`, round-trips, `aria-pressed`.
- `src/client/render/placementPointerDecision.test.ts` — `shouldCentreGhostOnActivate` spectator centre-seed.
- `tests/e2e/spectator-mode.spec.ts` — death→no modal, camera free-roams, input is pan not thrust, construction while spectating, toggle round-trip. Drives the client-local death via the DEV hook `__eqxKillLocalShip` (spectator is un-networked per D5).

---

# Ship entry / switch via in-world overlay + smooth camera (Equinox Phase 4, WS-A2)

WS-A2 is how the player gets **back into a ship**: select an OWNED in-sector ship
(a lingering hull of theirs parked in this sector) → the **Pilot** action on the
`EntityStatsPanel` → a **same-sector INSTANT swap** with a **smooth camera lerp**
to the new ship. No spool, no curtain (that's the whole point of "same-sector").
If there's **no living owned ship in the sector**, the only way back is the
existing galaxy-map spawn/join flow (the Map toggle, already reachable in
spectator) — there is no new in-sector fresh-spawn mechanic.

## Locked design decisions (D6)

- **Re-enter / switch ships by clicking an owned ship's in-world overlay** → a
  "Pilot" action. Inherently **same-sector** and **instant**, but the camera must
  **smoothly lerp** from the old view to the new ship (no snap).
- **No living owned ship in the current sector** → the existing galaxy-map flow.
- **Faction v1 = your own ships** (D2): the Pilot action only appears on a
  lingering hull whose `ownerPlayerId === localPlayerId`. The seam (`ownerPlayerId`
  on the lingering render entry) is where a future "pilot a teammate's unpiloted
  ship" slots in.

## The new message — `pilot_ship { shipId }`

A strict zod-validated client→server message (`clientMessages.ts`,
`PilotShipSchema`) sent over the **live room socket** (NOT a leave/rejoin — that
would re-arm the warp curtain). `shipId` is the target hull's shipInstanceId.

## Server — same-sector instant rebind (`SectorRoom.reclaimLingeringHull`)

The handler is owner-gated by construction and reuses the lingering-hull
reactivation machinery + `RosterPersistence.markActive`:

1. **Validate**: the target must be a `lingeringSlots` entry (a DISPLACED /
   combat-death / boot-reconstructed lingering hull) present in THIS room, whose
   schema entry is owned by the requester and `isActive=false`, alive, with a
   matching owned roster row. A hull another player is piloting is `isActive=true`
   and never in `lingeringSlots`, so a foreign / active / unknown id is **dropped**
   (no control transfer, no clobber). Engineering rooms (`sectorKey===null`) have
   no roster → no-op.
2. **Displace** the player's current active hull (if any) into a lingering hull
   first (`displaceActiveHullToLingering`) — the exact inverse of the reclaim,
   mirroring the onJoin fresh-spawn-displaces branch (REKEY `playerId` →
   `linger-<id>`, slot → `lingeringSlots`, `markLinger`, `ownerlessShips=null`,
   `isActive=false`). So switching ships never leaves two active hulls.
3. **Reclaim** the target's slot from the lingering maps back into the active maps,
   **REKEY** the worker body `linger-<shipId>` → `playerId` (the rekey/abandon
   identity invariant — preserved both ways), `markActive` the roster row at the
   **LIVE SAB pose** (so the hull keeps where it actually is — not a stale abandon
   pose), and re-drive the **unified join handshake** (`pendingJoin` →
   `client_ready` → `warp_in` → arrivalTick → `isActive=true`) via a fresh
   `welcome`. No second activation path (Invariant #12). Force-broadcast grace so
   the returning client reconciles before idle-suppression.

The hull's pose is never reset — only its visibility + the session binding change.

## Client — smooth camera + self-prediction re-anchor

`ColyseusGameClient.pilotInSectorShip(shipId)` (the UI bridge is
`src/client/ships/shipActionsClient.ts` `sendPilotShip`):

1. Sends `pilot_ship` over the live room.
2. **Despawns the local predWorld body** + nulls the Reconciler — one ownership
   site (same discipline as `resetPredictionState`) — so the fresh `welcome`'s
   `tryInitPredWorld` reseeds it at the new ship's AUTHORITATIVE pose. The
   spectator case has no body; the switch-from-another-hull case drops the old one.
3. Stashes the target shipId. The generic `welcome` handler matches it →
   `setPilotMode('pilot')` (leave spectator, re-enable input + self-prediction) +
   **arms the one-shot camera glide**.
4. The RAF loop reads `consumePendingCameraGlide()` (one-shot, off the mirror pose)
   and fires `renderer.glideCameraTo(x, y, PILOT_SWAP_GLIDE_MS=420)`.

### The camera glide (Risk #4 — must NOT trip the teleport guard)

`Camera.glideTo(worldX, worldY, durationMs)` is a **one-shot eased glide**
(ease-out cubic) driven by **elapsed wall-clock ms inside `Camera.tick`** —
INDEPENDENT of pose interpolation, so it never trips the snapshot teleport guard.
While the glide runs it **OVERRIDES the follow target** in `tick()`, so the
production `followLerpFactor: 1` follow (instant snap) can't yank the view to the
new ship mid-transition; on completion it snaps exactly to the destination, clears,
and follow resumes on the new ship. `IRenderer.glideCameraTo(gameX, gameY, ms)`
(Y-flip game→pixi inside `PixiRenderer`) crosses the worker boundary via the
`GLIDE_CAMERA` protocol message.

## "No living ship in sector" → galaxy map

The Pilot action only renders when an owned lingering hull is selected. When the
player has no reclaimable hull in the sector, no Pilot button shows and the only
re-entry is the galaxy map (the Map toggle, reachable in spectator per WS-A1). No
new in-sector fresh-spawn mechanic — exactly per D6.

## Files (WS-A2)

| Concern | File |
|---|---|
| Message schema | `src/shared-types/messages/clientMessages.ts` (`PilotShipSchema`), re-export in `messages.ts` |
| Server rebind | `SectorRoom.reclaimLingeringHull` + `displaceActiveHullToLingering` + the `pilot_ship` handler |
| Camera glide | `Camera.glideTo/isGliding/cancelGlide` + `tick()` override, `IRenderer.glideCameraTo`, `PixiRenderer.glideCameraTo`, `WorkerRendererClient` + `GLIDE_CAMERA` protocol |
| Client swap state | `ColyseusGameClient.pilotInSectorShip` / `consumePendingCameraGlide` + the `welcome`-handler match |
| RAF wiring | `src/client/app/gameRafLoop.ts` (`PILOT_SWAP_GLIDE_MS`, `consumePendingCameraGlide` → `glideCameraTo`) |
| UI bridge | `src/client/ships/shipActionsClient.ts` (`sendPilotShip`) |
| Pilot action | `EntityStatsPanel` (`data-testid="ship-action-pilot"`, OWNED lingering hull only) |

## Tests (WS-A2)

- `tests/integration/sectorRoom/pilotInSectorShip.test.ts` — control transfers in-room; reclaimed hull lands at its LIVE (bumped) pose; another player's active hull is dropped (no clobber); lingering bookkeeping torn down + roster row survives. Reproduce-first per Invariant #13 (the `lingering*`/`transit`/`abandon` greens were the baseline).
- `src/client/render/worker/Camera.test.ts` — `glideTo` eases to centre over the duration (intermediate frame asserted, NOT a jump) then clears; overrides a `followLerpFactor:1` follow; `cancelGlide`.
- `src/client/net/ColyseusClient.pilotSwap.test.ts` — `pilotInSectorShip` send + pending id; `consumePendingCameraGlide` one-shot + waits-for-pose.
- `src/client/components/EntityStatsPanel.test.tsx` — Pilot action on the local player's own lingering hull sends `pilot_ship`; absent on another player's hull.
- `src/client/ships/shipActionsClient.test.ts` — `sendPilotShip` delegates to the client (no-op without a room).
- `src/client/render/worker/protocol.test.ts` — `GLIDE_CAMERA` structuredClone roundtrip.
- **Deferred (human gate):** `pnpm e2e:netgate` (touches `SectorRoom` join/snapshot + control rebind) + the WS-A2 E2E + screenshot specs (smooth-lerp frames).
