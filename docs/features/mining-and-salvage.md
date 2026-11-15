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

The mining barge carries it (below).

## Tractor beam

**What it does (owner decisions 2026-11-15).** A tractor mount locks ONE target, like any weapon (a completed lock, #19): any ship (players included), a wreck piece, a loot pod or a rock. While it fires it pulls that target toward the mount, and gives a weaker tug to anything crossing the line between the mount and the target. It is a physics contest, not a fixed hold:

- **A fixed force; mass matters.** A small mount barely moves a big chunk and a giant rock does not budge, which is why lasers break wrecks down before tractors haul them. Bigger mounts pull harder (`MOUNT_SIZE_TUNING.power`: AA 0.4, S 1, M 2.5, L 6, XL 15).
- **Only the target moves.** The ship doing the pulling feels nothing.
- **It cushions.** Inside a hold distance the pull turns into a soft spring, so the load hovers near the mount instead of slamming into the hull.
- **Thrust escapes it.** A ship that thrusts away harder than the pull gets away.
- **No damage.** A tractor never hits, never cuts, never sends a damage number.

**Is it hostile?** Tractoring another pilot pulls them against their will, so tractoring a SHIP is a hostile act exactly like shooting at it: the same standing hit, and an NPC tractored by a pilot turns hostile to that pilot as if hit (an NPC's tractor on a pilot keeps its hostility alive, never creates it). Tractoring terrain (rocks, wreck pieces, loot pods, scrap) is neutral, the same as locking it.

**Numbers** (`tractor` in `WeaponCatalogue.ts`, an S mount): force 6,000, full force inside 250 u and inverse-square beyond; hold 250 u (keep `dRef ≤ hold`, or a load arriving at the cushion still slams); reach 3,000 u; beam line 40 u either side at a quarter of the force; fires every 10 ticks (like the heavy beam) for 4 energy; each shot keeps the beam on for 12 ticks.

**How it runs.** Every accepted fire renews a short lease for that mount and target. While the lease is live, the server's force-field list carries a `tractor` field that the physics worker applies every step; the lease ends 12 ticks after the last fire, or at once when the ship or the target is gone. A wreck that has just broken apart holds together as one rigid body for a moment (its crack hold): a tractor on one of its pieces holds on but does not pull until the hold ends. Internals: [physics-worker, Force fields](../architecture/physics-worker.md#force-fields), [weapon-mounts, Tractor beam](../architecture/weapon-mounts.md#tractor-beam).

## Mining asteroids

- **The mining laser mines rock.** Hold it on a locked asteroid and the rock's ore goes into your hold: about 30 units a second per beam, a little faster than a base Miner's drill. Whatever comes out of the rock goes into the hold; nothing is lost on the way.
- **Ore lands once a second.** The beam's hits add up, and the ore arrives in one batch each second, on the same beat as the base network's pulse.
- **A full hold stops mining.** When the ore would not fit, the rock keeps it.
- **Guns do not mine.** Shooting a rock with any other weapon takes nothing out of it.
- **Rocks do not break up yet.** A mined rock only loses ore; splitting rocks comes with the new terrain.

## The mining barge

The owner picked look A, the container ship. It is the ship kind `barge`, the last kind in the catalogue:

- **Anyone can own one.** A player can fly it; it is not tied to any side. Its side is its owner's, never the ship kind's, so it has no allegiance, and it never spawns at random (`randomSpawn: false`): a barge exists only because someone owns it. Its AI pilot uses the civilian role.
- **A huge hold.** About 105,000 units, several times a battleship's (`cargoCapacity`, read by `cargoCapacityForMaxHealth` on the server and the client alike).
- **26 mounts, all on the hull's drawn dishes.** Mining lasers (weapon group "Mining lasers"): 2 XL at the bow corners angled forward, 2 L at the aft corners, and 4 M and 4 AA in the side rows. Tractors (group "Tractors"): 8 S, 4 AA and 2 M dishes in the side rows. Reach, beam size and tractor pull scale with the mount size (`MOUNT_SIZE_TUNING`).

### Look options

The barge is a container ship for salvage: about 1.3 times a battleship's length (7,480 u), twice its beam, a deck of container stacks, a few big mining lasers at the bow corners and rows of small tractor dishes down both sides so it can strip-mine a field, and a stern engine module wider than the hull (1.4 beams) with three or four round bell nozzles, each about a quarter of the beam across, whose plume at full thrust is 30 % of the hull's length. It has no side of its own: whoever owns it decides that.

Three hull looks are on the table for the owner to pick (`bargeDesign` in `shared-types/shipKinds/capitals/bargeDesign.ts`, built from the warship generator's parts):

- **A, container ship:** blunt bow, one long container deck, bridge aft, four bells.
- **B, twin hull:** two pontoons with blunt bows round a mouth (tractor dishes on its inner faces, a laser and an intake slot at its back) and a central hold of containers, four bells. The least cargo of the three.
- **C, ore carrier:** a forward mining "jaw" of big lasers with a tractor at the back of the mouth, hatch covers over the hold, three bells.

How they are drawn, all through the ordinary ship art:
- **Paint:** the warships' steel, so the barge sits in the same light as the fleet. Fitted parts (cargo, deckhouse, stern gear) carry part roles the forge paints as their own (`OWN_PAINT_ROLES` in `client/render/art/fields.ts`), so the hull's bare-metal bands and panel seams never cut across them.
- **Engines:** `thrusters.bell` draws round bells (rim, dark throat, hot core) instead of block nozzles; `thrusters.plume` sets the full-thrust flame length as a fraction of the hull length, read by the forge into the engine FX.
- **Mounts:** a mining laser on a capital mount draws as a round emitter with a lens barrel, and a tractor as a dish, sized by its mount class (`turretLayout.ts`), not as a naval gunhouse.

Tractor mounts (`tractor-*`) carry the `tractor` weapon and draw as dishes.

To see one in the game, start the server with `EQX_BARGE_LOOK=A` (or B, C) and open the page with `?room=showcase-barge-look&bargeLook=A`: the barge parks beside a battleship and a few small ships. Room `showcase-barge-thrust` has one barge under way at full thrust. Showcase shots `barge-look`, `barge-stern` and `barge-thrust` film them. The switch is for this look review only. Unset, the catalogue is unchanged. Set, the look is added at the very end of the catalogue as kind `barge-look`, and it never spawns at random. Set it on both the server and the page. It stays for comparing looks B and C with the real barge (look A).

## Coming next

- **Rock splitting:** a mined rock breaks into smaller rocks, through the same split code as wrecks.

- **Wreck wear:** wrecks take damage and break into smaller pieces under the beam.
- **The barge's AI pilot:** its turrets pick salvage targets and it strip-mines a wreck field, banking at its owner's base.
- **Salvage yield:** what cutting up a wreck gives back.
- **Tractor beam on screen:** the client draws the beam and predicts the pull from the snapshot's beam links (with an e2e test and a showcase shot); a pod pulled into the hold zone is picked up.

## Under the hood

Ore draw: a hit on a rock owes its shooter `damage × weaponTargetFactor(def, 'rock') × ORE_UNITS_PER_DAMAGE` (1/24; the rock factor defaults to 0, the mining laser's is 1). `SectorRoom.applyDamage` hands each hit to `OreDraw.onHit` (`src/server/rooms/OreDraw.ts`); the 1 Hz grid pulse calls `OreDraw.flush`, which pays each shooter's whole units through `OreDraw.mine`, the same draw-into-a-hold path robot harvesters use (`SectorRoom.mineAsteroid`), over the one pool decrement `OreDraw.draw` (the grid Miner's `drawAsteroidResources` hook). A pilot's ore goes to its rostered hull's hold and rides the own-ship snapshot cargo (#16); a `collectsLoot` NPC's to its ownerless hold; any other shooter has no hold, so the rock keeps the ore. A part unit left at the pulse is dropped. Lock: `tests/integration/sectorRoom/oreDraw.test.ts`.

The numbers and the rules (per-target damage factors, why a 0-damage hit is not an attack, the beam's look) are in [weapon-mounts](../architecture/weapon-mounts.md) ("Per-target damage factors", "The mining laser", "Tractor beam"); the tractor's force field and leases in [physics-worker](../architecture/physics-worker.md#force-fields).
