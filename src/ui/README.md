# EQX catalogue (`src/ui/`)

The one home of UI elements. Every on-screen control comes from here.
Feature code imports only from the barrel `src/ui/index.ts` (node16 `.js` imports);
raw `@mui/*` and `@emotion/*` imports live only inside `src/ui/`.

## Entries

| Entry | Purpose | Props |
|---|---|---|
| `theme` | The MUI theme, built only from `hud/tokens.ts` | none |
| `EqxButton` | Text button | `tone` (primary / secondary / danger), `size` (small / medium / large, default small), `disabled`, `onClick`, `data-testid` |
| `EqxIconButton` | The one icon button (rail, left strip, fly-outs). One fixed box (`HUD.size.iconButton`), icon centred, no label | `icon`, **required** `tooltip` (also the aria-label), `tone`, `active`, `badge`, `holdMs`, `disabled`, `onClick`, `data-testid` |
| `EqxTooltip` | Tooltip: hover on desktop, press-and-hold on touch | `title`, `holdMs` |
| `EqxSwitch` | On / off | `checked`, `onChange(checked)`, `label` (also the accessible name), `disabled`, `data-testid` |
| `EqxRail` | The slim right rail: EqxIconButtons top to bottom, cog pinned at the bottom, labels only in tooltips; at most 8 items plus the cog (more throws in dev, prod shows 8). Width `HUD.size.railPhone` when `compact`, else `railDesktop`; `compact` defaults to the `(pointer: coarse)` query. Fills its parent; never positions itself | `items` (`id`, `icon`, `tooltip`, `badge`), `activeId`, `onPick(id)`, `cog` (`{ icon, tooltip, id }`, or `true` for the default cog with id `cog`), `compact`, `data-testid` (buttons get `<testid>-<id>`) |

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
