# EQX Peri UI style guide

The rulebook for every UI task: a new element, a move, a tweak. Read it before you change anything the player sees.

- **The language** (Part 1): what the screen is made of and where everything lives.
- **The layout rulebook** (Part 2): how to place or change any UI.
- **The EQX catalogue** (Part 3): the component library every element comes from. The list of entries is in [src/ui/README.md](../src/ui/README.md).

Visual spec (mock-up with user stories, an anatomy figure and these tables): https://claude.ai/artifact/PaWNbse4HtZvikZDshRujR

If something you need is not covered here, ask the owner. Never guess. Never propose replacing MUI (shadcn was considered and rejected).

Some names below (the `right-rail` and `left-strip` anchors, the `rightPanel` flag, the rail/strip and prompt z tiers, entries such as `EqxPanel` and `EqxStrip`) arrive with the UI-language refactor. If one you need does not exist yet, follow Part 3 "When you need something the catalogue doesn't have"; never build a stand-in.

---

# Part 1: the UI language

## 1.1 The eight kinds of on-screen thing

Everything on screen is exactly one of these. Nothing else is allowed.

| Kind | What it is for | Where | When visible |
|---|---|---|---|
| **HUD** | Glanceable game state: status capsule, sector chip, CargoChip, weapon strip, lock band, net health, time-scale chip, move thumb-stick, mode switch (BOOST is a Fly do hex; the touch targeting stick was removed 2026-11-27) | Where it is today | Always (per mode) |
| **Right rail** | Menus: the things you open to browse or configure | A slim icon column on the right edge | Always |
| **Panel** | The menu that a rail icon (or ⚙ on the left strip) opens | Slides out from the right, about a third of the width; the world stays live behind it | One at a time, on request |
| **Left strip (who hexes)** | WHO you have selected: one hex per ship type, icon + ×N count, no words | A small honeycomb on the left, below the top-left HUD and above the move stick | Command mode, while something is selected |
| **Do hexes** | WHAT to do now: up to six hex buttons, each an icon **and a word**, colour hints on edge and icon | Bottom-right, where the targeting stick was (thumb-nearest slot = main action, Cancel in the far corner) | Every mode, per context; hidden while a panel is open |
| **World tag** | The floating name over the selection or target: outlined text, owner line, hull bar, pointer, gentle bob; sticks to the edge with an arrow off screen | Over the thing in the world, fixed screen size | While something is selected or targeted |
| **Window** | Jobs a third of the screen can't hold: two lists side by side (cargo transfer, market), the galaxy map, level-up, while-away, future editors | Full screen on a phone, centred on desktop; dims the world | Only from a panel button that will work |
| **Prompt** | Something that needs an answer now (teleporter toll, warp-in warning) and short toasts | Top centre | Briefly |

Debug overlays and system states (lost connection, error, rotate-your-phone, warp screens) sit outside the language. They keep their behaviour but are still built from the catalogue (Part 3).

## 1.2 Screen map (phone, sideways, 863×360; desktop is the same with more room)

```
┌───────────────────────────────────────────────────────────────┬────┐
│ [Fly|Cmd|Build]  status/sector/cargo HUD     ( PROMPT )   HUD │ ☰1 │
│ ┌──┐                                                          │ ☰2 │
│ │◉ │ ← left strip: identity                                   │ ☰3 │
│ │⛨ │   statuses (tap = fly-out ▸ ◻ ◻ ◻)       ┌─────────────┐  │ ☰4 │
│ │■ │   actions                               │   PANEL     │  │ ☰5 │
│ │──│                                         │ (replaces   │  │    │
│ │⚙ │   ⚙ = open the full menu on the right   │  the strip) │  │    │
│ │✕ │                                         └─────────────┘  │    │
│ └──┘                                                          │    │
│ (move stick)            status capsule          weapons BOOST │ ⚙  │
└───────────────────────────────────────────────────────────────┴────┘
                                                              right rail
```

The left strip and the panel are **never** open together. The drawing shows both only to name them.

## 1.3 Right rail

- **Width:** 48 px on a phone, 56 px on desktop. Exposed to CSS as `--rail-w`.
- **Icons only.** The label shows on hover (desktop) or long-press (touch).
- **Max 8 icons, plus the cog** pinned at the bottom.
- **Order, top to bottom:** first the current mode's own tools, then the things you can do in any mode.

  | Mode | Mode tools | Then, in every mode |
  |---|---|---|
  | Fly | Contacts, Hold | Galaxy, Jobs, Trade, Faction |
  | Command | Fleet | Galaxy, Jobs, Trade, Faction |
  | Build | Build | Galaxy, Jobs, Trade, Faction |

- **Desktop keys:** Shift + 1–8 open the rail items in order, top to bottom.
- **Nothing you select ever lands on the rail.** It only holds menus.

## 1.4 Panel

- **One at a time, always from the right.** Opening another replaces it. It is about a third of the width; on a portrait phone it is the existing bottom sheet.
- **The world stays live** and tappable behind it.
- **Opened by** a rail icon, or by ⚙ on the left strip.
- **Closed by** ✕, Esc, or a swipe right.
- **Header:** title, ← back (in drill-downs), ✕. **Body.** **Footer** (only when there is an Apply).
- **Inside a panel, pick one pattern:**

  | Content | Pattern | Examples |
  |---|---|---|
  | One topic, fits in a couple of screens | Scroll with small section headings | Cog (settings), fleet orders, contacts, your hold |
  | 2–4 views of the same thing | Segmented control under the header | Building: Power / Production / Manage. Jobs: Contracts / Bounties |
  | A list whose rows have their own detail, or 5+ sections | Drill-down: a row opens a sub-page, the header gets ← back | Trade (Offers, Deals, History, Gift, Blueprints), Cog › Developer, Faction › Ship look |
  | Two lists side by side, a map, a table, a multi-step editor | A Window, opened from a button in the panel | Cargo transfer, market, galaxy map |

- **Apply:** forms that change several things at once (fleet orders, a contract, a profile) end in **Apply**. A changed but unapplied value shows **amber**. After Apply the panel folds away and the left strip comes back.
- **Actions that can't work are hidden,** never shown and then refused.
- While a panel is open in Fly, the HUD weapon strip slides with it.

## 1.5 Left strip

The strictest element. The owner's rule:

> "It's a pretty firm rule on the left, no labels, only icons, colors... if you tap and hold, there should be tooltips and stuff, but there should not be any labels. It should be as skinny as humanly possible. Labels should not be necessary. If you need a label, then it's a very strong smell that it should go on the right bar."
>
> (The owner, 2026-11-22. They have had to repeat this rule. Any left-strip design or change: count the text on the strip, and it must be zero. Before redrawing anything, re-read this quote, not a summary of it.)

> **2026-11-27 owner change (selection-HUD redesign):** the strip's content became the *who hexes* below; the doing-tools, quick actions, ⚙ and ✕ moved to the **do hexes** (bottom-right, with words). The no-words rule above still holds for the left: icon + count only.

- **Who hexes:** one pointy hex per selected ship type with ×N; tap one to keep only that type; past five types the last slot is "?" +N and opens the full list in the Orders panel.
- *Earlier (pre-2026-11-27) strip layout, kept for history:*
- **One icon column.** Every button is the same size with its icon centred.
- **No text at all,** except a count badge. Tooltips show on hover or tap-and-hold.
- **It slides in** from the left edge only while something is selected or under way, and is fully out of view otherwise. It sits below the top-left HUD.
- **Selection mode**, top to bottom:
  1. **Identity:** a small round icon for the thing. Its ring colour shows health (green, amber, red); a badge shows the count for groups. Never a rectangular portrait.
  2. **Statuses as icons:** fleet order and stance; building power.
  3. **Quick actions:** for example Stop, Trade, Target.
  4. A separator.
  5. **⚙:** opens the full menu for this thing on the right.
  6. **✕:** deselect.
- **Quick change (for power users):** tapping a status flies its options out beside it as same-size icon buttons, with no captions. A pick takes effect at once. Tapping outside or pressing Esc closes the fly-out.
- **Doing mode** replaces the selection while you act in the world:
  - placing a building: building icon, ✓, rotate, mirror, ✕ (placing continues until ✕);
  - picking route points: route icon, ✓, undo, ✕.
  - The icon at the top says what you are doing. Tapping the building icon reopens the Build panel.
- **Tapping another ship or building** shows its strip (its quick info lives here).
- **Never both sides open.** While the panel is open, the strip slides away; when the panel closes, it comes back.
- **Esc order:** close the fly-out, then the panel, then clear the strip.

## 1.6 Window, Prompt, HUD

- **Window:** full screen on a phone and dims the world. Close it with ✕ or Esc. Open it only from a panel button that shows when the action will work. (Example: the cargo transfer button only appears when you are docked.)
- **Prompt:** top centre. Only for things needing an answer now, and short toasts. **Nothing else may live at top centre.**
- **HUD:** look and behaviour frozen. Items touching the right edge sit `--rail-w` further in. Any change to how the HUD looks needs the owner's OK.

## 1.7 Where everything lives (the end state)

Some of today's surfaces still exist while the UI-language refactor runs. New work targets this end state, never the old surfaces.

| Thing | Home |
|---|---|
| Build menu | Build panel on the rail (Build mode). It never opens by itself. |
| Warp list, galaxy info | Galaxy panel (Nearby / Far, Warp). "Open full map" opens the map Window. In Command, Warp sends the selected fleet. |
| Contacts | Contacts panel (Fly). The O key opens it. |
| Your own hold | Hold panel (Fly). Tapping the CargoChip opens it. |
| Contracts, bounties | Jobs panel (segmented: Contracts / Bounties). |
| Trade (offers, deals, history, gift, blueprints) | Trade panel (drill-down). |
| Factions, ship look | Faction panel (drill-down to Ship look). |
| Settings, profile, account, logout, debug | Cog panel. The display name is a field; logout confirms inline; Developer is a drill-down. Cog › Display has a Full screen switch and "Install as app". |
| Full screen | The first tap in a touch browser goes full screen. |
| A selected ship, fleet or building | Who hexes on the left (Command) + world tag; its actions (stance, attack, move, More, Clear…) are do hexes, bottom-right. |
| Selection details (bars, inspector sections) | Details panel, from ⚙ on the strip. Building settings use Power / Production / Manage on a segmented control there. |
| Fleet orders, stance, speed, ship list | Orders panel, from ⚙ on the fleet strip, ending in Apply. |
| Placing a building, picking route points | Do hexes (Place/confirm under the thumb, Cancel in the far corner). |
| Cargo transfer, market | Window, opened only from a panel button that works. |
| Level-up, while-away, hangar | Window (`EqxWindow`). |
| Teleport prompts, warp warnings, trade toasts, warp status | Prompt (`EqxPrompt`), top centre. |
| Pilot / spectator toggle | Where it is, on `EqxSegmented`. |
| Weapon cycling | HUD weapon strip and keys. |

Not part of the game screen in the end state: the speed dial, the ☰ drawer, the desktop top bar, the top-right toolbar, bottom-centre floating bars and centred dialogs.

---

# Part 2: the layout rulebook

## 2.1 Where does it go? (decision order; stop at the first yes)

1. **Is it glanceable game state** that should always be visible while playing (no menu, no choices)? → **HUD.** New HUD items, or changes to their look, need the owner's OK.
2. **Does it need an answer right now,** or is it a short notice? → **Prompt** (top centre).
3. **Is it about the thing you have selected, or what you are doing in the world right now,** → **who** is selected goes in the **who hexes** (icons + counts only); **what to do** goes in the **do hexes** (icon + word); its name floats as the **world tag**. A status the player changes often gets a fly-out.
4. **Does it need words, choices, lists or a form?** → **Panel.**
   - If it belongs to a selected thing, it opens from that thing's ⚙ (Details or Orders).
   - Otherwise it is a rail item. A new rail item needs the owner's OK if the rail already has 8.
5. **Does it need two lists side by side, a map, a table or a multi-step editor?** → **Window**, opened from a button inside a panel.

Never allowed again: floating bars (the world tag is the one exception), speed dials, popovers anchored to random spots, centred dialogs outside the Window shell, banners anywhere but top centre, a second panel, both sides open, words on the left strip (counts only).

## 2.2 Placement mechanics

- **Mount through the existing slot system.** Every surface renders inside `<Slot anchor="…">` (`src/client/layout/Slot.tsx`, anchors in `layout/anchors.ts`). Never use your own `position: fixed`.
  - The rail and the strip have their own anchors in the same table: `right-rail` and `left-strip`.
  - The existing safe-area insets (`SAFE_TOP/LEFT/RIGHT/BOTTOM`, `--mobile-edge-inset`) apply.
- **Z-order comes from `layout/zIndex.ts`**, never a literal. Lowest to highest:
  1. canvas
  2. hud
  3. mobileControls
  4. hudOverSticks
  5. **rail and strip**
  6. panel (today's `drawer`)
  7. overlay
  8. Window (`modal`)
  9. **prompt** (above Windows so an answer-me is never hidden)
  10. transit (drag ghost)
  11. rotatePrompt
- **Right edge:** anything that touches the right edge adds `var(--rail-w)` through `SAFE_RIGHT`. Camera framing (`render/galaxy/galaxyFocus.ts`, `components/panelCameraNudge.ts`) accounts for the rail and the open panel.
- **Reserved zones:**
  - top centre is Prompts only;
  - bottom centre is the HUD status capsule only;
  - the top-left corner is the mode switch and top-left HUD (the strip starts below it);
  - the thumb-stick zones stay clear on touch.
- **Check before you place.** Before adding anything visible, list the existing anchors and fixed elements it could collide with (grep `anchor=` and the anchor table). Then take stills on a phone held sideways (863×360) and on desktop.
- **Store:**
  - Which panel is open is one discrete Zustand flag, `rightPanel`.
  - The left strip's content comes from selection and placement state that already exists.
  - Never put positions, sizes or per-frame values in Zustand.

## 2.3 Sizes, colour, type, motion

- **Sizes come from tokens** (`src/client/hud/tokens.ts`):
  - **rail width:** 48 px phone, 56 px desktop;
  - **strip and rail button:** one size token, at least 44 px touch target on a phone;
  - **panel width:** about a third of the screen, using SidePanel's existing size rule;
  - **gaps:** the existing `STACK_GAP` scale.
- **One palette:** the `HUD` tokens. The MUI theme is built from them. Never use a literal colour in a feature file.
- **Colour meanings**, consistent everywhere:

  | Colour | Means |
  |---|---|
  | Cyan (`auto`) | A status / automatic |
  | Amber (`manual`) | Manual, or changed but not applied |
  | Green (`hullOk`) | Healthy, confirm (✓) |
  | Red (`danger` / `hullCrit`) | Danger, Stop, aggressive, cancel |
  | Gold (`credits` / `energy`) | Money and energy |

- **Type:** `HUD.font.label` (Chakra Petch) for words, `HUD.font.num` (JetBrains Mono) for every number.
- **Icons:** only from the catalogue's icon registry (Part 3). No inline SVG in feature files. One icon means one thing across the game.
- **Motion:** slide durations and easing come from tokens. Honour `prefers-reduced-motion`. Panel and strip swap with one slide; never animate both at once.

## 2.4 Input

- **Desktop keys:** Shift + 1–8 for rail items; Esc closes the fly-out, then the panel, then clears the strip. Existing keys stay: O for contacts, the build-menu keys in `input/buildMenuKeys.ts`, rotate and mirror keys while placing.
- **New keys** extend `App.tsx onKey` or `input/buildMenuKeys.ts`. Never add a second key handler.
- **Touch:**
  - long-press shows a tooltip;
  - a swipe right closes the panel;
  - the first tap asks for full screen;
  - phones are played sideways (portrait shows the rotate overlay).
- **Mouse lock:** any open panel or Window releases it through the existing `uiCoversGame` check.

## 2.5 Checklist for any UI task or tweak

1. Find its home with 2.1. If it does not fit, ask the owner; don't invent a ninth kind.
2. Search `src/ui/` for the element. Reuse it, add a prop, or add an entry (Part 3, 3.4). Never build UI in a feature folder.
3. Mount it through a Slot anchor. Take z-order from `zIndex.ts` and sizes and colours from tokens.
4. Left strip: no words, every hex the same size, a tooltip on each. Do hexes: icon + one word each, at most six.
5. Panel: choose the pattern from 1.4; hide actions that can't work; Apply for multi-field forms.
6. Add `data-testid`s. Update e2e specs that pin moved testids and `tests/e2e/featureTriggers.mjs`.
7. If anything is visible, take stills on a phone held sideways (`?art=machined&fx=new`) and on desktop, then do a hostile check: the subject is visible, not clipped, not under the HUD, and not overlapping another surface.
8. **Taste vs bug:**
   - A look or taste change needs the owner's OK first. Show old vs new in an artifact, labelled.
   - A bug fix goes through review, then merge.
9. Update this guide (and `src/ui/README.md`) if the rules or catalogue changed.

---

# Part 3: the EQX catalogue

## 3.1 What and where

- **Folder:** `src/ui/`, next to `src/client`, `src/core` and `src/server`. Nothing else lives there.
- **It wraps MUI v6** (plus emotion, which MUI uses). MUI stays.
- **The only door:** feature code imports from the barrel `src/ui/index.ts` (node16 `.js` imports). It never imports `@mui/*` or `@emotion/*` directly; a lint rule enforces this (3.5).
- **The entry list** (entry, one-line purpose, props) is [src/ui/README.md](../src/ui/README.md). Search it first.
- **Layout:** `index.ts` (barrel), `README.md` (entry list), `theme.ts` (MUI theme built from `hud/tokens.ts`), `icons.ts` (icon registry: game meaning → icon component), and one folder per entry.

## 3.2 The entry contract

Every entry:

1. **Is named `Eqx<Thing>`** and lives in its own folder with a `.tsx`, a `.test.tsx` (vitest + Testing Library) and a `.stories.tsx` (Storybook 8: one story per meaningful state).
2. **Wraps one MUI component, or composes other Eqx entries.** It never re-implements what MUI already does.
3. **Is configured by named props for features and variants,** for example `<EqxDropdown searchable multiple />` or `<EqxButton tone="danger" />`.
   - There is no `sx`, `style` or `className` pass-through.
   - A new look is a new named variant inside the entry, so every use stays consistent.
4. **Takes every size, colour, font and duration from tokens** and the theme. No literals.
5. **Does not position itself.** Placement comes from the Slot it is mounted in.
6. **Forwards `data-testid`** and sets accessible names. An icon-only control uses its `tooltip` as `aria-label`.
7. **Has no game logic.** It takes values and callbacks. Game state stays in feature code and the store.

## 3.3 Tests and stories

- **Tests are the gate** (CI). Every entry tests that it renders, that each prop switches its feature, keyboard and close behaviour where relevant, and the accessible name.
- **Strip entries also test:** no text nodes except badges, every button the same box size, and the icon centred.
- **Stories** are for humans: owner reviews and future agents browsing the catalogue. Coding agents never run a browser, so they write stories but don't view them.

## 3.4 When you need something the catalogue doesn't have

1. Search `src/ui/README.md` and `index.ts`.
2. If an entry is close, **add a prop or variant** to it, with a test and a story.
3. If nothing is close, **add an entry** following 3.2, in its own small PR, before the feature PR that uses it.
4. Never build the element inside a feature folder "just this once". Never copy an entry to tweak it.

## 3.5 The lint wall and the countdown

- **Lint:** the `clientForbidden` `no-restricted-imports` rule in `eslint.config.js` bans `@mui/*` and `@emotion/*` outside `src/ui/**`. Extend that rule; never add a second one.
- **Allowlist:** the files that imported MUI before the catalogue existed are on `scripts/mui-allowlist.json`.
  - `scripts/audit-mui.mjs` runs in CI next to the god-files audit.
  - It fails if a file not on the list imports MUI.
  - It fails if a listed file no longer imports MUI, until that file is removed from the list. The list can only shrink.
- **Countdown:** `pnpm ui:countdown` prints the count. Every UI PR body states the count before and after. When the list reaches zero it is deleted; the ban stays forever.
