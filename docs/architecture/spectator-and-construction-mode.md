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
