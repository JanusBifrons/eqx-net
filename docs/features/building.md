# Building — placeable power-grid structures

*Player-facing guide. System internals live in
[../architecture/structures-and-power-grid.md](../architecture/structures-and-power-grid.md);
the executable roadmap is [../plans/speed-dial-resource-structures.md](../plans/speed-dial-resource-structures.md).*

EQX Peri lets you build a base out of connected structures, modelled on the
flash game *The Space Game*: place structures, link them through hubs, and a
1 Hz pulse moves **power** and **minerals** around the web.

## The speed dial

All discrete (tap) HUD actions now live in one **bottom-right SpeedDial** FAB —
the galaxy **Map** toggle, the **Weapon**-slot selector, the **Panels** (drawer)
entry, and **Build ▸**. Your held controls (joystick / FIRE / BOOST) stay as
dedicated buttons; a tap-to-expand menu is the wrong place for an input you hold.

## Building (Phase 2 — shipped)

1. Open the speed dial → **Build ▸** → pick a structure kind.
2. A confirm banner appears: **Place \<Kind\> ahead?** — *Confirm* drops the
   structure a short distance ahead of your ship; *Cancel* exits.
3. The structure appears in the world and is immediately **damageable**.

> **First cut:** placement drops the structure *ahead of your ship*. A
> tap-to-position blueprint ghost (a translucent silhouette that follows the
> cursor with a connection-range ring and live valid/invalid tint) is a planned
> refinement.

### The five kinds

| Kind | Role | Notes |
|---|---|---|
| **Capital** (Core) | Pre-built root hub + the main mineral bank | Born fully built; links up to 4 others |
| **Connector** (Relay) | Cheap pure hub — the linking mechanism | Links up to 6; everything else attaches to a hub |
| **Solar Panel** | Power generator | A leaf — attaches to one hub |
| **Mining Tower** | Drills asteroids for minerals | A leaf — power-gated |
| **Turret** | Shoots hostile drones | A leaf — power-gated |

**Connection rule:** leaves (solar / miner / turret) attach to exactly **one
hub** (a Connector or the Capital) — never to each other. Hubs link to hubs to
extend the web. (The grid + connections land in Phase 3.)

## Roadmap (not yet shipped)

- **Phase 3** — the power grid + connectors + the *flow-economy construction*:
  a placed structure is a **blueprint** (10 % HP, non-operational) that builds up
  gradually by pulling minerals from connected storage over the 1 Hz pulse; runs
  dry → construction pauses, refills → resumes.
- **Phase 4** — mining towers + mining lasers + minerals.
- **Phase 5** — defensive turrets.

## What's shipped so far

- **Phase 1** — the consolidated bottom-right SpeedDial (Map / Weapon / Panels).
- **Phase 2** — the structure catalogue, server-authoritative placement
  (blueprint at 10 % HP; Capital pre-built), per-subtype rendering, and the
  Build → place UI. Structures render and take damage; the grid/economy that
  feeds them is Phase 3.
