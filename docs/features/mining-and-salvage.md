# Mining and Salvage

Cutting up what is left after a battle: capital wrecks are a resource, and salvage ships carry a beam built to work them (plan partitioned-chasing-lark). This page grows with the salvage stream; today it covers the first piece, the mining laser.

## The mining laser

- **A tool, not a weapon.** It is a steady amber beam, the same colour as the Miner's drill beam, so anyone watching reads "someone is mining", not "someone is shooting".
- **It does nothing to a raised shield.** Hold it on a shielded ship and nothing happens: no damage, and it does not count as an attack. The ship's owner and their faction do not turn on you for it.
- **It barely scratches a live ship.** On a ship whose shield is down, or on a base structure, it does 5 % of its strength. That does count as an attack, like any other hit.
- **It is made for wrecks.** On a capital wreck it works at full strength. Wrecks do not wear down yet (that comes with wreck wear, the next step of the stream); until then a hit only pushes the wreck piece, as every weapon's hit does.
- **It cuts in a line.** When a mining-laser hit breaks something apart, the break runs straight along the beam, a narrow cut, like the heavy beam's slice but much thinner.
- **It is cheap to run.** A capital's energy recharges faster than the beam uses it, so it can stay on for as long as it is needed.
- **Range:** a capital turret's reach (12 km), shorter than the heavy beam.

No ship carries it yet: the mining barge that does is a later step.

## Mining asteroids

- **The mining laser mines rock.** Hold it on a locked asteroid and the rock's ore goes into your hold: about 30 units a second per beam, a little faster than a base Miner's drill. Whatever comes out of the rock goes into the hold; nothing is lost on the way.
- **Ore lands once a second.** The beam's hits add up, and the ore arrives in one batch each second, on the same beat as the base network's pulse.
- **A full hold stops mining.** When the ore would not fit, the rock keeps it.
- **Guns do not mine.** Shooting a rock with any other weapon takes nothing out of it.
- **Rocks do not break up yet.** A mined rock only loses ore; splitting rocks comes with the new terrain.

## Coming next

- **Rock splitting:** a mined rock breaks into smaller rocks, through the same split code as wrecks.

- **Wreck wear:** wrecks take damage and break into smaller pieces under the beam.
- **The mining barge:** the salvage ship that carries the mining laser.
- **Salvage yield:** what cutting up a wreck gives back.

## Under the hood

Ore draw: a hit on a rock owes its shooter `damage × weaponTargetFactor(def, 'rock') × ORE_UNITS_PER_DAMAGE` (1/24; the rock factor defaults to 0, the mining laser's is 1). `SectorRoom.applyDamage` hands each hit to `OreDraw.onHit` (`src/server/rooms/OreDraw.ts`); the 1 Hz grid pulse calls `OreDraw.flush`, which pays each shooter's whole units through `OreDraw.mine`, the same draw-into-a-hold path robot harvesters use (`SectorRoom.mineAsteroid`), over the one pool decrement `OreDraw.draw` (the grid Miner's `drawAsteroidResources` hook). A pilot's ore goes to its rostered hull's hold and rides the own-ship snapshot cargo (#16); a `collectsLoot` NPC's to its ownerless hold; any other shooter has no hold, so the rock keeps the ore. A part unit left at the pulse is dropped. Lock: `tests/integration/sectorRoom/oreDraw.test.ts`.

The numbers and the rules (per-target damage factors, why a 0-damage hit is not an attack, the beam's look) are in [weapon-mounts](../architecture/weapon-mounts.md) ("Per-target damage factors", "The mining laser").
