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
| ● / ○ / · | In lock reach of the active group (group colour) / of another group only / of none. Lock reach is the group's weapon reach × `LOCK_TUNING.reachSlack`, the same rule the server uses |
| Distance | `450 m`, `3.2 km`, `39 km` (1 km = 1,000 u) |
| Lock | `LOCK` or the acquiring percent (capped at 99 until the lock completes, like the lock band) in the colour of the group holding it; yellow while a failsafe runs |

Rows out of every group's reach are dimmed. The list sorts hostiles first, then
by distance; the header button switches to nearest first. It shows at most 40
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

- **Desktop:** press **O**, or click the CONTACTS tab.
- **Touch:** tap the CONTACTS tab.

## Where it sits, and why

The audit of fixed and slotted HUD positions: top-left holds the sector chip,
the pilot/spectate toggle and the cargo chip; top-centre holds the status
capsule, the lock band, prompts and warnings; top-right holds the speed dial;
the weapon strip sits on the right edge near mid-height; on touch the move
stick and lock-line stick own the left and right 44 % from 28 % of the height
down, with their homes and BOOST in the bottom corners.

The overview is a dock on the **left edge at 30 % of the height**, the mirror
of the weapon strip on the right (guns right, targets left). The tab is always
there; the list opens under it. Its height is capped at
`min(360px, 70dvh − 154px)`, so on a phone it ends above the move stick's home
(on an 844 × 390 landscape phone: about 10 px clear) and never reaches the
right-hand controls. Top-centre, the one free zone on mobile, was not used: a
list there would sit over your own ship. Like the weapon strip dock it sits
above the floating-stick zones, so its rows take taps; while it is open, the
part of the move-stick zone it covers starts no stick. Close it and that area
is back.

## How it works

- Pure row building in `src/client/components/contactRows.ts`
  (`buildContactRows`, `sortContacts`, `formatContactKm`, `contactTapAction`).
- `ContactsOverview.tsx` polls the render mirror at 4 Hz while open and
  re-renders only when what's shown changes. Closed, it polls nothing.
- Group reach comes from `ColyseusClient.fcGroupReach(groupId)`: the same
  per-slot `weaponAutoFireRange` max as the server's `groupGeometry`.
- The only store field is the discrete `contactsOpen` flag (invariant #2).

## Tests

- Unit: `contactRows.test.ts` (lockable set, names not ids, reach with the
  slack, lock and locking-you state, sort, km format, tap action),
  `MouseLock.test.ts` (O).
- Component: `ContactsOverview.test.tsx` (names not ids, a tap sends
  `lock_request` for the active group, a tap on a locked row cancels, 4 Hz
  refresh).
- E2E: `tests/e2e/contacts-overview.spec.ts` (`fc-duel`, `instantLock`): desktop
  O + click locks and cancels; touch landscape tab + tap locks, and the open
  list stays clear of the move stick's home and BOOST.

## Next

- Filters (hostiles only, ships only) and a column for the lock time estimate.
- A shot in the showcase reel alongside the real-scale ranges shot.
