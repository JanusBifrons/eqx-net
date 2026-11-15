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

## The mining barge: look options

The barge is a container ship for salvage: about 1.3 times a battleship's length (7,480 u), twice its beam, a deck of container stacks, mining lasers and tractors of every size (S to XL) down both sides so it can strip-mine a field, and oversized engines on the stern. It has no side of its own: whoever owns it decides that.

Three hull looks are on the table for the owner to pick (`bargeDesign` in `shared-types/shipKinds/capitals/bargeDesign.ts`, built from the warship generator's parts):

- **A, container ship:** blunt bow, one long container deck, bridge aft, six big nozzles.
- **B, twin hull:** two pontoons round a central open hold of containers, laser rows on both outer edges, tractors on the hold rims, eight nozzles.
- **C, ore carrier:** a forward mining "jaw" of big lasers with a tractor at the back of the mouth, hatch covers over the hold, four huge nozzles.

Tractor beams do not exist yet, so tractor mounts (`tractor-*`) carry the mining laser as a placeholder until the tractor arrives.

To see one in the game, start the server with `EQX_BARGE_LOOK=A` (or B, C) and open the page with `?room=showcase-barge-look&bargeLook=A`: the barge parks beside a battleship and a few small ships. The switch is for this look review only. Unset, the catalogue is unchanged. Set, the look is added at the very end of the catalogue as kind `barge-look`, and it never spawns at random. Set it on both the server and the page. When the owner picks a look, it is added as a real ship kind and the switch goes away.

## Coming next

- **Wreck wear:** wrecks take damage and break into smaller pieces under the beam.
- **The mining barge:** the salvage ship that carries the mining laser.
- **Salvage yield:** what cutting up a wreck gives back.

## Under the hood

The numbers and the rules (per-target damage factors, why a 0-damage hit is not an attack, the beam's look) are in [weapon-mounts](../architecture/weapon-mounts.md) ("Per-target damage factors", "The mining laser").
