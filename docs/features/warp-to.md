# Warp-to (in-system travel)

Solar-system sectors are ±200 km with a few busy pockets (bases, belts, gates, combat sites) and empty space between. Warp-to is how a pilot crosses that space.

## What the pilot sees

1. **Spool (3 s).** The pilot asks to warp to a pocket. The drive turns the ship to face it (the pilot's turn keys are ignored while it does) and a glow builds at the engines. The ship is still in the world and can be shot; dropping the request cancels it.
2. **The run.** The ship accelerates away at 20,000 u/s. On board: speed lines rush past and a short streak trails the hull, while the system's own sky drifts by.
3. **The drop.** The ship drops out at the pocket's rim on the side facing it, at the nearest spot clear of anything there, with a short flash and reverse streak.

## What everyone else sees

- The build-up (engine glow, the turn).
- The departure: a flash at the engines, a brief streak and two thin engine trails left on the path, which burn out in about two seconds. The ship itself is gone.
- At the destination: the same drop flash and short trails where it appears.
- A ship joining the sector arrives with the same drop effect (the old shader warp-in is gone).

## The run is out of the world

The run looks like a real flight, but once a ship has left it is out of the world for everyone else: hidden, not targetable, not damageable, and it collides with nothing. Its pilot's data window sits on the destination, so nothing along the route is sent and the destination streams in during the trip. This is the first half of the "travel state" (see [docs/architecture/travel-state.md](../architecture/travel-state.md)); sector-to-sector travel uses the same idea to hide loading.

## The system sky

In a solar-system sector the sky shows the system's own few distant bodies, drifting slowly as you cross it, instead of the endless planet pattern used in small sectors (where a 170 km warp swept dozens of planets past).

## Picking a destination

The **Warp ▸** action in the speed dial (solar-system sectors only) opens the destination picker. It has two views (both kept, user 2026-11-08), chosen by device; `?warpui=list|map` overrides:

- **List (touch devices):** every pocket by name ("Home", "Asteroid belt", "Vega Reach gate", "Battle zone"), nearest first with its distance, the far ones grouped. Big rows, readable on a phone.
- **System map (desktop):** the whole ±200 km system with each pocket, the ship and any pad link. Click a pocket, then Warp.

Gates sit on the bearing toward the system they lead to, so in Sol Prime the Vega Reach gate is due east and warping there flies straight right. Warps go any direction (locked by `warpTo.test.ts`, "flies any direction"). The pocket you're in can't be picked. While a warp is held, a chip under the energy bar says where it goes, with a Cancel.

## Transit pads (rare)

Some systems also have a **transit pad pair**: one pad in the home pocket, one in a belt, base or battle-zone pocket. Fly onto a pad and it carries you to the other one: instant, free (no charge, no grid, no toll) and safe, which makes pads the starter's way across a system. The picker marks a pocket that has one ("pad to Battle zone (instant)") and the system map draws the link.

They are rare on purpose (user, 2026-11-08: warp-to makes pads less valuable but "far from redundant, it's instant and safe for starters ... just make them a bit more rare"):

- at most one pair per system, always from home;
- a system gets one with chance `POCKET_PAD_CHANCE` (0.5), seeded by its key, so about a third of today's 21 systems do and the rest have none.

Pads are owned by the Traders (`npc:traders:pads`), so they are never saved and regrow on every boot. Code: `pocketPadPair` (`src/core/galaxy/sectorSites.ts`), `SectorRoom.seedPocketPads`; the `pocket_pad` structure kind shares the teleporter cycle with the alien gates' free rules (`isFreeTeleporterKind`). Locks: `sectorSites.test.ts` (deterministic, rare), `tests/integration/sectorRoom/pocketPads.test.ts` (seeded, paired, a pilot rides it).
