# Mobile Layout & Slot System

EQX Peri's React overlay UI is positioned via **named slot anchors**, not hand-placed offsets. This document covers the slot architecture, the right-edge advanced drawer, and how mobile orientation is handled (portrait works by default; landscape is unlocked by an explicit user gesture via the fullscreen toggle).

## Why slots

Before the slot system, every HUD widget hand-coded its own `position: absolute|fixed`, `top/left/right/bottom`, `zIndex`, and (sometimes) `env(safe-area-inset-*)`. Adding any widget meant picking a corner, hard-coding offsets, and praying it didn't overlap the joystick on a small viewport. The HUD chip cluster had no `safe-area-inset-top` — it actively clipped under the AppBar on notched iPhones.

The slot system replaces that with twelve named anchors and a single z-index table. Every widget says **where** it lives (`<Slot anchor="top-left">`) without saying **how** to position itself.

## Anchors

[src/client/layout/anchors.ts](../../src/client/layout/anchors.ts) defines the catalogue:

| Anchor | Layout | Typical residents |
|---|---|---|
| `top-left` | Column, growing down. Below AppBar + safe-area-top. | HUD chips (sector, hull, ammo, connection, clock) |
| `top-center` | Column, centered. | MAP button (touch) |
| `top-right` | Column, growing down, right-aligned. | DrawerToggle, ShipStatsCard |
| `middle-left` / `middle-center` / `middle-right` | Available; unused today. | reserved |
| `bottom-left` | Column-reverse, growing up. Above safe-area-bottom + `--mobile-edge-inset`. | Joystick zone (touch) |
| `bottom-center` | Column-reverse, centered. | WeaponSelector (order=5), GalaxyMapToggleButton (order=10) |
| `bottom-right` | Row-reverse, growing left. Inset by `--mobile-edge-inset`. | FIRE (rightmost), BOOST |
| `middle-left` | Column, vertically centered, left-aligned. | HyperspaceOverlay (SPOOLING) |
| `fullscreen` | Inset 0, overlay tier. | DeathOverlay, in-game GalaxyOverviewScreen (warp-mode) |
| `transit` | Inset 0, transit tier (above overlay). | HyperspaceOverlay warp-streak |

Anchor host CSS bakes in safe-area insets and the AppBar height (`var(--app-bar-h, 48px)`, set on `:root` in [src/client/index.html](../../src/client/index.html)). The `bottom-left` and `bottom-right` anchors additionally read `--mobile-edge-inset` (default `16px`, bumped to `40px` by a `(orientation: landscape) and (pointer: coarse)` media query) so joystick / fire / boost sit further from the bezel when a phone is held sideways. Widgets never compute these.

`pointer-events: none` is the default on every anchor host so empty regions pass clicks through to the Pixi canvas underneath. The `<Slot>` wrapper re-enables `pointer-events: auto` on each child so buttons stay clickable.

## Z-index tokens

[src/client/layout/zIndex.ts](../../src/client/layout/zIndex.ts):

```
canvas         0   // Pixi
hud           10   // top/middle/bottom anchor hosts
mobileControls 15  // joystick / fire / boost / map
drawer      1200   // SwipeableDrawer (MUI default)
appBar      1300   // AppHeader
overlay     1400   // DeathOverlay, GalaxyMap
transit     1500   // Hyperspace IN_TRANSIT / ARRIVED warp streak
```

Anchor hosts pick a tier from this enum once. Widgets do not set `zIndex` props.

## The advanced drawer

[src/client/layout/Drawer/AdvancedDrawer.tsx](../../src/client/layout/Drawer/AdvancedDrawer.tsx) is a right-anchored MUI **plain `Drawer`** with a vertical icon-only tab rail.

> **Performance contract — DO NOT change without re-measuring.**
> 1. **Plain `Drawer`, NOT `SwipeableDrawer`.** SwipeableDrawer attaches global touch listeners (touchstart/touchmove on `document`) that fire on every joystick movement during play. Measured cost: prediction RTT shot from ~50 ms to ~2.4 s on Android. Diagnostic captures are checked in at `diag/captures/2026-05-09T16-35-19-910Z-ozqfzu/summary.json` (good baseline, RTT 43 ms) vs `diag/captures/2026-05-10T08-38-25-767Z-xtjhgx/summary.json` (broken, RTT 2359 ms).
> 2. **`keepMounted` is OFF.** With keepMounted on, `ConnectionDiagnostics` + `DevOverlay` + `LogPanel` re-render on every `devData` Zustand update (~17 Hz) even when the drawer is closed, starving the Pixi RAF loop on mobile. Tab content only mounts while the drawer is actually open.
> 3. **`HudTestAttributes`** preserves the few `data-testid`s (`ship-count`, `swarm-count`, `clock-rate`, `server-tick-hz`) that existing E2E specs poll via `textContent`. Plain DOM, `display: none`, no MUI overhead.

Open paths:

- Touch: tap the `<DrawerToggle>` icon button in the `top-right` slot. (Swipe-from-edge is intentionally disabled — see contract above.)
- Pointer: same icon button.

Close paths:

- Click the close button in the drawer header.
- Click outside the drawer (MUI default backdrop click).

The drawer paints over the canvas (`Z.drawer = 1200`) without resizing or remounting Pixi.

### Tabs

The tab catalogue is a single array inside [AdvancedDrawer.tsx](../../src/client/layout/Drawer/AdvancedDrawer.tsx):

```ts
const TABS: readonly TabSpec[] = [
  { id: 'galaxy',   label: 'Galaxy',   icon: <HexagonOutlinedIcon />,       node: <GalaxyTab /> },
  { id: 'profile',  label: 'Profile',  icon: <AccountCircleOutlinedIcon />, node: <ProfileTab /> },
  { id: 'settings', label: 'Settings', icon: <SettingsOutlinedIcon />,      node: <SettingsTab /> },
  { id: 'debug',    label: 'Debug',    icon: <BugReportOutlinedIcon />,     node: <DebugTab />, bottom: true },
];
```

Galaxy is the top tab and the default-selected one (`drawerTab: 'galaxy'` in `store.ts`) — the galaxy map is the player's first screen after auth, so opening the drawer surfaces galaxy actions immediately.

Adding a new tab means appending a record (set `bottom: true` to pin it under the spacer with Debug). The active tab id is held in Zustand (`drawerTab`); the open/closed state is `isDrawerOpen`. Both are discrete UI flags — the [Zustand purity rule](../../src/client/CLAUDE.md) is preserved.

| Tab | Contents | Notes |
|---|---|---|
| **Profile** | Avatar header, display-name editor, **red Logout** with confirm dialog | Logged-out users see a "Sign in" CTA instead. Logout fires `clearAuth()` + explicit `setPhase('meta')`. |
| **Settings** | **Return to menu** button (top), `showDevOverlay` / `showLogPanel` / `showServerGhost` switches | "Return to menu" sets `phase = 'meta'` and closes the drawer. Promoted to the top of the panel so navigation isn't buried under preference toggles. |
| **Galaxy** | "Show galaxy map" button (disabled while transit is active), reserved space for future warp actions | Replaces the floating MAP button that used to live in the `top-center` slot. M-key shortcut still works. |
| **Debug** *(sticky bottom)* | "Capture diagnostic" block (note + button), `ConnectionDiagnostics`, `DevOverlay`, `LogPanel` | The `showDevOverlay` / `showLogPanel` toggles still gate the latter two inside this tab. |

The vertical rail uses `IconButton`s inside a flex column — no MUI `Tabs` component (its vertical orientation is overkill and harder to control "pinned bottom" with a flex spacer).

## Mobile vs desktop split

The drawer is mobile-primary; desktop keeps its existing AppHeader + ProfileModal + SettingsModal flow.

- **Mobile (viewport `< sm`, 600 px)**: `AppHeader` is hidden via `display: { xs: 'none', sm: 'flex' }`. The `--app-bar-h` CSS var is `0px`. The drawer is the only entry point to settings / profile / galaxy / debug.
- **Desktop (`≥ sm`)**: `AppHeader` is visible with logo + settings cog (opens `SettingsModal`) + avatar (`AvatarMenu` → `ProfileModal`). The drawer is still accessible via the toggle, so power users can use either path. `--app-bar-h` is `48px`.

`ProfileModal.tsx`, `SettingsModal.tsx`, and `AvatarMenu.tsx` are the desktop access path — **do not delete them**. They overlap with the drawer tabs intentionally.

## Phase machine + meta landing

The top-level UX phase is in Zustand (`phase: Phase`), so drawer tabs can drive navigation without prop drilling:

```
type Phase = 'meta' | 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local';
```

Initial phase is `'meta'` for everyone. The `?room=…` / `?galaxy=…` URL escape hatch overrides to `'game'` on mount (preserves existing E2E specs and deep links).

[MetaLandingScreen](../../src/client/components/MetaLandingScreen.tsx) is the canonical "main menu":

- Big "Join the fight!" CTA → if logged in → `phase = 'galaxy-map'`; else → `'auth'`.
- Fake but deterministic player count: `600 + (hash(floor(now / 60_000)) % 300)`. Same value across all clients hitting at the same minute, ticks over each minute. Implementation in `fakePlayerCount()` exported from `MetaLandingScreen.tsx`.

Drawer Profile-tab Logout = `clearAuth() + setPhase('meta')`. Drawer Settings-tab "Return to menu" = `setPhase('meta')` (no auth change).

## Orientation policy

Portrait works by default. The slot layout adapts: HUD chips compress, the hyperspace bar is a slim left-edge column, joystick / fire / boost stay in their bottom corners. Nothing forces the user out of portrait.

Landscape is unlocked by **one explicit user gesture**: tapping the `<FullscreenToggle>` icon in the `top-right` slot. That call enters fullscreen via `requestFullscreen()` and follows up with `screen.orientation.lock('landscape')` — both are best-effort and silently fail if the browser doesn't support them. The toggle auto-hides while in fullscreen / standalone PWA / on non-touch devices, so it's an unambiguously *mobile* affordance. `exitFullscreen()` releases the orientation lock first so the device can swing back to whatever it physically is.

What this is NOT:

- **Not** a manifest landscape lock. `public/manifest.json` declares `"orientation": "any"`; PWA install no longer pins to landscape.
- **Not** a reflexive lock on first touch. The previous `LayoutProvider` first-gesture handler is gone.
- **Not** a portrait-block overlay. There is no "rotate your device" prompt anymore.

iOS Safari has no JS API to remove its address bar in a regular tab — `enterFullscreen()` returns `false` there, and the toggle opens an "Add to Home Screen" install dialog so the player can launch as a standalone PWA (which IS chromeless).

## Adding a HUD widget

1. Pick an anchor from the catalogue. If none fits, prefer adding a new anchor in [anchors.ts](../../src/client/layout/anchors.ts) over hand-placing the widget.
2. Render `<Slot anchor="...">` around the widget body. Optionally pass `order={n}` to control stacking among siblings in the same anchor (lower = closer to the anchor edge).
3. Inside the slot body, **do not set** `position`, `top/left/right/bottom`, `zIndex`, or any safe-area calc. The slot host owns all of that. Set styles on the widget itself for size / colour / borders / interactivity.

## Adding a drawer tab

1. Build a tab component (e.g. `SettingsTab.tsx`) that renders normal MUI content.
2. Append `{ id: 'settings', label: 'Settings', node: <SettingsTab /> }` to the `TABS` array in [AdvancedDrawer.tsx](../../src/client/layout/Drawer/AdvancedDrawer.tsx). Done.

## Regression test

[tests/e2e/layout-slots.spec.ts](../../tests/e2e/layout-slots.spec.ts) covers:

- HUD chip clears the AppBar (regression for the missing-safe-area-top bug).
- HUD does not collide with the joystick zone on mobile landscape.
- Dev panels are inside the drawer, not the always-visible HUD.
- DrawerToggle works on both desktop and mobile.
- Portrait orientation no longer renders a block overlay — the joystick stays interactive in portrait.

If you change anchor positions, drawer wiring, or the orientation policy, run this spec before merging.
