# Contacts overview (lock list)

With real-scale gun ranges a 16" turret reaches 38.7 km, and at the zoom
needed to see that far a fighter is about 1.6 px. The owner's call
(2026-11-10): pilots should not zoom out to 30 km to pick targets, they should
"lock and pick targets like you do in Eve where you're reduced to a list view
like you use when you warp to". The contacts overview is that list.

## What it shows

A compact table, one row per thing you can lock (the same set the lock line
considers): NPC ships and capitals, other pilots' ships, and structures that
aren't yours. Asteroids, scrap, your own structures and NPCs mid warp run are
left out. Columns (owner, 2026-11-22: a table with filters, sortable, paged,
nearest first, type, faction and stance columns, rows coloured by stance):

| Column | Meaning |
|---|---|
| Name | Kind icon (the shared visual language, `render/entityVisuals.ts`: red star hostile NPC, amber diamond neutral NPC, green triangle pilot, blue hexagon structure), then the kind or elite name (a pilot's ship by its hull, a structure by its kind). Never an id. Nothing else shares the cell, so the name keeps its width on a phone held sideways |
| Lock | ⚠ / ◎ in red when it has you locked / is locking you (`localLockedBy`), then `LOCK` or the acquiring percent (capped at 99, like the lock band) in the colour of the group holding the lock, yellow while a failsafe runs; empty otherwise. Sorting by it (ascending) lists your locks first (locked, then acquiring), then whatever is locking you |
| Type | Ship or Structure |
| Faction | Whose it is: an NPC patrol's faction, else its kind's allegiance (Drones, Robots, Traders, ...); a pilot's name for a pilot's ship; a structure's owner (NPC faction, player name, or "Unknown"). Never an id |
| Stance | Hostile / Neutral / Friendly, from the same rule as the radar and far-zoom icons (`farIconRelation`, `render/relationToLocal.ts`): anything aggro on you, aiming at you or locking you is Hostile first; other pilots and their structures are Friendly; the rest (trade haulers too) Neutral |
| Dist | ● / ○ / · (in FIRE reach of the active group in group colour / of another group only / of none: the weapon reach, not a lock limit, locks reach the ship's longest gun, `shipLockRange`), then `450 m`, `3.2 km`, `39 km` (1 km = 1,000 u) |

- **Row colour** is the stance colour (hostile red, neutral amber, friendly
  green: the radar's relationship colours, `ENTITY_VISUALS`). Rows out of
  every group's fire reach are dimmed (still lockable); the active group's
  own lock tints the row.
- **Sorting:** tap any header to sort by it (▲ ascending, ▼ descending; a
  second tap flips). The tapped column becomes the primary key and the one
  before it the tie-break, so Dist then Stance lists hostiles, then neutrals,
  then friendlies, each nearest first. Stance ascending is hostile first.
  Default: distance ascending. Remaining ties fall back to distance, then the
  lock key, so rows never swap between refreshes.
- **Widths:** Name and Faction share what the fixed columns leave (2.5 : 1;
  Faction ellipsizes first); Lock 44 px, Type 46, Stance 46, Dist 50. Sized
  for a ~305 px table on a phone held sideways (the panel is 36vw).
- **Pages:** 8 rows a page; ‹ Prev / Next › and "Page X of Y" show when there
  is more than one page. A sort or filter change goes back to page 1.
- **Filters:** the funnel button next to the group line shows or hides them
  (it stays lit while any filter is on): Type (All / Ship / Structure),
  Stance (All / Hostile / Neutral / Friendly) and Faction (the factions in
  the list). Hidden filters stay applied.
- Sort, filters and page are the panel's own state: they survive the 4 Hz
  refresh, and reset when the game reloads.

## Selecting from it

- Tap or click a row: it SELECTS that contact, never locks it (owner: "it's
  never tap to lock"). The renderer focuses it exactly as a map tap does
  (`IFleetView.focusEntity`, worker `FOCUS_ENTITY`) and the panel closes, so
  the left strip shows its icons: Details to inspect, Lock to lock it.
- The Lock column only displays lock state; locking goes through the strip,
  the info box or the T key, and the server still checks the lock rules.

## Opening it

Contacts is a right panel (UI language plan, job U2-3): the rail's **Contacts**
item opens it in every control mode (Fly, Command and Build), like Galaxy, Jobs
and Trade.

- **Desktop:** press **O** (any mode), or click the rail's Contacts item
  (Alt + its rail number works too).
- **Touch:** tap the rail's Contacts item.
- ✕, Esc, O again or a second rail tap close it; opening another panel
  replaces it.

## Where it sits, and why

It is the one right panel (`EqxPanel`, docked left of the rail at the mock
size `EQX_PANEL_SIZE`), so it never covers the thumb sticks or BOOST and
needs no placement of its own. Until 2026-11-22 it was a dock on the LEFT edge
with its own CONTACTS tab; the UI language plan moved every list into the right
panel and keeps the left side for the selection strip.

## How it works

- Pure row building in `src/client/components/contactRows.ts`
  (`buildContactRows`, `contactStance`, `sortContacts` + `tapContactSort`,
  `filterContacts` + `contactFactions`, `formatContactKm`); a row's lock key
  maps to the map pick's id + kind in `components/contactFocus.ts`
  (`s:<n>` → `swarm-<n>` drone / structure, `p:<key>` → ship / lingering).
- `src/client/panels/ContactsPanel.tsx` polls the render mirror at 4 Hz while
  open and re-renders only when what's shown changes. Closed, it polls nothing.
  The table is the catalogue `EqxTable` (sortable headers, `onRowTap`,
  `rowColor`, `rowDim`, `rowSelected`, `rowDataAttrs`, paging); filters are
  `EqxSegmented` / `EqxDropdown` behind an `EqxIconButton`. Rows carry
  `data-key`, `data-kind`, `data-type`, `data-faction`, `data-stance`,
  `data-lock`, `data-lock-group`, `data-in-reach`, `data-locking-you`.
- Group reach comes from `ColyseusClient.fcGroupReach(groupId)`: the same
  per-slot `weaponAutoFireRange` max as the server's `groupGeometry`.
- The only store field is the one right-panel flag, `rightPanel === 'contacts'`
  (invariant #2).

## Tests

- Unit: `contactRows.test.ts` (lockable set, names not ids, reach with the
  slack, lock and locking-you state, type / faction / stance, the multi-key
  sort and header taps, filters, km format), `contactFocus.test.ts` (key →
  focus id + kind),
  `MouseLock.test.ts` (O).
- Component: `panels/ContactsPanel.test.tsx` (rail pick and O open it, ✕ and
  Esc close it, names not ids, stance colours, header sort and tie-break,
  sort kept across the refresh, filters hide and narrow, faction options,
  paging, a row tap focuses the entity and closes the panel without
  locking or unlocking, 4 Hz refresh);
  `layout/RightPanelHost.test.tsx` (Contacts on the rail in every mode).
- E2E: `tests/e2e/contacts-overview.spec.ts` (`fc-duel`, `instantLock`): desktop
  O + click selects (strip shows, no lock); touch landscape: the rail's
  Contacts item + tap selects, ✕ closes.

## Next

- A column for the lock time estimate.
- A shot in the showcase reel alongside the real-scale ranges shot.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Contacts panel (lock list).** `panels/ContactsPanel.tsx` + pure `components/contactRows.ts`: the far-target picker, the `contacts` right panel (rail item in every mode, or O). Polls the mirror at 4 Hz only while open; only `rightPanel` is in Zustand. Rows lock through `requestLock` / `cancelLock` for the active group, the same messages as the info box. History: until 2026-11-22 a left-edge dock (`components/ContactsOverview.tsx`, CONTACTS tab, `contactsOpen` flag). See [docs/features/contacts-overview.md](contacts-overview.md).
