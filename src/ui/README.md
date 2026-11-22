# EQX catalogue (`src/ui/`)

The one home of UI elements. Every on-screen control comes from here.
Feature code imports only from the barrel `src/ui/index.ts` (node16 `.js` imports);
raw `@mui/*` and `@emotion/*` imports live only inside `src/ui/`.

## Entries

| Entry | Purpose | Props |
|---|---|---|
| `theme` | The MUI theme, built only from `hud/tokens.ts` | none |
| `EqxThemeProvider` | The EQX look for a React tree: theme + CssBaseline + HUD fonts. Wraps the app root and every story | `children` |
| `EqxButton` | Text button | `tone` (primary / secondary / danger), `size` (small / medium / large, default small), `disabled`, `onClick`, `data-testid` |
| `EqxIconButton` | The one icon button (rail, left strip, fly-outs). One fixed box (`HUD.size.iconButton`), icon centred, no label | `icon`, **required** `tooltip` (also the aria-label), `tone`, `active`, `badge`, `holdMs`, `disabled`, `onClick`, `variant` (`round` default; `rail` / `railTool`: the right-rail tile, dim / bright; `strip` = left-strip rounded-square tile: primary = green ok, danger = red outline), `status` (strip: `calm` cyan / `alert` red icon; `active` = open ring), `data-testid`, `data-state` (a machine-readable state for tests, e.g. Target's `lock` / `cancel` / `blocked` / `unlock`) |
| `EqxTooltip` | Tooltip: hover on desktop, press-and-hold on touch | `title`, `holdMs` |
| `EqxSwitch` | On / off | `checked`, `onChange(checked)`, `label` (also the accessible name), `disabled`, `data-testid` |
| `EqxStrip`, `EqxStripIdentity` | The left strip: one icon column, NO text except count badges; `EqxStrip.Separator` is a thin rule. Width = one button + theme gap; `open` slides it fully off to the left (HUD.motion, reduced-motion = instant); never positions itself. Identity = small ROUND icon, ring colour = health | Strip: `children` (icon buttons / identity / status fly-out / Separator only, else dev warning), `orientation` (vertical default / horizontal = one row, used by the fly-out), `open`, `aria-label`, `data-testid`. Identity: `icon`, **required** `tooltip`, `health` (ok / warn / crit), `count` (badge when > 1), `onClick`, `holdMs`, `data-testid` |
| `EqxStatusFlyout` | A left-strip status icon (current order, stance, power) whose options fly out to its right as same-size icon buttons in a horizontal `EqxStrip`, no text. A pick calls `onChange(id)` once and closes; outside tap or Esc (taken first, before other Esc handlers) closes without a change; current option marked active. Renders in place, so it takes the strip Slot's z-order | `value`, `options` (`id`, `icon`, `tooltip`, `tone`), `onChange(id)`, **required** `tooltip` (trigger name), `holdMs`, `disabled`, `data-testid` (options: `<id>-options`, `<id>-option-<optionId>`) |
| `icons` | Registry (`icons.tsx`): one game meaning -> one line icon (the mock-ups' paths). One icon means one thing (tested); `EqxIconName` is a string union. Add a meaning there, never import an icon in a feature | `EQX_ICONS`, `EQX_ICON_NAMES`, `EqxIconName` |
| `EqxIcon` | Draws the registered icon for a meaning, e.g. `<EqxIcon name="patrol" />`. Colour inherited; decorative unless titled | `name`, `size` (small / medium / large from `HUD.size.iconGlyph`, default medium), `title` (accessible name), `data-testid` |
| `EqxDropdown` | Pick from a list; `searchable` = type to filter (MUI Autocomplete), plain = MUI Select | `options` (`id`, `label`), `value` (id or null; ids array if `multiple`), `onChange`, `label` (also the accessible name), `searchable`, `multiple`, `placeholder`, `disabled`, `data-testid` |
| `EqxTextField` | Text input | `label` (also the accessible name), `value`, `onChange(text)`, `error` (message; sets the error state), `placeholder`, `disabled`, `data-testid` |
| `EqxSlider` | Range | `min`, `max`, `step` (default 1), `marks` (`true` or `{ value, label? }[]`), `value`, `onChange(number)`, `label` (aria-label), `disabled`, `data-testid` |
| `EqxSegmented` | Pick one of 2-5 views or values (throws in dev outside 2-5). Default = panel look: full width, equal segments; selected = cyan, changed (not yet applied) = amber. `hud` = the frozen over-the-game mode-switch look (tokens `HUD.segmentedHud`). `onChange` once per pick; group carries `data-value` | `options` (`id` + `label` + optional leading `icon` and `ariaLabel`, or `id` + `icon` + `tooltip`; each may add `testId` and `onPress(button)`, which fires on every press), `value`, `onChange(id)`, `label` (group name), `appliedValue` (the value in force; a differing `value` shows amber, group gets `data-changed`), `hud`, `disabled`, `data-testid` |
| `EqxPanel` | The one right panel (SidePanel evolved; `client/components/SidePanel.tsx` re-exports it). Right dock on landscape, bottom sheet on a portrait phone; closes by ✕, Esc (`closeOnEscape`) and a swipe out | `open`, `onClose`, `testId`, `title`, `onBack` (← back), `apply` (`onApply`, `dirty`: Apply is filled cyan, dimmed and off when clean, enabled when dirty (the amber cue is on the changed EqxSegmented, `appliedValue`); `label`; `secondary` outlined action), `body` (`padded` mock body / `bare`), `size` (`EQX_PANEL_SIZE` = the mock dock: right edge, full height, 36% of the width), `closeOnEscape`, `paperAttrs`, `handleTestId` / `headerTestId` / `closeTestId`. Known debts (move at U4-1): literal radii, grab-pill colour and swipe distance; `escapeClosesPanel` reads the store; the toolbar-notch header still imports GameWindow's header SX |
| `EqxRail` | The slim right rail (mock .rail): a full-height rail-paper column; the mode `tools` (bright tiles), a divider, the always-there `items` (dim tiles), the cog pinned at the bottom; labels only in tooltips; at most 8 items plus the cog (more throws in dev, prod shows 8). Width `HUD.size.railPhone` when `compact`, else `railDesktop`; `compact` defaults to the `(pointer: coarse)` query. Fills its parent; never positions itself | `tools`, `items` (each `id`, `icon`, `tooltip`, `badge`), `activeId`, `onPick(id)`, `cog` (`{ icon, tooltip, id }`, or `true` for the default cog with id `cog`), `compact`, `data-testid` (buttons get `<testid>-<id>`) |
| `EqxBar` | A readout bar (mock .lrow + .bar): with `label` a full-width row (label column, track fills the rest); `short` = a bare inline track. Fill eases; colour by `tone` (`hull` = hull thresholds green / gold / red, `shield` cyan, `charge`). Sizes in `HUD.bar` | `pct` (0-100, clamped), `tone`, `label`, `short`, `data-testid` (also `data-pct`, `data-tone`) |

## Extend, never hand-roll

- Never build a control inside a feature folder "just this once". Never copy an entry to tweak it.
- No `sx`, `style` or `className` pass-through. A new look is a new **named prop or variant** inside the entry.
- Every size, colour, font and duration comes from `src/client/hud/tokens.ts` or the theme. No literals.
- Entries never position themselves; placement comes from the Slot they are mounted in.
- Entries hold no game logic: values in, callbacks out.

## Entry contract

One folder per entry, named `Eqx<Thing>`, holding `Eqx<Thing>.tsx`, `Eqx<Thing>.test.tsx`
(renders; each prop switches its feature; accessible name) and `Eqx<Thing>.stories.tsx`
(one story per meaningful state). It wraps one MUI component or composes other Eqx entries,
forwards `data-testid`, and an icon-only control uses its `tooltip` as `aria-label`.
Export it from `index.ts` and add a row above.

## When you need something the catalogue does not have

1. Search this README and `index.ts`.
2. If an entry is close, **add a prop or variant** to it, with a test and a story.
3. If nothing is close, **add an entry** following the contract, in its own small PR, before the feature PR that uses it.
4. Never build the element inside a feature folder. Never copy an entry to tweak it.
