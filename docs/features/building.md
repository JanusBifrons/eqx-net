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

## The grid (Phase 3 — shipped)

Place a **Capital** first (it's pre-built — your base's root + mineral bank).
Then place **Connectors** and leaves in range: each new structure auto-links to
the nearest in-range **hub** (a Connector or the Capital). A blue web draws
between linked structures; it brightens orange in a pulse when minerals flow.

A freshly-placed structure is a **blueprint** (dim, with a blue fill-bar). Every
1-second pulse it pulls minerals from your Capital's bank and the fill-bar climbs
— when full, it snaps to solid and joins the live grid. If the bank runs dry,
construction simply **pauses** and resumes when minerals return (no progress
lost). An unbuilt Connector is a **dead end**: leaves hanging off it only start
building once *it* completes — so a base grows outward, Capital → Connector →
leaves. The top-left **⚡ readout** shows your grid's net power.

Damaged built structures slowly **repair** from the bank too.

## Mining (Phase 4 — shipped)

Place a **Mining Tower** near an asteroid (within range) and keep it **powered**
(add Solar panels so your grid's net power stays ≥ 0). Each pulse it fires a
mining beam, extracts minerals, and hauls them down the web to your Capital — the
⛏ readout climbs. An unpowered tower sits idle. Asteroids don't deplete (first
cut).

## Turrets (Phase 5 — shipped)

Place a **Turret** near where drones roam and keep it **powered**. It tracks the
nearest drone in range and fires on a cooldown, killing it — your automated base
defence. An unpowered turret holds fire, so balance generation against your
miners' + turrets' draw.

The base-building feature set is now complete: place structures, link them
through hubs, build them up via the mineral flow, mine to refill the bank, and
defend with turrets — all over one 1-second logistics pulse.

## What's shipped so far

- **Phase 1** — the consolidated bottom-right SpeedDial (Map / Weapon / Panels).
- **Phase 2** — the structure catalogue, server-authoritative placement
  (blueprint at 10 % HP; Capital pre-built), per-subtype rendering, Build → place UI.
- **Phase 3** — the power grid: connectors + the connector web, the construction
  flow economy (build / pause / resume / dead-end), repair, deconstruction, and
  the grid-power HUD.
- **Phase 4** — mining towers extract minerals (power-gated) and haul them to the
  Capital; mineral-bank HUD + mining beam.
- **Phase 5** — defensive turrets track + destroy drones in range (power-gated).
