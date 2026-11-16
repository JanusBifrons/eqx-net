# Mining and Salvage

Cutting up what is left after a battle: capital wrecks are a resource, and salvage ships carry a beam built to work them (plan partitioned-chasing-lark). This page grows with the salvage stream; today it covers the first piece, the mining laser.

## The mining laser

- **A tool, not a weapon.** It is a steady amber beam, the same colour as the Miner's drill beam, so anyone watching reads "someone is mining", not "someone is shooting".
- **It does nothing to a raised shield.** Hold it on a shielded ship and nothing happens: no damage, and it does not count as an attack. The ship's owner and their faction do not turn on you for it.
- **It barely scratches a live ship.** On a ship whose shield is down, or on a base structure, it does 5 % of its strength. That does count as an attack, like any other hit.
- **It is made for wrecks.** On a wreck it works at full strength.
- **It cuts in a line.** When a mining-laser hit breaks something apart, the break runs straight along the beam, a narrow cut, like the heavy beam's slice but much thinner.
- **It is cheap to run.** A capital's energy recharges faster than the beam uses it, so it can stay on for as long as it is needed.
- **Range: bigger mounts reach further** ([range by mount size](#range-by-mount-size)). An XL mount reaches 12 km (a capital turret's reach, shorter than the heavy beam); smaller mounts reach less.

### Range by mount size

**What happens (owner 2026-11-16).** A mining laser or a tractor reaches further the bigger its mount: XL keeps the full catalogue range, smaller mounts a fixed share of it (mount size reach ÷ XL reach, 0.8 / 1 / 1.25 / 1.6 against 2.2). An unsized mount counts as S. Guns are not affected: every gun keeps its range at every mount size.

| Mount | Mining laser | Tractor |
|---|---|---|
| XL | 12,000 u | 3,000 u |
| L | ≈ 8,727 u | ≈ 2,182 u |
| M | ≈ 6,818 u | ≈ 1,705 u |
| S (and unsized) | ≈ 5,455 u | ≈ 1,364 u |
| AA | ≈ 4,364 u | ≈ 1,091 u |

A mount fires only at a locked target inside its own reach (locks still work at any distance), so a small laser has to be brought in closer to a rock than a big one. The beam itself ends at that reach too: a small laser that fires on something close cannot cut a rock further down its line past its own reach (the server's ray and the drawn beam both scale by `mountRangeFactor`). The aim guide and the contact list's group reach show the same per-mount number. Tractors pull up to their reach and no further; the [size ladder](#the-size-ladder-big-lasers-feed-big-tractors-feed-small-lasers) is unchanged, because it judges a tractor at 500 u, far inside even an AA tractor's reach.

The mining barge carries it (below).

## Wrecks wear down

- **Every wreck piece can be broken up.** Keep hitting a piece and it wears down, then cracks into smaller pieces where it was hit. Each piece can take only so much; a bigger piece lasts longer. How worn a piece is never shows: you see it when it splits.
- **The mining laser is the tool for it.** Ordinary guns wear a wreck down too, but about ten times slower.
- **Cutting weapons cut.** A wreck piece broken by the heavy beam, the railgun or the mining laser splits along the shot's line.
- **The last of it is salvage.** A piece too small to split again turns into a salvage pod when it wears out, worth more the bigger the piece. Pick it up like any loot pod; a reclaimer refines salvage into minerals.
- **Splash does not wear wrecks.** Missiles and blasts push pieces around but do not wear them down.

## Tractor beam

**What it does (owner decisions 2026-11-15).** A tractor mount locks ONE target, like any weapon (a completed lock, #19): any ship (players included), a wreck piece, a loot pod or a rock piece. Among salvage it only pulls a piece light enough for its own mount size ([the size ladder](#the-size-ladder-big-lasers-feed-big-tractors-feed-small-lasers)); a whole field rock is never towed. While it fires it pulls that target toward the mount, and gives a weaker tug to anything crossing the line between the mount and the target. It is a physics contest, not a fixed hold:

- **A fixed force; mass matters.** A small mount barely moves a big chunk and a giant rock does not budge, which is why lasers break wrecks down before tractors haul them. Bigger mounts pull harder (`MOUNT_SIZE_TUNING.power`: AA 0.4, S 1, M 2.5, L 6, XL 15).
- **Only the target moves.** The ship doing the pulling feels nothing.
- **It cushions.** Inside a hold distance the pull turns into a soft spring, so the load hovers near the mount instead of slamming into the hull.
- **Thrust escapes it.** A ship that thrusts away harder than the pull gets away.
- **No damage.** A tractor never hits, never cuts, never sends a damage number.
- **It hauls loot in.** A loot pod (salvage pods included) that your tractor pulls to within about 1.2 × the hold distance of the beam's mount goes straight into your hold, exactly as if you had flown over it: same pickup, same popup. A pod nobody is tractoring at that distance stays where it is (fly-over range is much shorter), and if your hold is full the pod just keeps hovering in the beam.
- **It stores wreck pieces.** A wreck piece your tractor pulls into that same zone goes into your hold whole, as the salvage it would have left if you had worn it down: no cutting it to a pod first. Only a piece your own beam is already holding, and only into your own hold. If your hold has no room for all of it, nothing happens: the piece keeps hovering in the beam.

**Is it hostile?** Tractoring another pilot pulls them against their will, so tractoring a SHIP is a hostile act exactly like shooting at it: the same standing hit, and an NPC tractored by a pilot turns hostile to that pilot as if hit (an NPC's tractor on a pilot keeps its hostility alive, never creates it). Tractoring terrain (rocks, wreck pieces, loot pods, scrap) is neutral, the same as locking it.

**Numbers** (`tractor` in `WeaponCatalogue.ts`, an S mount): force 6,000, full force inside 250 u and inverse-square beyond; hold 250 u (keep `dRef ≤ hold`, or a load arriving at the cushion still slams); reach 3,000 u at an XL mount, ≈ 1,364 u at this S one ([range by mount size](#range-by-mount-size)); beam line 40 u either side at a quarter of the force; fires every 10 ticks (like the heavy beam) for 4 energy; each shot keeps the beam on for 12 ticks.

**How it runs.** Every accepted fire renews a short lease for that mount and target. While the lease is live, the server's force-field list carries a `tractor` field that the physics worker applies every step; the lease ends 12 ticks after the last fire, or at once when the ship or the target is gone. A wreck that has just broken apart holds together as one rigid body for a moment (its crack hold): a tractor on one of its pieces holds on but does not pull until the hold ends. Pickup: on each loot collect pass (~10 Hz) `LootSubsystem` asks, for a pod beyond the fly-over radius, `ForceFieldSubsystem.inTractorHold(collector, pod, x, y)`: does this collector (its pilot id, or an AI ship's swarm id) hold a live, posed lease on that pod with the pod within `TRACTOR_PICKUP_HOLD_MUL` (1.2) × `hold` of the beam's muzzle? If so the pod goes through the same atomic `pickUp` as a fly-over (one `HoldStore` group; a full hold moves nothing and the pod stays). The same pass stores a held wreck piece: `ForceFieldSubsystem.forEachHeldPiece` visits the wreck pieces the collector's own leases hold in that zone; the piece's worth (`CapitalWreckSubsystem.pieceStore`: `wreckSalvageQty` salvage, or a rock piece's ore) goes into the hold in one `HoldStore` commit, all or nothing, and `storePiece` removes the piece through the worn-out path. Only collectors pick up (#17: active rostered hulls and `collectsLoot` AI ships). Locks: `tests/integration/sectorRoom/tractorPickup.test.ts`, `ForceFieldSubsystem.test.ts`. Internals: [physics-worker, Force fields](../architecture/physics-worker.md#force-fields), [weapon-mounts, Tractor beam](../architecture/weapon-mounts.md#tractor-beam).

## The factory line: small pieces go straight into the hold

**What happens (owner 2026-11-16).** Mining works like a factory line: lasers cut big pieces smaller, tractors pull pieces in, and once a piece is small enough for YOUR ship to take whole, nobody aims at it any more and the ship simply takes it in.

- **Small enough for this ship.** A piece counts as "small enough" when its size (radius) is at most 15 % of your hull's (`SALVAGE_CONSUME_FRAC`: a fighter takes only crumbs up to 3.6 u, a crossguard pieces up to 32 u, a destroyer 183 u, a battleship 431 u) AND your hold has room for all of what it holds. A bigger ship takes bigger pieces.
- **Nobody aims at it.** Your mining lasers skip it (no point cutting it smaller) and your tractors let it go (it does not need pulling). If every piece a laser or tractor has locked is small enough, that mount stops firing.
- **It goes in when it is close.** When such a piece comes within loot pickup range of your hull's edge (about 80 u), it goes into your hold whole, as one load: a ship's wreck piece as salvage, a rock piece as its ore. No pod is made first. If it no longer fits (the hold filled up meanwhile), it stays where it is.
- **Full hold: back to work.** A piece only counts as small enough while it fits. Fill your hold and your lasers go back to cutting it.
- **Only mining ships.** Only a ship that carries a mining laser or a tractor takes pieces in this way. Other ships still pick up pods by flying over them, as before.


**How it runs.** The rule is `salvageConsumable` / `salvageConsumeRadius` (`core/combat/salvageTargeting.ts`). The lock step stamps `LOCK_CONSUMABLE` on the wire lock (`lockSalvageFlags`, `server/rooms/lockSalvage.ts`, from `CapitalWreckSubsystem.pieceStore`), and the shared `pickTurretLock` skips it for lasers and tractors on both sides. The pickup is the loot collect pass (`LootSubsystem.visitCollector`): `CapitalWreckSubsystem.forEachPieceNear` lists close pieces, and the same piece store as a tractored piece (one `HoldStore` commit, then `storePiece`) takes them in; a rock piece's ore comes from `OreDraw.cutYield`. Locks: `salvageTargeting.test.ts`, `turretLockPick.salvage.test.ts`, `LootSubsystem.test.ts`, `tests/unit/salvageLockParity.test.ts`, `tests/integration/sectorRoom/factoryLine.test.ts`.

## The size ladder: big lasers feed big tractors feed small lasers

**What happens (owner 2026-11-16).** A big mining ship works a huge rock in steps, by mount size:

1. Its long-range **XL and L lasers** slice the huge rock in two, then four, then eight, until a piece is light enough for a **large tractor** to pull.
2. The **large tractor** pulls that piece in towards the ship, where the **medium lasers** cut it until a **medium tractor** can pull the pieces.
3. The **medium tractor** pulls them in to the **small lasers**, which cut them down to hold size.
4. A hold-size piece is [taken in whole](#the-factory-line-small-pieces-go-straight-into-the-hold): nothing aims at it.

**The rule.** Every piece has a **size**: the smallest tractor that can pull it (AA, S, M, L, XL, or "too big for any tractor"). It comes from the piece's weight alone, not from which ship is looking at it. A **laser** only cuts pieces bigger than its own size: a tractor of its size can already take the rest, so it leaves those to the tractors and the smaller lasers. A **tractor** only pulls pieces of its own size or smaller, the biggest it can first. Among the pieces a laser may cut, big lasers (M, L, XL) take the biggest and small lasers (AA, S) the smallest.

**Today's sizes** (a piece's weight; a rough cut-rock radius at the rock density 0.25, taking a piece as a disc): AA up to 60 (about 9 u), S up to 150 (about 14 u), M up to 375 (about 22 u), L up to 900 (about 34 u), XL up to 2,250 (about 54 u); anything heavier, and every whole field rock, is too big for any tractor. Fighter debris is AA size, so on a ship whose lasers are all S or bigger the tractors take it.

**Where pieces end up.** A tractor holds its piece on a cushion 250 u from its mount (every size). A mining laser reaches 4,364 u (AA) to 12,000 u (XL) ([range by mount size](#range-by-mount-size)), so the held piece is inside the reach of every laser near that tractor; on a long hull (a barge is ~7,500 u long) a small laser at the far end may not reach it, so small lasers sit near the tractors that feed them.

**How it runs.** `salvageTier` / `salvageTierMass` / `mountTier` (`core/combat/salvageTargeting.ts`) give the sizes; the lock step stamps each piece's size on its lock (`lockSalvageFlags`, `server/rooms/lockSalvage.ts`), it rides to the pilot's client on the wire lock, and the shared `pickTurretLock` (`laserCutsTier` / `tractorTakesTier`) makes the same choice on both sides. Locks: `salvageTargeting.test.ts`, `turretLockPick.salvage.test.ts`, `tests/unit/salvageLockParity.test.ts`, `tests/integration/sectorRoom/sizeLadder.test.ts`, `salvageLockFlags.test.ts`.

## Mining asteroids

- **The mining laser mines rock.** Hold it on a locked asteroid and the rock's ore goes into your hold: about 30 units a second per beam, a little faster than a base Miner's drill. Whatever comes out of the rock goes into the hold; nothing is lost on the way.
- **Ore lands once a second.** The beam's hits add up, and the ore arrives in one batch each second, on the same beat as the base network's pulse.
- **A full hold stops mining.** When the ore would not fit, the rock keeps it.
- **Where you cut decides what you get.** In the cut asteroid field, the ore comes from the spot the beam is on: a blue (ice) or violet (crystal) vein pays mostly that ore, plain grey rock pays minerals. Older scattered rocks pay by their kind.
- **Guns do not mine.** Shooting a rock with any other weapon takes nothing out of it.
- **The mining laser cuts rock, exactly like a wreck.** Keep the beam on a rock and it wears down (hidden, like a wreck piece's wear). Worn out, it breaks along the line of every beam that burned it in the last moment, into two or three chunks. Only the mining laser wears rock: guns, the heavy beam and the railgun never do.
- **The chunks are loose rock.** Each piece drifts and tumbles like wreck debris and can be cut again the same way. A piece is as heavy as its size (area × the rock density), so a tractor hauls small pieces easily and barely moves a big one.
- **The last of it is ore.** A worn-out piece too small to split (under 6 % of the rock it came from) turns into a loot pod holding its share of the rock's ore, split like any ore from that rock (a plain rock gives minerals, ice gives ice, and so on), up to a pod's size: no more cargo weight than a salvage-field pod (`SALVAGE_POD_MAX_WEIGHT`, 61), so a sliver of a big rock is still a pod a ship can haul. Pick it up like any pod. The rock's ore is shared out by area when it breaks: cutting never makes more ore than the rock had (a share over the pod size stays unmined).
- **Locks follow the pieces.** When a rock or wreck piece you have locked breaks, your locks carry over to its pieces, biggest first. A ship that holds several locks per weapon group locks several pieces at once, already locked (no new lock time), so each mining laser keeps working and the lasers spread over the pieces. Lasers still leave a piece a tractor of their own size can pull ([the size ladder](#the-size-ladder-big-lasers-feed-big-tractors-feed-small-lasers)).

### How rock cutting works

One wreck system cuts ships and rocks; nothing about a rock is a parallel path.

- **The source.** `core/destruction/wreckSource.ts` is where the wreck code reads what a wreck was cut from: a ship kind's numbers, or a rock's (its own outline from `generateAsteroidVertices(shapeSeed, radius)`, scale 1, mass `ROCK_WRECK_DENSITY` 0.25 per u², integrity `ROCK_INTEGRITY_PER_AREA` 0.2 per u², the `rock` destruction profile). Fracture, re-split, integrity, pods, kicks and body parameters all take either.
- **Frame.** A rock's "1× frame" is its own rest frame (y flipped for the fracture), so every piece's centroid and vertices stay in the PARENT rock's local frame, cut after cut: a later per-vertex ore tint lines up across cuts.
- **Wear and break** (`server/rooms/rockCut.ts`, called from `CapitalWreckSubsystem.onWreckHit`): per hit, wear = damage × the weapon's `rock` factor; a cutting beam burns its line (`BurnLines`). At 0 the rock becomes a ROOT wreck: its descriptor carries `parentKind: 'asteroid'` and `rock: { id, shape, r, res? }` (stable id, shape seed, radius, and its resource when not plain rock), the killing beam's cut and the other burn lines; pieces are fractured by `wreckPieceGeometry`, placed and spawned by the re-split's own `placeWreckPieces` / `spawnWreckPieces`, and the rock leaves through the normal evict path. Pieces re-cut through the normal re-split; a rock's child descriptors resolve to the rock root, and on the server every piece of the rock keeps the rock's wreck as its lineage root (`LiveWreck.root`, capital-destruction.md §S4 "Lineage").
- **Ore** (`OreDraw.cutYield`, the one hook): a pod made from a rock's piece calls it with the parent rock id, the pod's world point and its units; the goods split through `asteroidYield`.
- **Client.** `WreckGeometryStore` rebuilds rock pieces from the descriptor (late joiners included, #16); the predWorld body takes the rock's body parameters (`rockOf`). Each piece draws its own stretch of the uncut rock's art (`rockPieceArt.ts`), one mesh of its outline with UVs at its place in the rock (no mask, so pieces batch): its Machined rock bake (the same `rockHandleFor` key: shape, radius, resource) once ready, else the plain asteroid polygon in the resource's classic tint, so an ice or crystal rock stays ice or crystal when it breaks; every rock piece takes the far-zoom speck in the rock's colour. The field rock shader replaces the art later.
- **Locks:** `src/core/destruction/rockWreck.test.ts` (determinism, parent-frame tiling, slice line, mass, wear factor), `tests/integration/wire/rockWreckParity.test.ts` (server bodies = client rebuild, descriptor schema), `tests/integration/sectorRoom/rockCut.test.ts` (the real room: wear, split along the beam, other weapons don't, an ore pod; a real fire cuts a rock), `src/client/render/pixi/swarmSpriteUpdater.rockWreck.test.ts`, `src/client/render/pixi/rockPieceArt.test.ts` (art, tint, speck).
- **Not yet:** a rock piece hit by the mining laser wears but does not pay ore per hit (only its pod does). Rock cutting needs the wreck system on (`capitalWrecks`, on by default). Cut-field rocks (macro terrain) are not cut yet: `rockOf` refuses a `fieldRock` record until the field's consumed keys ride the wire (terrain C3), else a client would still draw the whole rock from its chunk; their outline is also the field cut, not `generateAsteroidVertices(shapeSeed, radius)`. The break point leaves a TODO to record the rock as mined (`cutField?.markConsumed(rec.fieldKey)`) and to read piece ore from the field (`oreAtRest`).

## The mining barge

The owner picked look A, the container ship. It is the ship kind `barge`, the last kind in the catalogue:

- **Anyone can own one.** A player can fly it; it is not tied to any side. Its side is its owner's, never the ship kind's, so it has no allegiance, and it never spawns at random (`randomSpawn: false`): a barge exists only because someone owns it. Its AI pilot uses the civilian role.
- **A huge hold.** About 105,000 units, several times a battleship's (`cargoCapacity`, read by `cargoCapacityForMaxHealth` on the server and the client alike).
- **26 mounts, all on the hull's drawn dishes.** Mining lasers (weapon group "Mining lasers"): 2 XL at the bow corners angled forward, 2 L at the aft corners, and 4 M and 4 AA in the side rows. Tractors (group "Tractors") mirror the lasers for the size ladder: in each side row an XL dish at the forward end (by the XL lasers), an L dish at the aft end (by the L lasers), 2 M, 2 AA and 1 S dish; 2 XL, 2 L, 4 M, 4 AA and 2 S in all. Reach, beam size and tractor pull scale with the mount size (`MOUNT_SIZE_TUNING`).
- **On film:** showcase shot `barge-mining` (room `showcase-barge-mining`, eight placed rocks too heavy for any tractor round a parked barge): the pilot locks the nearest rock with the mining lasers (key 1) and the tractors (key 2), then holds position; the size ladder does the rest.

### Look options

The barge is a container ship for salvage: about 1.3 times a battleship's length (7,480 u), twice its beam, a deck of container stacks, a few big mining lasers at the bow corners and rows of tractor dishes down both sides so it can strip-mine a field, and a stern engine module wider than the hull (1.4 beams) with three or four round bell nozzles, each about a quarter of the beam across, whose plume at full thrust is 30 % of the hull's length. It has no side of its own: whoever owns it decides that.

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

- **The barge's AI pilot:** its turrets pick salvage targets and it strip-mines a wreck field, banking at its owner's base.
- **Tractor beam on screen:** the client draws the beam and predicts the pull from the snapshot's beam links (with an e2e test and a showcase shot).

## Under the hood

Ore draw: a hit on a rock owes its shooter `damage × weaponTargetFactor(def, 'rock') × ORE_UNITS_PER_DAMAGE` (1/24; the rock factor defaults to 0, the mining laser's is 1). `SectorRoom.applyDamage` hands each hit to `OreDraw.onHit` (`src/server/rooms/OreDraw.ts`); the 1 Hz grid pulse calls `OreDraw.flush`, which pays each shooter's whole units through `OreDraw.mine`, the same draw-into-a-hold path robot harvesters use (`SectorRoom.mineAsteroid`), over the one pool decrement `OreDraw.draw` (the grid Miner's `drawAsteroidResources` hook). A pilot's ore goes to its rostered hull's hold and rides the own-ship snapshot cargo (#16); a `collectsLoot` NPC's to its ownerless hold; any other shooter has no hold, so the rock keeps the ore. A part unit left at the pulse is dropped. Lock: `tests/integration/sectorRoom/oreDraw.test.ts`.

The numbers and the rules (per-target damage factors, why a 0-damage hit is not an attack, the beam's look) are in [weapon-mounts](../architecture/weapon-mounts.md) ("Per-target damage factors", "The mining laser", "Tractor beam"); the tractor's force field and leases in [physics-worker](../architecture/physics-worker.md#force-fields).
