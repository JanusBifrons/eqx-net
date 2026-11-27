# Battle scenarios

<!-- showcase-exempt: play-test rooms for feeling out battles, not a feature of the game world -->

Five ready-made battles for feeling out how a fight plays, as a pilot or as a
commander. No bases, no turrets, no rocks: two fleets in empty space.

## Why

The owner wanted to feel battles at fleet scale (capital lines, sub-cap
swarms, mixed fleets) without building them by hand. Earlier test setups put
both sides inside weapons range at the start, so the fight was already on when
the room opened. Here the fleets **start apart and fly in**: the opening
seconds are the lines closing, and the first shots come as they pull into
range.

## The rooms

Open with `?room=<name>&shipKind=<hull>` (on the phone lane: the lane link
plus those). Add `&startMode=command` to start in command view. Sign in first
so the fleet is yours to command.

| Room | Your side | Enemy | Join as | Start gap |
|---|---|---|---|---|
| `battle-capitals` | you + battlecruiser, heavy + light cruiser, 2 destroyers | battleship, battlecruiser, heavy + light cruiser, 2 destroyers | `battleship` | 42 km |
| `battle-caps-vs-subcaps` | you + heavy + light cruiser, 2 destroyers | 16 fighters, 8 heavies, 6 gunships, 4 missile frigates | `battleship` | 40 km |
| `battle-subcaps-vs-caps` | you + 7 fighters, 4 heavies, 4 gunships, 2 missile frigates | battleship, heavy + light cruiser, 2 destroyers | `fighter` | 40 km |
| `battle-subcaps` | you + 6 fighters, 3 heavies, 2 gunships, 2 missile frigates | 8 fighters, 2 interceptors, 4 heavies, 3 gunships, 2 missile frigates | `fighter` | 8 km |
| `battle-mixed` | you + heavy cruiser, destroyer; a wing of 6 fighters, 3 heavies, 2 gunships 4 km ahead | battleship, heavy cruiser, destroyer; a wing of 7 fighters, 3 heavies, 2 gunships, 2 missile frigates 4 km ahead | `battleship` | 46 km |

Each side is a north-south line, every hull nose north, so the fleets start
side-on. Your hull sits in the gap in the middle of your line. Each gap is a
little past the longest gun on the field (a battleship reaches ~38.7 km).
A unit test checks that no ship reaches any enemy at the start and that first
contact comes within 30 s at full closing speed.

Leaving and rejoining starts a fresh battle: the room is thrown away when the
last pilot leaves, and a new one clears the last run's ships first.

## How it works

Built on the perf-scene timeline (`sceneScript`, `SceneScriptRunner`), with
no new system:

- **Your side** is a `fleet` step: parked hulls owned by you, flown by the AI
  pilot (hunt, aggressive). Command them like any fleet.
- **The enemy** is `spawn` steps marked hostile. A hostile mark is forgotten
  after ~30 s without a hit, so a repeating `aggro` step re-marks each enemy
  group every 20 s for 10 minutes and they keep closing.
- **Sealed** like the [sandbox](sandbox.md) (`sealedSectors.ts`): never saved,
  no exits, no real credits, and its ships never reach your real Hangar.

Code: `src/server/rooms/testRooms/battleRooms.ts` (the layouts and
`BattleRoom`). Registered with the sandbox (`shouldRegisterSandboxRoom`), so
they are on the phone lane. Like the sandbox, client create options never
reach the room. A scene script now runs in testMode rooms and in sealed
sectors. Lock: `battleRooms.test.ts`.

## Future plans

- Pretty room names in the HUD (it shows the raw room name).
- More mixes as the owner asks: fleet sizes, carriers, an ambush from the side.
- A pick-your-battle list in the Hangar instead of links.

## History

- **2026-11-27.** First five rooms. The owner's brief: capitals against
  capitals, capitals against sub-caps, many sub-caps, and mixed fleets,
  nowhere near any base, "just pulling into weapons range now".
