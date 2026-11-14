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

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

In-game React overlays are positioned via **named slot anchors**, never hand-placed. The system lives in [layout/](../../src/client/layout/) — see [docs/features/mobile-layout.md](../../docs/features/mobile-layout.md) for the full story.

- **Anchors are defined in [layout/anchors.ts](../../src/client/layout/anchors.ts).** A 3×3 grid (`top-left` … `bottom-right`) plus two specials (`fullscreen`, `transit`). Adding an anchor is fine; mutating an existing anchor's CSS is a code-review prompt because every widget already depends on it.

- **`--mobile-edge-inset` CSS var** ([index.html](../../src/client/index.html)): default `16px`, bumped to `40px` by `(orientation: landscape) and (pointer: coarse)`. The `bottom-left` and `bottom-right` anchor hosts use it so joystick / fire / boost sit further from the bezel when a phone is held sideways. Other anchors keep `16px` everywhere — they're not thumb-territory.

- **Widgets render into a slot via `<Slot anchor="...">`** ([layout/Slot.tsx](../../src/client/layout/Slot.tsx)). Slots `createPortal` into the matching host element registered by `<LayoutProvider>`. **No widget sets its own `position`, `top/left/right/bottom`, `zIndex`, or safe-area insets** — those are owned by the anchor host. If you find yourself reaching for `position: fixed` in a HUD component, you are bypassing the system.

- **Z-index tokens are in [layout/zIndex.ts](../../src/client/layout/zIndex.ts)** (`Z.canvas` < `Z.hud` < `Z.mobileControls` < `Z.drawer` < `Z.appBar` < `Z.overlay` < `Z.transit`). Anchor hosts pick a tier from this table once; widgets never reference `zIndex` directly.

- **Safe-area insets are baked into the anchor host CSS.** `env(safe-area-inset-*)` and the AppBar height (`var(--app-bar-h, 48px)` set on `:root` in [index.html](../../src/client/index.html)) are applied uniformly. Per-component safe-area maths are obsolete.

- **The `top-*` anchors clear the AppBar automatically.** This used to be a per-widget bug — the original HUD chip cluster paint into the notch on iOS — fixed structurally by the anchor host's `padding-top` calc.

- **Advanced / hidden UI lives in the right-edge `Drawer`** ([layout/Drawer/AdvancedDrawer.tsx](../../src/client/layout/Drawer/AdvancedDrawer.tsx)) with a vertical icon-only tab rail. **The drawer must NOT be a `SwipeableDrawer`** — SwipeableDrawer attaches global touch listeners that fire on every joystick movement and regressed mobile RTT from ~50 ms to ~2.4 s. **`ModalProps.keepMounted` is now ON** (2026-05-13, commit `2aa7d4f`) because Modal cold-mount was the dominant first-open cost — pre-mounting drops CLICK→VISIBLE from ~13.7 s to ~1.22 s; see `docs/LESSONS.md` 2026-05-13 "Drawer perf paradigm". The historic 17 Hz background-render objection still applies to snapshot-rate subscribers in hidden tabs (`tabs/DebugTab.tsx`, `components/ConnectionDiagnostics.tsx`, `components/DevOverlay.tsx`, `components/LogPanel.tsx`) — each MUST gate on `drawerTab === '<id>' && isDrawerOpen` so they pay zero cost when their tab isn't on screen. **Verify the gate exists before adding new snapshot-rate work in any drawer tab.** Adding a new tab: append a `TabSpec { id, label, icon, node, bottom? }` to the `TABS` array in `AdvancedDrawer.tsx`. Tab catalogue today: `galaxy` (top + default-selected), `profile`, `settings`, `debug` (last is sticky-bottom). `isDrawerOpen` and `drawerTab` are discrete UI flags in Zustand, purity-clean. The drawer toggle (`<DrawerToggle>`) is rendered into the `top-right` slot.

- **`HudTestAttributes`** ([components/HudTestAttributes.tsx](../../src/client/components/HudTestAttributes.tsx)) keeps the `data-testid="ship-count"` / `swarm-count` / `clock-rate` / `server-tick-hz` text mirrors in the always-mounted DOM at `display: none`. The real diagnostics now only mount when the drawer's Debug tab is open; the existing E2E suite reads these via `textContent`, so the hidden mirrors are a perf-safe contract surface. Do NOT delete them without auditing every spec that polls those testids.

- **Mobile vs desktop split**: `AppHeader` is hidden via MUI `display: { xs: 'none', sm: 'flex' }` below the `sm` breakpoint (600 px). The `--app-bar-h` CSS var is responsive to match (`0px` below 600 px, `48px` at and above). Mobile users only have the drawer for settings/profile/galaxy/debug; desktop users keep the existing `ProfileModal` + `SettingsModal` paths as well as the drawer. **Do not delete `ProfileModal.tsx`, `SettingsModal.tsx`, or `AvatarMenu.tsx`** — they are the desktop access path.

- **Avatar context menu + logout (one ownership site).** `AvatarMenu.tsx` is the shared popover for BOTH the desktop header (`variant="desktop"`) AND the mobile meta-landing badge (`variant="mobile"`; `MobileAvatarBadge.tsx` now only owns the touch/meta gate + the `top-right` `Slot` and delegates the trigger + menu to `AvatarMenu`). The menu has two items: **Display name** (`avatar-menu-display-name` → `onProfileClick` → `ProfileModal`) and **Logout** (`avatar-menu-logout` → a confirm dialog → real logout). **Logout has exactly ONE definition: the `useLogout()` hook** ([auth/useLogout.ts](../../src/client/auth/useLogout.ts)) = `clearAuth(); setPhase('meta'); setDrawerOpen(false);`. Every logout entry point (avatar menu + drawer `ProfileTab`) routes through it — do NOT re-inline `clearAuth()` without the `setPhase('meta')` (the pre-fix bug: token cleared but you stayed in-game). The confirm dialog is the shared `LogoutConfirmDialog.tsx`; it takes overridable testids so the header/mobile instance (`avatar-logout-confirm-*`) never collides with the drawer instance (`logout-confirm-*`). Regression lock: [tests/e2e/avatar-menu-logout.spec.ts](../../tests/e2e/avatar-menu-logout.spec.ts) + `AvatarMenu.test.tsx` + `useLogout.test.tsx`.

- **Portrait works by default; landscape is opt-in via the fullscreen toggle.** Portrait playability is the default — slot anchors adapt, no overlay blocks input. The only landscape lock is initiated by the user tapping `<FullscreenToggle>` ([layout/FullscreenToggle.tsx](../../src/client/layout/FullscreenToggle.tsx)), which calls `useFullscreen.enterFullscreen()` → `requestFullscreen()` + best-effort `screen.orientation.lock('landscape')`. `exitFullscreen()` releases the orientation lock first. The toggle is gated by `isTouchDevice()` so it's exclusively a mobile affordance, and auto-hides while in fullscreen / standalone PWA. Manifest declares `orientation: any`. **Do not** reintroduce a first-gesture lock or a portrait-block overlay — both were removed because they made the app user-hostile (forced rotation against the user's grip, blocked legitimate portrait sessions). iOS Safari has no JS API to remove its address bar, so on iOS the toggle opens an "Add to Home Screen" install dialog instead.

- **Discrete (tap) HUD actions live in one bottom-right `SpeedDial`** ([components/SpeedDialMenu.tsx](../../src/client/components/SpeedDialMenu.tsx), speed-dial UI refactor 2026-06). It consolidates what used to be three scattered widgets — the galaxy-overlay MAP toggle (bottom-center), the weapon-slot selector (bottom thumb cluster), and a panels/drawer entry — into a single MUI `SpeedDial` FAB. **Held/continuous controls (joystick, FIRE, BOOST in `MobileControls`) deliberately stay dedicated** — a tap-to-expand FAB is wrong for a held input (confirmed with the user). Placement: it portals into the `bottom-right` anchor at **`order={1}`** (smoke handoff 2026-06-06, Issue 3 — "the speed dial is in the wrong place" → bottom-right CORNER). In the row-reverse bottom-right anchor the LOWEST order is corner-most, so `order={1}` puts the dial in the absolute corner, to the right of the AUTO toggle (order 5) and the FIRE/BOOST cluster (orders 10/20 — those keep their positions); the dial expands `direction="up"`. **Multitouch (same handoff):** MUI `SpeedDial` opens via a synthesized CLICK, which mobile browsers only emit for the PRIMARY touch — so tapping the dial while a steering joystick touch is held (a second simultaneous touch) never opened it. The FAB + every action now ALSO bind `onTouchStart` (the raw touch IS delivered to a second touch point, exactly like FIRE/BOOST), the `onOpen`/`onClose` ignore the MUI `'toggle'` reason within a `TOUCH_CLICK_SUPPRESS_MS` (700 ms) window, and `onClick` handlers are wrapped to drop the trailing synthesized click — the AutoFireToggleButton double-fire trap. `onClick` stays live for desktop. ⚠️ If MUI's Tooltip wrapper turns out NOT to forward `onTouchStart` onto the action Fab, the documented fallback is a custom FAB + absolutely-positioned action stack keeping every `data-testid`. Actions carry stable `data-testid`s (`speed-dial-fab` on the FAB, `speed-dial-menu` / `galaxy-map-toggle` / `slot-selector` on the actions); MUI forwards `data-*` + `aria-pressed` through the action's Tooltip onto its Fab. **Collapsed actions stay in the DOM but render at `scale(0)`** — readable by attribute (the keyboard-`M` aria-pressed assertion) but not "visible"/clickable until the FAB is opened, so any test that CLICKS an action opens the dial first. Open/closed is local React state (pure presentation — never Zustand). All static `sx` is hoisted (drawer-perf rule). Regression locks: [tests/e2e/speed-dial.spec.ts](../../tests/e2e/speed-dial.spec.ts) (single-pointer) + [tests/e2e/speed-dial-multitouch.spec.ts](../../tests/e2e/speed-dial-multitouch.spec.ts) (CDP two-touch).

- **`useIsCompact()` (`useMediaQuery(theme.breakpoints.down('sm'))`)** and **`isTouchDevice()`** are independent axes — touch on a desktop monitor and pointer on a tablet are real cases. Don't fuse them.

- **Phase machine lives in Zustand** (`phase: 'meta' | 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local'`). Drawer tabs use `useUIStore(s => s.setPhase)` to drive navigation (Settings `Return to menu`, Profile Logout). **Living Galaxy P5 (2026-06-15): the initial phase is `galaxy-map`** — the live galaxy map IS the landing screen on load. **Spawning is auth-gated ON THE PICK** (`GameSurface.handleSelectorPick`): a logged-out pilot browses the map freely, but picking a sector stashes it in Zustand `pendingPickSector` and routes to `auth`; on return the remounted GameSurface's idle-mount effect re-opens the picker for the stashed sector. `?room=…` / `?galaxy=…` URL escape hatches still skip straight to `game` (App's `autoJoin` overrides the initial phase). `meta` is **retired from the default path** (kept reachable via Return-to-menu / Logout); the `MetaLandingScreen`'s server-health banner + live player count are FOLDED into `GalaxyPickerChrome` (`galaxy-landing-info`). Regression lock: [tests/e2e/galaxy-landing-flow.spec.ts](../../tests/e2e/galaxy-landing-flow.spec.ts).

- Regression lock: [tests/e2e/layout-slots.spec.ts](../../tests/e2e/layout-slots.spec.ts) covers HUD vs AppBar clearance, HUD vs joystick non-overlap, portrait-keeps-joystick-interactive, mobile AppBar hidden, vertical tab order (galaxy first), debug-tab content gating, MAP-button removal, meta-landing visibility, Return-to-menu flow, Logout confirm (drawer `ProfileTab`; the avatar-menu logout path is locked separately by [tests/e2e/avatar-menu-logout.spec.ts](../../tests/e2e/avatar-menu-logout.spec.ts)).

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


- **The inspector is `<Portal>`'d to `document.body`.** Its `zIndex: 1400` was trapped by an ancestor stacking context under the body-level HUD anchors, so the `top-left` anchor ate clicks on its buttons (LESSONS 2026-11-02). Any panel outside the Slot system that must beat the HUD needs a Portal. `gameRafLoop` still finds it by testid.
- **The world-anchored inspector is placed by `app/inspectorPlacement.ts` `placeInspector`:** the WHOLE panel stays on screen, below the header, with the bottom kept when it is too tall.
  - A target off-screen used to push half the panel out of view (its buttons unclickable). Found by `teleporter.spec.ts`; the header case by `break-in.spec.ts`.
  - Never clamp only the anchor.

## History

The bias: it's easier to hear "this is too small, bump it 10 %" than to undo the visual heaviness of a default-sized MUI component cluster. The 2026-05-12 ship-picker rebuild is the canonical example — `maxWidth="sm"` + full kind descriptions + 64 px silhouettes + 22 px stat chips read as "absolutely huge" in playtest; the rebuild dropped to `xs`, 36 px silhouettes, a one-line stat readout, and 11 px buttons.
