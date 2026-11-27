# Mobile Layout & Slot System

EQX Peri's React overlay UI is positioned via **named slot anchors**, not hand-placed offsets. This document covers the slot architecture, the right-edge advanced drawer, and how mobile orientation is handled (phones play sideways: upright, a full-screen picture asks the player to turn the phone).

## Why slots

Before the slot system, every HUD widget hand-coded its own `position: absolute|fixed`, `top/left/right/bottom`, `zIndex`, and (sometimes) `env(safe-area-inset-*)`. Adding any widget meant picking a corner, hard-coding offsets, and praying it didn't overlap the joystick on a small viewport. The HUD chip cluster had no `safe-area-inset-top` — it actively clipped under the AppBar on notched iPhones.

The slot system replaces that with twelve named anchors and a single z-index table. Every widget says **where** it lives (`<Slot anchor="top-left">`) without saying **how** to position itself.

## Anchors

[src/client/layout/anchors.ts](../../src/client/layout/anchors.ts) defines the catalogue:

| Anchor | Layout | Typical residents |
|---|---|---|
| `top-left` | Column, growing down. Below AppBar + safe-area-top. | HUD chips (sector, hull, ammo, connection, clock) |
| `top-center` | Column, centered. | Status capsule, lock band, disabled countdown, pilot toggle (touch) |
| `top-center-prompt` | Column, centered, `prompt` tier (above Windows); top just under the `top-center` column (`--hud-tc-bottom`, `layout/topCenterPromptFit.ts`). | EqxPrompt: toll / pair prompts, warp-in warning, teleport warning, warp status chip, trade toasts |
| `top-right` | Column, growing down, right-aligned. | MobileAvatarBadge (homepage), ShipStatsCard |
| `middle-center` / `middle-right` | Available; unused today. | reserved |
| `bottom-left` | Column-reverse, growing up. Above safe-area-bottom + `--mobile-edge-inset`. | Joystick zone (touch) |
| `bottom-center` | Column-reverse, centered. | WeaponSelector (order=5), GalaxyMapToggleButton (order=10) |
| `bottom-right` | Row-reverse, growing left. Inset by `--mobile-edge-inset`. | The do-hexes honeycomb (Command fleet, Fly on touch, Build: placing / route-pick tools and your own structure) (`layout/DoHexesHost.tsx`, its own absolute layout inside one slot, `layout/doHexLayout.ts`); desktop key hint |
| `left-column` | Column, 8px under the whole `top-left` stack (`--hud-tl-bottom`), in line with it; scaled to fit the height (`--left-column-scale`, `layout/leftStripFit.ts`). | Command: the who-hex column, then what is left of the strip |
| `middle-left` | Column, vertically centered, left-aligned, beside the left strip. | (free) |
| `middle-left-over` | Same place as `middle-left`, `overStrip` tier (over the left strip and rail). | HyperspaceOverlay (SPOOLING) |
| `fullscreen` | Inset 0, overlay tier. | DeathOverlay, in-game GalaxyOverviewScreen (warp-mode) |
| `transit` | Inset 0, transit tier (above overlay). | HyperspaceOverlay warp-streak |

Anchor host CSS bakes in safe-area insets (the game has no top bar, so no app-bar height). The `bottom-left` and `bottom-right` anchors additionally read `--mobile-edge-inset` (default `16px`, bumped to `40px` by a `(orientation: landscape) and (pointer: coarse)` media query) so joystick / fire / boost sit further from the bezel when a phone is held sideways. Widgets never compute these.

`pointer-events: none` is the default on every anchor host so empty regions pass clicks through to the Pixi canvas underneath. The `<Slot>` wrapper re-enables `pointer-events: auto` on each child so buttons stay clickable.

## Z-index tokens

[src/client/layout/zIndex.ts](../../src/client/layout/zIndex.ts):

```
canvas         0   // Pixi
hud           10   // top/middle/bottom anchor hosts
mobileControls 15  // joystick / fire / boost / map
overStrip   1150   // over the left strip / rail: warp spool bar
drawer      1200   // SwipeableDrawer (MUI default)
appBar      1300   // AppHeader
overlay     1400   // DeathOverlay, GalaxyMap
transit     1500   // Hyperspace IN_TRANSIT / ARRIVED warp streak
```

Anchor hosts pick a tier from this enum once. Widgets do not set `zIndex` props.

## The advanced drawer

[src/client/layout/Drawer/AdvancedDrawer.tsx](../../src/client/layout/Drawer/AdvancedDrawer.tsx) holds the rail's page panels (Galaxy, Jobs, Faction). It renders through the one right panel, `EqxPanel` (a `persistent` MUI Drawer, so no Modal and no global touch listeners), and shows only the open rail item's pages: there is no tab column. A panel with several pages (Faction: Factions / Ship look) gets an `EqxSegmented` page switch (`drawer-tab-<id>`); which panel a page belongs to is `DRAWER_TAB_PANEL` (`state/rightPanel.ts`). Trade is its own panel, a drill-down ([panels/TradePanel.tsx](../../src/client/panels/TradePanel.tsx)): the top page shows credits, standing and the base you trade from, then one row per section (Offers, Deals, History, Gift, Blueprints); a row opens that page and the header gets ← back. The page is `drawerTab` (`trade` = the list, `trade-<section>`). The Trade unread badge sits on the rail's Trade item.

The cog is its own panel, [src/client/panels/CogPanel.tsx](../../src/client/panels/CogPanel.tsx) (`rightPanel = 'cog'`, title Settings): one scrolling page with small headings: Return to menu, Graphics, Notifications (`PushNotificationToggle`), Screen (a **Full screen** switch over `useFullscreen`, and an **Install** row that opens the install hint (an `EqxWindow` in `panels/cogRows.tsx`); both hidden inside an installed app), then two drill-down rows with ← back: **Profile** (`ProfileTab`) and **Developer** (`DebugTab`: capture, the debug overlay / server log / server ghost switches, `ConnectionDiagnostics`, `DevOverlay`, `LogPanel`). Its pages reuse `drawerTab` (`settings`, `profile`, `debug`), so `selectDrawerTabShown('debug')` is true only while Developer is on screen. In the game the right rail's cog opens it; on the homepage the desktop AppHeader's gear does too.

> **Performance contract — DO NOT change without re-measuring.**
> 1. **Plain `Drawer`, NOT `SwipeableDrawer`.** SwipeableDrawer attaches global touch listeners (touchstart/touchmove on `document`) that fire on every joystick movement during play. Measured cost: prediction RTT shot from ~50 ms to ~2.4 s on Android. Diagnostic captures are checked in at `diag/captures/2026-05-09T16-35-19-910Z-ozqfzu/summary.json` (good baseline, RTT 43 ms) vs `diag/captures/2026-05-10T08-38-25-767Z-xtjhgx/summary.json` (broken, RTT 2359 ms).
> 2. **`keepMounted` is OFF.** With keepMounted on, `ConnectionDiagnostics` + `DevOverlay` + `LogPanel` re-render on every `devData` Zustand update (~17 Hz) even when the drawer is closed, starving the Pixi RAF loop on mobile. Tab content only mounts while the drawer is actually open.
> 3. **`HudTestAttributes`** preserves the few `data-testid`s (`ship-count`, `swarm-count`, `clock-rate`, `server-tick-hz`) that existing E2E specs poll via `textContent`. Plain DOM, `display: none`, no MUI overhead.

Open paths:

- Touch or pointer: tap a right-rail item (`layout/RightPanelHost.tsx`); the drawer opens on that page. (Swipe-from-edge is intentionally disabled — see contract above.)

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

Adding a new tab means appending a record (set `bottom: true` to pin it under the spacer with Debug). The active tab id is held in Zustand (`drawerTab`, the page inside the open panel); which panel is open is `rightPanel` (`state/rightPanel.ts`: each tab maps to a rail group, and `setDrawerTab` opens that group). Both are discrete UI flags — the [Zustand purity rule](../../src/client/CLAUDE.md) is preserved.

| Tab | Contents | Notes |
|---|---|---|
| **Profile** | Avatar header, display-name editor, **red Logout** with confirm dialog | Logged-out users see a "Sign in" CTA instead. Logout fires `clearAuth()` + explicit `setPhase('galaxy-map')`. |
| **Settings** (cog main page) | **Return to menu** button (top), graphics, notifications, Screen rows; Profile and Developer rows | "Return to menu" sets `phase = 'galaxy-map'` (the homepage map) and closes the drawer. Promoted to the top of the panel so navigation isn't buried under preference toggles. |
| **Galaxy** | "Show galaxy map" button (disabled while transit is active), reserved space for future warp actions | Replaces the floating MAP button that used to live in the `top-center` slot. M-key shortcut still works. |
| **Developer** (cog drill-down, `debug`) | "Capture diagnostic" block (note + button), `showDevOverlay` / `showLogPanel` / `showServerGhost` switches, `ConnectionDiagnostics`, `DevOverlay`, `LogPanel` | The `showDevOverlay` / `showLogPanel` switches gate the latter two on this page. |

The vertical rail uses `IconButton`s inside a flex column — no MUI `Tabs` component (its vertical orientation is overkill and harder to control "pinned bottom" with a flex spacer).

## Mobile vs desktop split

Settings and Profile live in ONE place, the cog panel, on every screen; in game the right rail's cog opens it. The game has no top bar; on the homepage and sign-in the desktop AppHeader adds two shortcuts into it.

- **Touch (`pointer: coarse`)**: `AppHeader` is hidden. The homepage avatar badge opens the cog's Profile page.
- **Desktop, homepage and sign-in**: `AppHeader` shows logo + settings gear (opens the cog panel's Settings page) + avatar (opens the cog's Profile page). While it is mounted it sets `html.eqx-app-bar`, which makes `--app-bar-h` `48px` (index.html); otherwise the var is `0px`, so a right panel starts at the top in game.

The old desktop-only `ProfileModal`, `SettingsModal`, `AvatarMenu` and `LogoutConfirmDialog` were folded into the cog panel (UI plan U2-8b) and deleted.

## Phase machine + homepage

The top-level UX phase is in Zustand (`phase: Phase`), so drawer tabs can drive navigation without prop drilling:

```
type Phase = 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local';
```

Initial phase is `'galaxy-map'` for everyone: the galaxy map is the homepage. The `?room=…` / `?galaxy=…` URL escape hatch overrides to `'game'` on mount (preserves existing E2E specs and deep links).

A logged-out visitor can tap any sector; login is asked for only on "Join the fight" (see [living-galaxy](../architecture/living-galaxy.md) "Homepage"). The live player count and server-health banner sit over the map (`galaxy-landing-info`).

Drawer Profile-tab Logout = `clearAuth() + setPhase('galaxy-map')`. Drawer Settings-tab "Return to menu" = `setPhase('galaxy-map')` (no auth change).

## Orientation policy

**Phones play sideways.** On a phone (`useHudSize() === 'phone'`: coarse pointer and a short side under 500 px) held upright, [RotatePhoneOverlay](../../src/client/layout/RotatePhoneOverlay.tsx) covers the whole screen with a turning-phone picture and "Turn your phone sideways". It renders through the `rotate` anchor (`Z.rotatePrompt`: above the galaxy map chrome, below the lost-connection and error overlays) in every phase. While it shows, `GameSurface` turns keyboard, touch and aim input off (held input is zeroed; the same gate as the loading curtain). Audio keeps playing. Tablets and desktops never see it.

Turned sideways, the game shows. In game the first tap on a touch browser asks for full screen ([layout/useFirstTapFullscreen.ts](../../src/client/layout/useFirstTapFullscreen.ts), through `useFullscreen`: `requestFullscreen()` plus a best-effort `screen.orientation.lock('landscape')`). It asks once per game; after the player leaves full screen, the cog's Full screen switch brings it back (`exitFullscreen()` releases the lock first). It never starts by itself (browsers need a gesture), and does nothing on desktop or in an installed app.

**Installed app.** The manifest (the `VitePWA` options in `vite.config.ts`) declares `orientation: 'landscape'`, and `main.tsx` also calls `lockLandscape()` at launch whenever the page runs as an installed app (`isStandaloneNow()`), so the installed Android app opens sideways and stays there; it never shows the picture. The runtime lock matters because Chrome refreshes an installed app's manifest lazily (it can take days), so an existing install would otherwise keep its old orientation. Lock: `src/client/layout/landscapeLock.test.ts`. iOS ignores the manifest orientation, so the installed iPhone app shows the same turn-sideways picture when held upright.

What this is NOT:

- **Not** full screen without a tap. Full screen starts only from the first tap in game or the cog's switch.
- **Not** an upright phone layout. The upright-phone HUD layouts still exist in the code but sit behind the picture on phones.

**Phone perf runs** (`perf/run-phone.ts`) drive a real phone, which should stand sideways; upright, the picture sits over the scene (a cheap DOM layer; the run needs no input).

iOS Safari has no JS API to remove its address bar in a regular tab — `enterFullscreen()` returns `false` there, and the first tap does nothing; the cog's Full screen switch and Install row open an "Add to Home Screen" install hint so the player can launch as a standalone PWA (which IS chromeless).

## Adding a HUD widget

1. Pick an anchor from the catalogue. If none fits, prefer adding a new anchor in [anchors.ts](../../src/client/layout/anchors.ts) over hand-placing the widget.
2. Render `<Slot anchor="...">` around the widget body. Optionally pass `order={n}` to control stacking among siblings in the same anchor (lower = closer to the anchor edge).
3. Inside the slot body, **do not set** `position`, `top/left/right/bottom`, `zIndex`, or any safe-area calc. The slot host owns all of that. Set styles on the widget itself for size / colour / borders / interactivity.

## Adding a drawer tab

1. Build a tab component (e.g. `SettingsTab.tsx`) that renders normal MUI content.
2. Append `{ id: 'settings', label: 'Settings', node: <SettingsTab /> }` to the `TABS` array in [AdvancedDrawer.tsx](../../src/client/layout/Drawer/AdvancedDrawer.tsx). Done.

## Regression test

[tests/e2e/layout-slots.spec.ts](../../tests/e2e/layout-slots.spec.ts) covers:

- HUD does not collide with the joystick zone on mobile landscape.
- Dev panels are inside the drawer, not the always-visible HUD.
- The right rail opens the drawer on both desktop and mobile.
- An upright phone shows the turn-sideways screen; sideways shows the game; desktop never shows it; the game has no top bar.

If you change anchor positions, drawer wiring, or the orientation policy, run this spec before merging.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

In-game React overlays are positioned via **named slot anchors**, never hand-placed. The system lives in [layout/](../../src/client/layout/) — see [docs/features/mobile-layout.md](../../docs/features/mobile-layout.md) for the full story.

- **Anchors are defined in [layout/anchors.ts](../../src/client/layout/anchors.ts).** A 3×3 grid (`top-left` … `bottom-right`) plus two specials (`fullscreen`, `transit`). Adding an anchor is fine; mutating an existing anchor's CSS is a code-review prompt because every widget already depends on it.

- **`--mobile-edge-inset` CSS var** ([index.html](../../src/client/index.html)): default `16px`, bumped to `40px` by `(orientation: landscape) and (pointer: coarse)`. The `bottom-left` and `bottom-right` anchor hosts use it so joystick / fire / boost sit further from the bezel when a phone is held sideways. Other anchors keep `16px` everywhere — they're not thumb-territory.

- **Widgets render into a slot via `<Slot anchor="...">`** ([layout/Slot.tsx](../../src/client/layout/Slot.tsx)). Slots `createPortal` into the matching host element registered by `<LayoutProvider>`. **No widget sets its own `position`, `top/left/right/bottom`, `zIndex`, or safe-area insets** — those are owned by the anchor host. If you find yourself reaching for `position: fixed` in a HUD component, you are bypassing the system.

- **Z-index tokens are in [layout/zIndex.ts](../../src/client/layout/zIndex.ts)** (`Z.canvas` < `Z.hud` < `Z.mobileControls` < `Z.drawer` < `Z.appBar` < `Z.overlay` < `Z.transit`). Anchor hosts pick a tier from this table once; widgets never reference `zIndex` directly.

- **Safe-area insets are baked into the anchor host CSS.** `env(safe-area-inset-*)` is applied uniformly; the game has no top bar to clear. Per-component safe-area maths are obsolete.

- **The `top-*` anchors clear the AppBar automatically.** This used to be a per-widget bug — the original HUD chip cluster paint into the notch on iOS — fixed structurally by the anchor host's `padding-top` calc.

- **Advanced / hidden UI lives in the right-edge `Drawer`** ([layout/Drawer/AdvancedDrawer.tsx](../../src/client/layout/Drawer/AdvancedDrawer.tsx)) (one rail panel per item, no tab column). **The drawer must NOT be a `SwipeableDrawer`** — SwipeableDrawer attaches global touch listeners that fire on every joystick movement and regressed mobile RTT from ~50 ms to ~2.4 s. **`ModalProps.keepMounted` is now ON** (2026-05-13, commit `2aa7d4f`) because Modal cold-mount was the dominant first-open cost — pre-mounting drops CLICK→VISIBLE from ~13.7 s to ~1.22 s; see `docs/LESSONS.md` 2026-05-13 "Drawer perf paradigm". The historic 17 Hz background-render objection still applies to snapshot-rate subscribers in hidden tabs (`tabs/DebugTab.tsx`, `components/ConnectionDiagnostics.tsx`, `components/DevOverlay.tsx`, `components/LogPanel.tsx`) — each MUST gate on `selectDrawerTabShown('<id>')` so they pay zero cost when their tab isn't on screen. **Verify the gate exists before adding new snapshot-rate work in any drawer tab.** Adding a page: append a `PageSpec { id, label, node }` to `PAGES` in `AdvancedDrawer.tsx` and map it to its rail panel in `DRAWER_TAB_PANEL`. `rightPanel` and `drawerTab` are discrete UI flags in Zustand, purity-clean. The right rail (`layout/RightPanelHost.tsx`) opens the drawer on a page; the old ☰ drawer toggle is gone.

- **`HudTestAttributes`** ([components/HudTestAttributes.tsx](../../src/client/components/HudTestAttributes.tsx)) keeps the `data-testid="ship-count"` / `swarm-count` / `clock-rate` / `server-tick-hz` text mirrors in the always-mounted DOM at `display: none`. The real diagnostics now only mount when the cog's Developer page is open; the existing E2E suite reads these via `textContent`, so the hidden mirrors are a perf-safe contract surface. Do NOT delete them without auditing every spec that polls those testids.

- **Mobile vs desktop split**: the game has no top bar; outside it the desktop `AppHeader` is hidden on touch (`pointer: coarse`) and sets `--app-bar-h` to 48px only while mounted (`html.eqx-app-bar`). Settings and Profile live only in the cog panel (rail cog in game).

- **Profile + logout (one ownership site).** The cog panel's Profile page ([panels/CogProfilePage.tsx](../../src/client/panels/CogProfilePage.tsx)) shows the avatar, name, email, the display-name editor and **Log out**; the desktop header avatar (`header-avatar`) and the touch galaxy-map badge (`mobile-avatar-badge`, `MobileAvatarBadge.tsx`) both open it via `openCogProfile()`. Log out confirms INLINE: the button turns into **Confirm log out** + Cancel in place (`cog-profile-logout` → `cog-profile-logout-confirm`), never a dialog. **Logout has exactly ONE definition: the `useLogout()` hook** ([auth/useLogout.ts](../../src/client/auth/useLogout.ts)) = `clearAuth(); setPhase('galaxy-map'); setRightPanel(null);` — do NOT re-inline `clearAuth()` without the `setPhase('galaxy-map')` (the pre-fix bug: token cleared but you stayed in-game). Regression lock: [tests/e2e/avatar-menu-logout.spec.ts](../../tests/e2e/avatar-menu-logout.spec.ts) + `CogProfilePage.test.tsx` + `AppHeader.test.tsx` + `useLogout.test.tsx`.

- **Phones play sideways.** An upright phone shows `RotatePhoneOverlay` (`rotate` anchor) with input off underneath; the installed Android app is locked sideways by the manifest and a runtime lock at launch. In game the first tap asks for full screen (`useFirstTapFullscreen`, through `useFullscreen`; lock: `useFirstTapFullscreen.test.tsx`); the cog has a Full screen switch. iOS Safari has no JS API to remove its address bar, so there the cog's switch and Install row open an "Add to Home Screen" hint instead. See "Orientation policy".

- **Discrete (tap) HUD actions live on the right rail** ([layout/RightPanelHost.tsx](../../src/client/layout/RightPanelHost.tsx), UI language plan A3/A7). The speed dial (`SpeedDialMenu.tsx`) and the ☰ drawer toggle were retired once the rail landed: Map and Warp moved to the Galaxy page (`galaxy-tab-show-map`, `galaxy-tab-warp`; M still toggles the map), Panels became the rail itself, weapon choice is the HUD weapon strip (one chip per group), and the Build sidebar mount moved to `components/BuildSidebarHost.tsx`. The Build panel itself is `panels/BuildPanel.tsx` (U2-1): it is open while `rightPanel === 'build'` (the rail's Build item toggles it; entering Build opens nothing), so the rail highlight, Esc, its 1–9 / Q / E keys and the fire-control stand-down all read that one flag; leaving Build clears it (store `setBuildMode`). **Held/continuous controls (joystick, FIRE, BOOST) stay dedicated.** A HUD button a second simultaneous touch must reach binds `onTouchStart` through `useTouchClickActivate` (mobile browsers only synthesize a click for the primary touch) and drops the trailing synthesized click.

- **`useIsCompact()` (`useMediaQuery(theme.breakpoints.down('sm'))`)** and **`isTouchDevice()`** are independent axes — touch on a desktop monitor and pointer on a tablet are real cases. Don't fuse them.

- **Phase machine lives in Zustand** (`phase: 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local'`). Drawer tabs use `useUIStore(s => s.setPhase)` to drive navigation (Settings `Return to menu`, Profile Logout). **Living Galaxy P5 (2026-06-15): the initial phase is `galaxy-map`** — the live galaxy map IS the landing screen on load. **Sign-in is asked at Launch** (join flow stage 6): a logged-out visitor taps sectors and opens the Hangar freely; the Hangar footer's Sign in (or Spectate, which asks up front) stashes the sector in Zustand `pendingPickSector` and routes to `auth`; on return the remounted GameSurface's idle-mount effect calls `resumeGatedJoin`, which reopens that sector's Hangar with the picked hull (or spectates). Play as guest launches at once. `?room=…` / `?galaxy=…` URL escape hatches still skip straight to `game` (App's `autoJoin` overrides the initial phase). The old `meta` splash phase is **deleted**; its server-health banner + live player count are FOLDED into `GalaxyPickerChrome` (`galaxy-landing-info`). Regression lock: [tests/e2e/galaxy-landing-flow.spec.ts](../../tests/e2e/galaxy-landing-flow.spec.ts).

- Regression lock: [tests/e2e/layout-slots.spec.ts](../../tests/e2e/layout-slots.spec.ts) covers HUD vs AppBar clearance, HUD vs joystick non-overlap, the upright-phone turn-sideways screen and full-screen label, mobile AppBar hidden, each rail item showing only its own pages (no tab column), cog Developer content gating, MAP-button removal, map-on-load, Return-to-menu flow, Logout confirm (drawer `ProfileTab`; the avatar-menu logout path is locked separately by [tests/e2e/avatar-menu-logout.spec.ts](../../tests/e2e/avatar-menu-logout.spec.ts)).

- **No raw ids in player-facing UI (2026-06-14 — load-bearing).** NEVER render a playerId / shipId / entityId / ownerPlayerId as visible text. There are no anonymous players — every owner resolves to a DB user — so show a HUMAN label: a display name ("you" for the local player, the owner's server-resolved name, or "Unknown" for an owner that doesn't map to a DB user, which is an ORPHAN the server logs via `structure_owner_unresolved`). When no name is available, show a kind/role, never an id. Ids live ONLY in hidden `data-*` attrs (E2E) + logs. (Internal sprite/map/body keys — `swarm-${id}`, `linger-${id}`, `p:${playerId}` — are fine; they're never shown. Drone NPC callsigns `AI <hex>` are a deliberate designation, not a player-identity id.) Fixed instances: structure-owner inspector line, lingering-hull inspector (kind only), ship name-label fallback (`Pilot`, never `Pilot <id>`), ConnectionDiagnostics ID row (removed).

### Sizing default: start tiny, grow on request

When you build any new UI element — modal, panel, card, button, chip — **default to as small as humanly possible**. Especially on mobile. We will iterate it bigger when the user reports it's hard to hit or read; the reverse direction (shipping huge and shrinking back down) wastes review cycles and feels worse.

Concretely:
- Card silhouettes / icons: start ~24–36 px. Don't reach for 64 px without a reason.
- Body text in HUD / overlays / cards: 9–11 px. Captions 8–9 px. Reserve 12+ px for primary CTAs.
- Dialog `maxWidth`: prefer `xs`; only step up to `sm` if content genuinely needs it.
- Padding inside cards / dialogs: `p: 0.5`–`0.75` (4–6 px). Avoid MUI defaults (which are 16–24 px).
- Touch targets that absolutely must be 44 px (iOS HIG) — only fight for that on PRIMARY confirm actions, not every chip.
- Buttons: `size="small"` by default, with `fontSize: 11`.


- **Desktop keys (UI language U1-9, `input/railKeys.ts`):** Alt + 1–8 open the rail items in order, top to bottom, the same as tapping them (Shift + number stays the weapon group auto/manual switch). Esc does one thing per press: it closes a status fly-out, else cancels placement or a fleet pick, else closes the open panel, else clears the strip (deselects).
- **The selection shows on the left strip** (`layout/LeftStripHost.tsx`, `<Slot anchor="left-strip">`). In Command with own ships selected it is the **who-hex column** (`layout/WhoHexes.tsx`, selection HUD S5), in the `left-column` anchor: it starts top left, just under the mode switch and in line with it, and runs down the left edge: one pointy-top hex per ship type (type icon + "×N", grouped by `fleet/fleetView.ts` `groupMirrorSelection`), each next hex a step down, alternately half a hex right then back left, so they interlock edge to edge (offsets 0,0 / 26,45 / 0,90 / 26,135 / 0,180 px); tapping a hex keeps only that type (`keepOnlyKind` through the renderer); more than 5 types puts "?" + "+N" in the last slot, which opens the Fleet orders panel. Fly and Build show no who-hexes (the world tag names the focus). **On touch (the phone game) there is no action strip at all** (owner 2026-11-27): every do-hex set also draws what its own builder leaves over (`layout/doHexLeftovers.tsx`, the one leftover filter: Pilot, a tapped thing's cargo, the personal Lock, Power you may not manage) in a free cell, or behind its More, which then opens a More sub-set in the honeycomb (the set's own More action first, the leftovers, Back); a focus-only pick in Command, or Build with anything but your own structure, gets a small set of its own (`data-set="focus"`: its actions + More for Details). **On desktop** the selection's actions the bottom-right do-hexes do not carry stay on a slim icon strip under it; an action shows in one place only (the strip reads the do-hexes' own `useDoHexSet` predicate and coverage, `FLEET_HEX_KEYS` / `flyHexCovers`). Command with own ships: Order, Move, Stance and Stop are hexes, so the strip keeps only the T2 Lock (if any). Fly on touch: Target / Lock, the pod Open (Salvage), the tapped ship's cargo (Cargo opens THAT ship's hold when one with a readable hold is tapped, else yours) and Details (More) are hexes; the strip keeps only Pilot. Desktop Fly has no hexes, so its strip keeps every quick action (Target, Cargo, pod Open, Pilot; `layout/selectionStripItems.tsx`; a hidden action means it cannot work). Placing a structure and a route / target pick (selection HUD S4, `layout/buildDoHexes.tsx`, every device): every tool is a hex (placing: Place under the thumb, Rotate, the building (reopens the Build menu), Mirror, Gate on a deck, Cancel in the far corner; route: Done / To post under the thumb, Undo, the pick, Cancel), so the strip draws nothing. Build with your own structure selected: Upgrade (main), Demolish (hold to confirm; Stop while one runs), Power (switchable kinds) and More (Details) are hexes, so the strip drops Power and Details; moving, rotating or repairing a placed structure has no path yet, so those hexes are not drawn. Build keeps Power on the strip for a building you may not manage. Details stays for a focus-only pick. With nothing left the strip draws no frame. The identity icons, ⚙ and ✕ are retired (tap empty space or Esc deselects). Icons only; names are tooltips.
- **The selection's right panel:** Fleet orders (rail item, or "?") for own ships in Command, **Details** (strip Details button) (`panels/DetailsPanel.tsx`, `rightPanel='details'`, not a rail item) for anything else. Details holds the readout (`EntityStatsPanel`: header, shield / hull / charge bars, build, power, info lines) and the slower actions (settings, repair, refine, bounty, blueprints, unpack, research, teleporters). It closes when the selection clears. One placement path each: the strip Slot and the right panel. Never float either over the selection.
- **A panel outside the Slot system that must beat the HUD is `<Portal>`'d to `document.body`:** an ancestor stacking context traps its z-index under the body-level HUD anchors (LESSONS 2026-11-02).

## History

- **Building-panels A2b:** the selection card stopped floating over the selected object. It had been world-anchored since WS-9: `gameRafLoop` moved it every frame with `app/inspectorPlacement.ts` (whole panel on screen, clear of the HUD bands and the selection box, via `RendererFeedback.selectionScreenX/Y/Half`) and `app/inspectorHold.ts` (held still under a pointer so taps landed). All of that was retired when the card docked in the top-centre Slot.
- **UI language U5-3:** the in-game top bar went: no AppHeader, no top-right toolbar and no full-screen chip in game. Settings and account are on the rail's cog; full screen comes from the first tap in game (the chip's "Tap for full screen" label went with it). `--app-bar-h` is 0 unless the homepage AppHeader is mounted.
- **UI language U3-1 / U3-2:** the top-centre card was retired. Its quick actions moved to the left strip as icons; its readout and the remaining actions moved to the Details right panel (opened by ⚙). The pod's "Fly closer to open" hint went with it: Open shows only in reach.

The bias: it's easier to hear "this is too small, bump it 10 %" than to undo the visual heaviness of a default-sized MUI component cluster. The 2026-05-12 ship-picker rebuild is the canonical example — `maxWidth="sm"` + full kind descriptions + 64 px silhouettes + 22 px stat chips read as "absolutely huge" in playtest; the rebuild dropped to `xs`, 36 px silhouettes, a one-line stat readout, and 11 px buttons.
