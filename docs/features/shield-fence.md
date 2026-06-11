# Shield Fence (player-facing)

A **shield fence** is a defensive barrier you build from two **Shield Pylons**: a
glowing energy **wall** springs up in the span between them, blocking enemy ships
and absorbing their fire. It's the EQX-Peri shield-wall ported into EQX-Net, built
on the new **battery** power buffer.

## Building one

1. Open **Build ▸** on the speed-dial and place a **Shield Pylon** (the blue
   shield icon). It's a *hub* — it consumes 20 power and needs a path to your
   Capital to operate, like any structure.
2. Place a **second pylon** within connection range of the first. As soon as both
   are **built and connected**, the wall span forms automatically between them.
3. Keep the grid **powered**. The wall only blocks while its grid has power.

A pylon can anchor up to 3 connections, so you can chain fences into a perimeter.

## How it holds — and falls

The wall has **no health bar**. Instead it runs on your grid's power, buffered by
**batteries**:

- Incoming fire is first soaked by your grid's **power surplus** (free), then by
  stored **battery** charge.
- Overwhelm both — sustained heavy fire with no battery reserve — and the wall
  **stuns**: it drops for a few seconds (passable, rendered dim red) and recovers
  once the grid steadies.
- **Cut the power** (lose your generators / connection to the Capital) and the
  wall drops until power returns.
- **Destroy a pylon** and its wall is gone for good.

So a fence is only as strong as the power + batteries behind it. Pair fences with
**Solar Panels** and **Batteries** to keep them standing under pressure.

## Fighting a fence (and the AI)

Attacking drones target the **solid pylons**, not the intangible shield — and
their shots are **absorbed by the wall** in the way. To break through, an attacker
must out-gun the fence's power buffer (keeping the wall stunned) and then destroy a
pylon. The fence buys your base time; batteries decide how much.

## At a glance

| | |
|---|---|
| Pylon HP | 800 |
| Pylon power draw | 20 |
| Pylon connections | 3 (a hub) |
| Wall | no HP — runs on grid power + batteries; stuns when overwhelmed |
| Stun duration | 5 s |
| Blocks | ships **and** weapons fire while up |

See [docs/architecture/structures-and-power-grid.md](../architecture/structures-and-power-grid.md)
for the system internals (the derived-collider wall, the grid-power/stun model,
and the battery buffer).
