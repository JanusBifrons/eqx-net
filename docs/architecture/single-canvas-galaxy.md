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
`GalaxyPickerChrome.openForSector` → the [Hangar](../features/hangar.md) → `onSpawnNewShip`. A
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
roster ship-swap picker. That chrome and the roster are gone (join flow
stage 5): ship swap is map → sector → the Hangar's owned tile.
Tap-to-warp stays on the MAP button / `M`-key `overlay`.

## Pan / pinch / wheel zoom (dropped 2026-06-05, RESTORED 2026-06-06)

The single-canvas refactor initially dropped free pan/zoom from the selector
picker (static screen-space fit). The user relies on it, so it was **restored**
2026-06-06 — but NOT via `pixi-viewport` (which can't run in the OffscreenCanvas
worker). Instead `GalaxyMapLayer` drives its screen-space `clusterRoot` with the
same hand-rolled [`Camera`](../../src/client/render/worker/Camera.ts) the world
view uses (drag + pinch + wheel + clamp + momentum; DOM-free, so it works in
both render paths). `resize()` seeds the camera to the fit (re-fit only on a
real size change — a same-dims resize preserves the user's pan/zoom); the
renderer routes canvas pointer/wheel events to the layer's camera while
`isPanZoomActive()` (selector mode + visible), and a tap (vs drag) still selects
a sector via `hitTest`. `overlay` mode (the in-game additive MAP) keeps its
static fit — no pan/zoom there. Lock: `tests/e2e/galaxy-map-pan-zoom.spec.ts`
reads the REAL `clusterRoot` transform via `window.__eqxGalaxyTransform()` (not a
recompute) and asserts a drag pans + a wheel zooms.
- **In-canvas limbo RESUME pulse.** Multi-ship roster already surfaces
  lingering ships per-card; all sectors stay selectable. `GalaxyPickerChrome`
  keeps the hidden `limbo-resume-banner` / `data-limbo-sector-key` stub for
  E2E only.

## Files

- `render/galaxy/GalaxyMapLayer.ts` — the one renderer (modes).
- `render/galaxy/galaxyLayerDecisions.ts` — pure `isSectorSelectable` /
  `clusterFitFraction` (+ test).
- `components/GalaxyPickerChrome.tsx` — post-auth spawn chrome (canvas-less).
- `app/gameSurfaceConnectFlow.ts` — `surfaceMode` idle/connect branch.
- `app/galaxyOverlay.ts` — install + `syncGalaxyMode` (dual path).
- **Deleted:** `components/GalaxyOverviewScreen.tsx`,
  `render/galaxy/GalaxyOverviewRenderer.ts`.

## Regression locks

- Unit: `galaxyLayerDecisions.test.ts`, `galaxyOverlay.test.ts`,
  `GalaxyPickerChrome.test.tsx`,
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

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **React + MUI** is for out-of-game UI and overlays. Phase 8 sub-phase A made the **Galaxy Map the user's first screen post-auth** (replacing the original "Enter Sector Alpha" splash); the SVG `HexGalaxyMap` was retired in 2026-05-10. **Single-canvas refactor (2026-06-05): there is now exactly ONE Pixi galaxy renderer — `GalaxyMapLayer` — on the ONE shared gameplay canvas.** The former "Map A" (`GalaxyOverviewScreen` → `GalaxyOverviewRenderer`, a SECOND `Application` + `pixi-viewport`) is DELETED. Do NOT re-introduce a second Pixi `Application` for the galaxy; render via `GalaxyMapLayer` modes on the shared canvas. The layer has two modes (see [render/galaxy/galaxyLayerDecisions.ts](../../src/client/render/galaxy/galaxyLayerDecisions.ts)):
  - **`selector`** — the full-screen spawn/warp picker (every sector tappable, fit at `clusterFitFraction('selector')`; **free drag-pan + pinch/wheel zoom RESTORED 2026-06-06** — `GalaxyMapLayer` drives its screen-space `clusterRoot` with the world view's hand-rolled `Camera` [`render/worker/Camera.ts`], the renderer routes canvas pointer/wheel to it while `isPanZoomActive()`, a tap still selects via `hitTest`; `overlay` mode stays a static fit. Lock: `tests/e2e/galaxy-map-pan-zoom.spec.ts` via `window.__eqxGalaxyTransform()`). Hosted by **`GameSurface` in `surfaceMode='idle'`**: the persistent canvas is alive during the `galaxy-map` phase (renderer inited, NO Colyseus room joined — see `gameSurfaceConnectFlow.ts` idle branch), with **`GalaxyPickerChrome`** ([components/GalaxyPickerChrome.tsx](../../src/client/components/GalaxyPickerChrome.tsx)) — the React chrome (roster panel, ship-kind picker, engineering rooms, single-player diagnostic, limbo stub) — overlaid transparently. A hex tap routes through `App.handleSelectorPick` (logs `galaxy_sector_click` + `respawn_clicked`, 200 ms tap-shield) → `GalaxyPickerChrome.openForSector` → `ShipPickerModal`. DEV-only `__eqxGalaxyPick(sectorKey)` drives this deterministically from E2E. The in-game drawer "Show galaxy map" ship-swap picker is **`GalaxyOverviewSelectChrome`** ([components/GalaxyOverviewSelectChrome.tsx](../../src/client/components/GalaxyOverviewSelectChrome.tsx)) — roster-pick + close over a dim scrim of the live game, NO galaxy backdrop.

  - **`overlay`** (default) — the in-game additive HUD: a Pixi `Container` on the **gameplay canvas's `app.stage`** above the viewport (via `IRenderer.addOverlayContainer`). **Highly transparent** — gameplay stays fully visible underneath; tap-to-warp on neighbours, faint outlines on non-neighbours. Toggled by the **Map action inside the consolidated [SpeedDialMenu](../../src/client/components/SpeedDialMenu.tsx)** (`data-testid="galaxy-map-toggle"`, `aria-pressed` reflecting `isGalaxyMapOpen`) and the keyboard `M` shortcut. (Pre-2026-06 the toggle was a standalone bottom-center `GalaxyMapToggleButton`; the speed-dial UI refactor folded it — plus the weapon-slot selector — into one bottom-right FAB. See the SpeedDial entry under "Layout Slot System".) Layer state is driven by Zustand effects in `GameSurface`: `isGalaxyMapOpen → setVisible`, `currentSectorKey → setCurrentSector`, `transitState → setTransitDocked`, plus `syncGalaxyMode` for the mode (the idle visibility effect forces the selector visible — it's the whole screen). Worker + DOM paths both host the layer; the mode crosses the worker boundary via `SET_OVERLAY_MODE` ([render/worker/protocol/mainToWorker.ts](../../src/client/render/worker/protocol/mainToWorker.ts)). A separate `ResizeObserver` calls `layer.resize(w, h)` on canvas-size changes.

- **Limbo UX**: `GalaxyPickerChrome` queries `/dev/limbo?playerId=` to populate `data-limbo-sector-key` on the (hidden) `data-testid="limbo-resume-banner"` stub for E2E. Post-multi-ship-roster, sector selection is NOT constrained to the limbo sector — the roster panel surfaces lingering ships per-card and all sectors stay selectable. (The old in-canvas RESUME-pulse on the limbo hex died with `GalaxyOverviewRenderer`.)
