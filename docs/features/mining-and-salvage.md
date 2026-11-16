# Mining and Salvage

Cutting up what is left after a battle: capital wrecks are a resource, and salvage ships carry a beam built to work them (plan partitioned-chasing-lark). This page grows with the salvage stream; today it covers the first piece, the mining laser.

## The mining laser

- **A tool, not a weapon.** It is a steady amber beam, the same colour as the Miner's drill beam, so anyone watching reads "someone is mining", not "someone is shooting".
- **It does nothing to a raised shield.** Hold it on a shielded ship and nothing happens: no damage, and it does not count as an attack. The ship's owner and their faction do not turn on you for it.
- **It barely scratches a live ship.** On a ship whose shield is down, or on a base structure, it does 5 % of its strength. That does count as an attack, like any other hit.
- **It is made for wrecks.** On a wreck it works at full strength.
- **It cuts in a line.** When a mining-laser hit breaks something apart, the break runs straight along the beam, a narrow cut, like the heavy beam's slice but much thinner.
- **It is cheap to run.** A capital's energy recharges faster than the beam uses it, so it can stay on for as long as it is needed.
- **Range:** a capital turret's reach (12 km), shorter than the heavy beam.

No ship carries it yet: the mining barge that does is a later step.

## Wrecks wear down

- **Every wreck piece can be broken up.** Keep hitting a piece and it wears down, then cracks into smaller pieces where it was hit. Each piece can take only so much; a bigger piece lasts longer. How worn a piece is never shows: you see it when it splits.
- **The mining laser is the tool for it.** Ordinary guns wear a wreck down too, but about ten times slower.
- **Cutting weapons cut.** A wreck piece broken by the heavy beam, the railgun or the mining laser splits along the shot's line.
- **The last of it is salvage.** A piece too small to split again turns into a salvage pod when it wears out, worth more the bigger the piece. Pick it up like any loot pod; a reclaimer refines salvage into minerals.
- **Splash does not wear wrecks.** Missiles and blasts push pieces around but do not wear them down.

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
- **The mining laser cuts rock, exactly like a wreck.** Keep the beam on a rock and it wears down (hidden, like a wreck piece's wear). Worn out, it breaks along the line of every beam that burned it in the last moment, into two or three chunks. Only the mining laser wears rock: guns, the heavy beam and the railgun never do.
- **The chunks are loose rock.** Each piece drifts and tumbles like wreck debris and can be cut again the same way. A piece is as heavy as its size (area × the rock density), so a tractor hauls small pieces easily and barely moves a big one.
- **The last of it is ore.** A worn-out piece too small to split (under 6 % of the rock it came from) turns into a loot pod holding its share of the rock's ore, split like any ore from that rock (a plain rock gives minerals, ice gives ice, and so on), up to a pod's size: no more cargo weight than a salvage-field pod (`SALVAGE_POD_MAX_WEIGHT`, 61), so a sliver of a big rock is still a pod a ship can haul. Pick it up like any pod. The rock's ore is shared out by area when it breaks: cutting never makes more ore than the rock had (a share over the pod size stays unmined).

### How rock cutting works

One wreck system cuts ships and rocks; nothing about a rock is a parallel path.

- **The source.** `core/destruction/wreckSource.ts` is where the wreck code reads what a wreck was cut from: a ship kind's numbers, or a rock's (its own outline from `generateAsteroidVertices(shapeSeed, radius)`, scale 1, mass `ROCK_WRECK_DENSITY` 0.25 per u², integrity `ROCK_INTEGRITY_PER_AREA` 0.2 per u², the `rock` destruction profile). Fracture, re-split, integrity, pods, kicks and body parameters all take either.
- **Frame.** A rock's "1× frame" is its own rest frame (y flipped for the fracture), so every piece's centroid and vertices stay in the PARENT rock's local frame, cut after cut: a later per-vertex ore tint lines up across cuts.
- **Wear and break** (`server/rooms/rockCut.ts`, called from `CapitalWreckSubsystem.onWreckHit`): per hit, wear = damage × the weapon's `rock` factor; a cutting beam burns its line (`BurnLines`). At 0 the rock becomes a ROOT wreck: its descriptor carries `parentKind: 'asteroid'` and `rock: { id, shape, r, res? }` (stable id, shape seed, radius, and its resource when not plain rock), the killing beam's cut and the other burn lines; pieces are fractured by `wreckPieceGeometry`, placed and spawned by the re-split's own `placeWreckPieces` / `spawnWreckPieces`, and the rock leaves through the normal evict path. Pieces re-cut through the normal re-split; a rock's child descriptors resolve to the rock root, and on the server every piece of the rock keeps the rock's wreck as its lineage root (`LiveWreck.root`, capital-destruction.md §S4 "Lineage").
- **Ore** (`OreDraw.cutYield`, the one hook): a pod made from a rock's piece calls it with the parent rock id, the pod's world point and its units; the goods split through `asteroidYield`.
- **Client.** `WreckGeometryStore` rebuilds rock pieces from the descriptor (late joiners included, #16); the predWorld body takes the rock's body parameters (`rockOf`). Each piece draws its own stretch of the uncut rock's art (`rockPieceArt.ts`), one mesh of its outline with UVs at its place in the rock (no mask, so pieces batch): its Machined rock bake (the same `rockHandleFor` key: shape, radius, resource) once ready, else the plain asteroid polygon in the resource's classic tint, so an ice or crystal rock stays ice or crystal when it breaks; every rock piece takes the far-zoom speck in the rock's colour. The field rock shader replaces the art later.
- **Locks:** `src/core/destruction/rockWreck.test.ts` (determinism, parent-frame tiling, slice line, mass, wear factor), `tests/integration/wire/rockWreckParity.test.ts` (server bodies = client rebuild, descriptor schema), `tests/integration/sectorRoom/rockCut.test.ts` (the real room: wear, split along the beam, other weapons don't, an ore pod; a real fire cuts a rock), `src/client/render/pixi/swarmSpriteUpdater.rockWreck.test.ts`, `src/client/render/pixi/rockPieceArt.test.ts` (art, tint, speck).
- **Not yet:** a rock piece hit by the mining laser wears but does not pay ore per hit (only its pod does). Rock cutting needs the wreck system on (`capitalWrecks`, on by default). Cut-field rocks (macro terrain) are not cut yet: `rockOf` refuses a `fieldRock` record until the field's consumed keys ride the wire (terrain C3), else a client would still draw the whole rock from its chunk; their outline is also the field cut, not `generateAsteroidVertices(shapeSeed, radius)`. The break point leaves a TODO to record the rock as mined (`cutField?.markConsumed(rec.fieldKey)`) and to read piece ore from the field (`oreAtRest`).

## Coming next

- **The mining barge:** the salvage ship that carries the mining laser.
- **Tractor beam on screen:** the client draws the beam and predicts the pull from the snapshot's beam links (with an e2e test and a showcase shot); a pod pulled into the hold zone is picked up.

## Under the hood

Ore draw: a hit on a rock owes its shooter `damage × weaponTargetFactor(def, 'rock') × ORE_UNITS_PER_DAMAGE` (1/24; the rock factor defaults to 0, the mining laser's is 1). `SectorRoom.applyDamage` hands each hit to `OreDraw.onHit` (`src/server/rooms/OreDraw.ts`); the 1 Hz grid pulse calls `OreDraw.flush`, which pays each shooter's whole units through `OreDraw.mine`, the same draw-into-a-hold path robot harvesters use (`SectorRoom.mineAsteroid`), over the one pool decrement `OreDraw.draw` (the grid Miner's `drawAsteroidResources` hook). A pilot's ore goes to its rostered hull's hold and rides the own-ship snapshot cargo (#16); a `collectsLoot` NPC's to its ownerless hold; any other shooter has no hold, so the rock keeps the ore. A part unit left at the pulse is dropped. Lock: `tests/integration/sectorRoom/oreDraw.test.ts`.

The numbers and the rules (per-target damage factors, why a 0-damage hit is not an attack, the beam's look) are in [weapon-mounts](../architecture/weapon-mounts.md) ("Per-target damage factors", "The mining laser", "Tractor beam"); the tractor's force field and leases in [physics-worker](../architecture/physics-worker.md#force-fields).
