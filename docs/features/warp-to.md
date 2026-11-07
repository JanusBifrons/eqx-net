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
