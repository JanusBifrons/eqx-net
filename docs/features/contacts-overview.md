# Contacts overview (lock list)

With real-scale gun ranges a 16" turret reaches 38.7 km, and at the zoom
needed to see that far a fighter is about 1.6 px. The owner's call
(2026-11-10): pilots should not zoom out to 30 km to pick targets, they should
"lock and pick targets like you do in Eve where you're reduced to a list view
like you use when you warp to". The contacts overview is that list.

## What it shows

A compact panel, one row per thing you can lock (the same set the lock line
considers): NPC ships and capitals, other pilots' ships, and structures that
aren't yours. Asteroids, scrap, your own structures and NPCs mid warp run are
left out. Each row:

| Part | Meaning |
|---|---|
| Icon | The shared visual language (`render/entityVisuals.ts`): red star hostile NPC, amber diamond neutral NPC, green triangle pilot, blue hexagon structure |
| Name | Kind name, elite name, pilot display name, or "Turret · Owner" for a structure. Never an id |
| ⚠ / ◎ (red) | It has you locked / is locking you (`localLockedBy`) |
| ● / ○ / · | In FIRE reach of the active group (group colour) / of another group only / of none: the group's weapon reach, not a lock limit (locks reach the ship's longest gun, `shipLockRange`) |
| Distance | `450 m`, `3.2 km`, `39 km` (1 km = 1,000 u) |
| Lock | `LOCK` or the acquiring percent (capped at 99 until the lock completes, like the lock band) in the colour of the group holding it; yellow while a failsafe runs |

Rows out of every group's fire reach are dimmed (still lockable). The list sorts hostiles first, then
by distance; the switch under the header picks nearest first. It shows at most 40
rows.

## Locking from it

- Tap or click a row: the ACTIVE weapon group asks to lock it (`lock_request`,
  the same message the info box's LOCK and the T key send).
- Tap a row the active group is already locking or has locked: that lock is
  cancelled (`lock_cancel`, like CANCEL LOCK / UNLOCK).
- A row locked by a different group locks it with the active group as well.

Nothing about lock-to-fire changes: the server still checks reach, lock time
and the lock rules, and a weapon still fires only at a completed lock.

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
  (`buildContactRows`, `sortContacts`, `formatContactKm`, `contactTapAction`).
- `src/client/panels/ContactsPanel.tsx` polls the render mirror at 4 Hz while
  open and re-renders only when what's shown changes. Closed, it polls nothing.
  Rows are catalogue `EqxListRow` action rows (`onTap`, `dim`, `selected`,
  `dataAttrs`); the sort is an `EqxSegmented`.
- Group reach comes from `ColyseusClient.fcGroupReach(groupId)`: the same
  per-slot `weaponAutoFireRange` max as the server's `groupGeometry`.
- The only store field is the one right-panel flag, `rightPanel === 'contacts'`
  (invariant #2).

## Tests

- Unit: `contactRows.test.ts` (lockable set, names not ids, reach with the
  slack, lock and locking-you state, sort, km format, tap action),
  `MouseLock.test.ts` (O).
- Component: `panels/ContactsPanel.test.tsx` (rail pick and O open it, ✕ and
  Esc close it, names not ids, sort switch, a tap sends `lock_request` for the
  active group, a tap on a locked row cancels, 4 Hz refresh);
  `layout/RightPanelHost.test.tsx` (Contacts on the rail in every mode).
- E2E: `tests/e2e/contacts-overview.spec.ts` (`fc-duel`, `instantLock`): desktop
  O + click locks and cancels; touch landscape: the rail's Contacts item + tap
  locks, ✕ closes.

## Next

- Filters (hostiles only, ships only) and a column for the lock time estimate.
- A shot in the showcase reel alongside the real-scale ranges shot.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Contacts panel (lock list).** `panels/ContactsPanel.tsx` + pure `components/contactRows.ts`: the far-target picker, the `contacts` right panel (rail item in every mode, or O). Polls the mirror at 4 Hz only while open; only `rightPanel` is in Zustand. Rows lock through `requestLock` / `cancelLock` for the active group, the same messages as the info box. History: until 2026-11-22 a left-edge dock (`components/ContactsOverview.tsx`, CONTACTS tab, `contactsOpen` flag). See [docs/features/contacts-overview.md](contacts-overview.md).
