# Robots (Living World P1b)

Plan: `peppy-jumping-pinwheel`. Builds on the allegiance framework (P0,
[docs/architecture/allegiances.md](../architecture/allegiances.md)) and the
loot loop (P1a, [loot-and-cargo.md](loot-and-cargo.md)).

## What the player sees

A third side roams the galaxy: violet geometric ships that attack **everyone**
on sight — players, drones, and (from P2) trade haulers. They are the reason a
quiet sector can turn into a three-way fight, and their wrecks drop the best
loot in the game so far.

| Tier | Kind id | Hull | Weapon | HP / shield | Kill bounty (credits → the killer's wallet, economy v2) |
|---|---|---|---|---|---|
| T1 | `robot-square` | square | bolts | 120 / 80 | 8–20, salvage, some alloy |
| T2 | `robot-circle` | 12-gon | continuous beam | 220 / 140 | 20–45, more alloy, rare core |
| T3 | `robot-hexagon` | hexagon | homing missiles | 420 / 260 | 45–90, alloy, 30 % core |

A robot squad is **mixed-tier**: one hexagon leads, two circles flank, three
cubes fill out the pack (6 ships). Four squads (24 robots) roam the galaxy.
The incoming-warp banner shows robot squads as hostile (red, "6 × Robot"),
and the galaxy map counts them as enemies.

## How it works

The robot side is a **second `LivingWorldDirector` instance** — the same
roam / flock / respawn / hop machinery the drones use — configured by
`ROBOT_DIRECTOR_OPTIONS` in
[src/server/livingworld/robotDirector.ts](../../src/server/livingworld/robotDirector.ts):

- **Ids:** bots are `rbot-*` in `rsquad-*` squads, so they never collide with
  the drone director's `lwbot-*` / `squad-*`. Any code that asks "is this an NPC
  bot?" uses `isDirectorBotId` (`directorBotIds.ts`), never a prefix literal.
- **Per-slot hulls:** `SquadLayout.memberKind(squadIndex, memberIndex)` sets
  each slot's hull; `SquadPool.memberKindOf(botId)` is what the director stamps
  on each bot. The drone default stays homogeneous `fighter` squads.
- **No waves:** `wavesEnabled: false`. Robots never get dispatched at bases.
  Their hostility comes from the shared stance table (P0): the room AI engages
  anything another side owns within `ON_SIGHT_ENGAGE_RANGE`. The director
  only moves them around.
- **Galaxy map:** the drone director (the `/galaxy/snapshot` provider) takes a
  `hooks.extraEnemyCounts` callback fed by the robot director's
  `activeBotCountsBySector()`.
- **Persistence:** the robot director saves its squad continuity to the new
  `allegiance_director_state` table (row `robots`) through the
  `ALLEGIANCE_DIRECTOR_STATE_PUT` op. The drone director keeps the old
  singleton `director_state` row, whose `CHECK (id = 1)` can't be relaxed in
  place.
- **Kill switches:** `EQX_DISABLE_ROBOTS=1` disables only the robots;
  `EQX_DISABLE_LIVING_WORLD=1` disables both directors.
- **Inspect:** `GET /dev/population?allegiance=robots`.

## Cost

`benchmarks/ai-allegiance.bench.ts` packs all 56 drones + 24 robots + 4 players
into ONE sector (the worst case for the cross-allegiance view): **0.35 ms mean,
0.63 ms p99 per AI tick** on the dev box, inside the plan's 1.5 ms budget. The
drones-only shape is ~0.005 ms because a single-allegiance sector skips the
cross-side view entirely.

## Tests

- `src/server/livingworld/robotDirector.test.ts` — layout, prefixes, kill switch, per-slot seeding.
- `tests/integration/sectorRoom/robotDirector.test.ts` — real rooms: `rbot-`
  mixed-tier squads spawn, NO wave at a ready base (verified red with the gate
  removed), a killed robot respawns with its slot's hull.
- `LivingWorldDirector.galaxySnapshot.test.ts` — robots counted as enemies.

## Next (P3)

Robot territory, a nexus that spawns reinforcements, harvesters that collect
loot pods, merge clusters, and robot-only weapons (`pulse-orb`, `charge-laser`).
