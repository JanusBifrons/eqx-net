# Single-Canvas Galaxy (the 2026-06-05 unify)

> **Status:** shipped on `claude/galaxy-map-canvas-laser-fix-Pu2GH`. Supersedes
> the two-Pixi-surfaces "Map A / Map B" design previously described in
> [`../../src/client/CLAUDE.md`](../../src/client/CLAUDE.md) UI-Scope. `Map A`
> (`GalaxyOverviewScreen` → `GalaxyOverviewRenderer`) is **deleted**.

## Why

The galaxy map used to render on **two** Pixi surfaces:

- **Map A** — `GalaxyOverviewScreen` wrapped `GalaxyOverviewRenderer`, which
  spun up its **own** `Application` + `pixi-viewport` (free pan/pinch/wheel).
  It served the post-auth spawn picker AND the in-game drawer ship-swap
  overview.
- **Map B** — `GalaxyMapLayer`, a screen-space `Container` on the **gameplay**
  canvas's `app.stage` (the in-game additive "MAP" overlay).

Two `Application`s means two WebGL contexts. Map A was constructed pre-game
(during the `galaxy-map` phase, before the gameplay canvas exists) and again
the gameplay renderer ran its own. The duplication carried real cost
(context-init churn, the headless-Chromium "ran out of WebGL contexts" guard
in Map A's `init`, divergent camera/zoom code) and a maintenance tax (every
hex/edge/label tier coded twice).

**Goal:** exactly ONE Pixi galaxy renderer (`GalaxyMapLayer`) on the ONE
shared gameplay canvas, for every galaxy surface.

## The architecture

`GalaxyMapLayer` gained a **mode** (pure decisions in
[`galaxyLayerDecisions.ts`](../../src/client/render/galaxy/galaxyLayerDecisions.ts)):

| Mode | Role | Selectability | Fit |
|---|---|---|---|
| `overlay` (default) | in-game additive "MAP" HUD | docked neighbours of the current sector | 0.6 of min viewport dim |
| `selector` | spawn / warp picker | every sector | 0.85 |

### Persistent canvas (the key lifecycle change)

The post-auth picker renders **before** a Colyseus room is joined, so the
gameplay canvas must be alive during the `galaxy-map` phase. `GameSurface`
now takes a **`surfaceMode: 'idle' | 'connect'`**:

- **`idle`** (`galaxy-map` phase): `runGameSurfaceConnectFlow` inits the
  renderer, installs the galaxy overlay in `selector` mode, and **stops** —
  no sim RAF loop, no `gameClient.connect`. The load curtain stays down. The
  galaxy layer renders + pulses on the renderer's own Pixi ticker (the
  `app.ticker` auto-renders the stage; no `MIRROR_UPDATE` needed). React
  chrome (`GalaxyPickerChrome`) is overlaid transparently.
- **`connect`** (`game` phase): the existing gameplay path (join room, sim
  loop, HUD), with the galaxy layer in `overlay` mode for the MAP button.

`App` derives `surfaceMode = phase === 'galaxy-map' ? 'idle' : 'connect'` and
`PhaseRouter` renders the same `gameSurface` element for both phases. The flip
idle→connect re-runs `GameSurface`'s mount effect (via the dep array — the
same teardown+reconnect mechanism a `roomNameOverride` change already used);
one canvas at a time, never two simultaneously.

### Taps → spawn flow

In `selector`/idle mode a hex tap routes to `App.handleSelectorPick`, which
logs `galaxy_sector_click` + `respawn_clicked`, applies the **200 ms
tap-shield** (the tap originates on the Pixi canvas, so the touchend can bleed
through onto a modal mounted under the finger), then calls
`GalaxyPickerChrome.openForSector` → `ShipPickerModal` → `onSpawnNewShip`. A
DEV-only `window.__eqxGalaxyPick(sectorKey)` mirrors a tap deterministically
for E2E (no hex-pixel math — this retired three long-standing `fixme` specs).

### Worker + DOM

Both render paths host the layer. The mode crosses the worker boundary via the
new `SET_OVERLAY_MODE` message
([`mainToWorker.ts`](../../src/client/render/worker/protocol/mainToWorker.ts));
`galaxyOverlay.ts` exposes the dual-path `syncGalaxyMode` /
`installGalaxyOverlay({ mode, onSelectorPick })`.

### In-game ship-swap overview

The drawer's "Show galaxy map" was Map A's third role. Its real job is the
roster ship-swap picker, so it is now `GalaxyOverviewSelectChrome` — roster
panel + close over a dim scrim of the live game, **no galaxy backdrop**.
Tap-to-warp stays on the MAP button / `M`-key `overlay`.

## What was deliberately dropped

- **Free pan / pinch / wheel zoom.** The selector picker is a static
  screen-space fit; the 7-hex graph fits at 0.85. `pixi-viewport` can't run in
  the OffscreenCanvas worker anyway, and the layer is screen-space (it doesn't
  pan with the world camera). The `data-galaxy-zoom` E2E lock (published by the
  old renderer) was retired with it.
- **In-canvas limbo RESUME pulse.** Multi-ship roster already surfaces
  lingering ships per-card; all sectors stay selectable. `GalaxyPickerChrome`
  keeps the hidden `limbo-resume-banner` / `data-limbo-sector-key` stub for
  E2E only.

## Files

- `render/galaxy/GalaxyMapLayer.ts` — the one renderer (modes).
- `render/galaxy/galaxyLayerDecisions.ts` — pure `isSectorSelectable` /
  `clusterFitFraction` (+ test).
- `components/GalaxyPickerChrome.tsx` — post-auth spawn chrome (canvas-less).
- `components/GalaxyOverviewSelectChrome.tsx` — in-game ship-swap chrome.
- `app/gameSurfaceConnectFlow.ts` — `surfaceMode` idle/connect branch.
- `app/galaxyOverlay.ts` — install + `syncGalaxyMode` (dual path).
- **Deleted:** `components/GalaxyOverviewScreen.tsx`,
  `render/galaxy/GalaxyOverviewRenderer.ts`.

## Regression locks

- Unit: `galaxyLayerDecisions.test.ts`, `galaxyOverlay.test.ts`,
  `GalaxyPickerChrome.test.tsx`, `GalaxyOverviewSelectChrome.test.tsx`,
  `render/worker/protocol.test.ts` (`SET_OVERLAY_MODE`).
- E2E: `spawn-select-flow.spec.ts` (engineering + the deterministic
  galaxy-sector flip), `ship-selection.spec.ts` (mount + the three
  un-`fixme`d picker tests via `__eqxGalaxyPick`),
  `drawer-galaxy.spec.ts` / `galaxy-map-overlay.spec.ts` (the in-game
  ship-swap overview), `galaxy-polish.spec.ts`.

## Do not

- **Re-introduce a second Pixi `Application` for the galaxy.** Render via
  `GalaxyMapLayer` modes on the shared canvas (invariant #7, `src/client/CLAUDE.md`).
- Drive the selector picker's visibility off `isGalaxyMapOpen` — it's the whole
  screen in idle mode; the visibility effect forces it visible.
