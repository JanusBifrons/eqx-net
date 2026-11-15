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

## Coming next

- **Wreck wear:** wrecks take damage and break into smaller pieces under the beam.
- **The mining barge:** the salvage ship that carries the mining laser.
- **Salvage yield:** what cutting up a wreck gives back.

## Under the hood

The numbers and the rules (per-target damage factors, why a 0-damage hit is not an attack, the beam's look) are in [weapon-mounts](../architecture/weapon-mounts.md) ("Per-target damage factors", "The mining laser").
