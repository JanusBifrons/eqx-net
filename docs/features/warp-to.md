# Warp-to (in-system travel)

Solar-system sectors are ±200 km with a few busy pockets (bases, belts, gates, combat sites) and empty space between. Warp-to is how a pilot crosses that space.

## What the pilot sees

1. **Spool (3 s).** The pilot asks to warp to a pocket. The drive turns the ship to face it (the pilot's turn keys are ignored while it does) and a glow builds at the engines. A slow-turning hull (a capital) keeps spooling past 3 s until it is within 0.06 rad of the jump, turning at least 9°/s, so it never snaps round when the run starts; the same hold as an NPC warp (`World.applyInput` / `World.botWarp`, lock `World.pilotWarpAlign.test.ts`). The ship is still in the world and can be shot; dropping the request cancels it. **A short hop can end in the spool:** a ship that got to the point under its own engines (within one tick of the run, ~333 u, or past it along the line from where the spool began) ends the warp where it is, with no run, no snap and no turn back; a ship still thrusting at a point inside its turning circle circles past it within a lap, so no spool is held for ever (`warpReached`, `src/core/physics/warpDrive.ts`; lock `World.shortWarp.test.ts`).
2. **The run.** The ship accelerates away at 20,000 u/s. On board: speed lines rush past and a short streak trails the hull, while the system's own sky drifts by.
3. **The drop.** The ship drops out at the pocket's rim on the side facing it (or at the near side of a field or structure in the way, see "Nothing in the way"), at the nearest spot clear of anything there, with a short flash and reverse streak. The search reaches as far as the ship's own clearance plus the largest hull's (at least 6 km), so a capital landing beside a parked capital finds the gap instead of dropping on top of it (`landingReach`, lock `core/bases/landingReach.test.ts`).

## What everyone else sees

- The build-up (engine glow, the turn).
- The departure: a flash at the engines, a brief streak and two thin engine trails left on the path, which burn out in about two seconds. The ship itself is gone.
- At the destination: the same drop flash and short trails where it appears.
- A ship joining the sector arrives with the same drop effect (the old shader warp-in is gone).

## The run is out of the world

The run looks like a real flight, but once a ship has left it is out of the world for everyone else: hidden, not targetable, not damageable, and it collides with nothing. Its pilot's data window sits on the destination, so nothing along the route is sent and the destination streams in during the trip. This is the first half of the "travel state" (see [docs/architecture/travel-state.md](../architecture/travel-state.md)); sector-to-sector travel uses the same idea to hide loading.

## The system sky

In a solar-system sector the sky shows the system's own few distant bodies, drifting slowly as you cross it, instead of the endless planet pattern used in small sectors (where a 170 km warp swept dozens of planets past).

## NPCs warp too

NPC ships can warp within a sector the same way (wrap-up W2a, for flagship fleets): `SectorRoom.warpBot(id, x, y)` sends a `BOT_WARP` to the physics worker, which runs the bot through the same spool → run → drop machine as a pilot (`World.botWarp`); its AI is overridden until it lands. Its warp obeys the same route rule: it is clamped to the near side of a field or structure in the way, or refused when that is too close (`warpTargetFor`). Onlookers see the same effects: the phase rides the drone snapshot slice (`drones[].warp`: 1 spool, 2 run, 3 just arrived), the sprite hides on the run, and `WarpFx` draws the spool, departure and drop. A bot on its run can't be damaged. Lock: `tests/integration/sectorRoom/npcWarp.test.ts`.

## Picking a destination

The rail's **Galaxy** panel (`rightPanel = 'galaxy'`, `src/client/panels/GalaxyPanel.tsx`; solar-system sectors only) lists every pocket under **Nearby** and **Far** by name ("Home", "Asteroid belt", "Vega Reach gate", "Battle zone") with its distance; tap a row to warp. It is the only warp list (the old floating picker card and its desktop system map were folded into it). In Command view there is no flown ship, so there are no rows: a fleet warps by sector from the full map.

Gates sit on the bearing toward the system they lead to, so in Sol Prime the Vega Reach gate is due east and warping there flies straight right. Warps go any direction (locked by `warpTo.test.ts`, "flies any direction"). The pocket you're in can't be picked. While a warp is held, a chip under the energy bar says where it goes, with a Cancel.

**Nothing in the way.** A warp never passes through an asteroid field or a structure (wrecks, nebulae and ships don't block). When one is on the line, the row offers the **near side** instead, labelled in amber "near side · asteroid field in the way" or "near side · structure in the way": that point IS the destination, the distance shown is to it and the ship lands exactly there. A near side closer than the minimum warp stays listed, greyed: "can't warp there · too close". Both sides compute the point with the one shared rule (`warpTargetFor`, `src/core/galaxy/warpTarget.ts`); the client reads structures from the structure mirror (`src/client/components/warpRoute.ts`) and the server from its registry (`src/server/rooms/warpRouteCheck.ts`). Locks: `warpDestinations.test.ts`, `tests/unit/warpFootprintParity.test.ts` (same footprints both sides), `tests/e2e/warp-near-side.spec.ts`.

## Transit pads (rare)

Some systems also have a **transit pad pair**: one pad in the home pocket, one in a belt, base or battle-zone pocket. Fly onto a pad and it carries you to the other one: instant, free (no charge, no grid, no toll) and safe, which makes pads the starter's way across a system. The Galaxy panel marks a pocket that has one ("pad to Battle zone (instant)").

They are rare on purpose (user, 2026-11-08: warp-to makes pads less valuable but "far from redundant, it's instant and safe for starters ... just make them a bit more rare"):

- at most one pair per system, always from home;
- a system gets one with chance `POCKET_PAD_CHANCE` (0.5), seeded by its key, so about a third of today's 21 systems do and the rest have none.

Pads are owned by the Traders (`npc:traders:pads`), so they are never saved and regrow on every boot. Code: `pocketPadPair` (`src/core/galaxy/sectorSites.ts`), `seedPocketPads` (`src/server/structures/TeleporterSubsystem.ts`); the `pocket_pad` structure kind shares the teleporter cycle with the alien gates' free rules (`isFreeTeleporterKind`). Locks: `sectorSites.test.ts` (deterministic, rare), `tests/integration/sectorRoom/pocketPads.test.ts` (seeded, paired, a pilot rides it).
