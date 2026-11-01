# Production chains

Plan `soft-leaping-truffle` v3. Bases stop being power, storage and turrets in different sizes. Each base runs part of a chain from ore to machinery, and bases trade what they make. This page covers the chain's data (phase P1) and lists what each later phase adds.

Code:
- [src/shared-types/goods.ts](../../src/shared-types/goods.ts)
- [src/shared-types/economy.ts](../../src/shared-types/economy.ts) (`BASE_PRICES`)
- [src/shared-types/recipes.ts](../../src/shared-types/recipes.ts)
- [src/shared-types/asteroidResources.ts](../../src/shared-types/asteroidResources.ts)
- `structureUpgradeGoods` in [src/core/leveling/structureLevel.ts](../../src/core/leveling/structureLevel.ts)

## The chain

| Stage | Goods | Made from | Made at |
|---|---|---|---|
| 0 Raw | minerals, salvage, ice, gas, crystal | asteroids (rock / ice / crystal-veined), nebulae, wrecks | Miner, Gas Collector, Deep Core Rig |
| 1 Refined | alloy, fuel, polymer, silicon, provisions | minerals → alloy; ice → fuel; gas → fuel + polymer; crystal + minerals → silicon; ice → provisions | Smelter, Reclaimer, Refinery, Silicon Works, Hydroponics, Ore Processing Complex |
| 2 Components | components, electronics, munitions | alloy + polymer; silicon + alloy; alloy + fuel | Fabricator, Munitions Works |
| 3 End products | machinery, consumer goods | components + electronics; electronics + polymer | Assembly Plant |
| 4 Exotic | Robot Core | robot loot only | an input to the huge structures |

Every good has a use besides selling it:

| Good | Use |
|---|---|
| fuel | Reactors burn it for power |
| provisions, consumer goods | Colonies and cities consume them |
| munitions | Ammo for missile turrets, autocannons and mine layers. Lasers only use power. Munitions are light (0.1 per unit) and one unit covers many shots |
| alloy, components, machinery | Upgrading a structure to level 3, 4 and 5 (`structureUpgradeGoods`) |
| components, electronics, machinery, Robot Cores | Making packed structures |

## Rules (locked by `src/shared-types/recipes.test.ts`)

- **The value ladder.** Every recipe returns 1.2–1.6× the value of its inputs at `BASE_PRICES`. Each step is worth running, and none prints money. The test is the authority over the prices, not the table in `economy.ts`.
- **Value per weight rises by stage.** The stage medians must not fall, and end products must be at least 4× raw goods. Hauling products pays more per trip than hauling ore.
- **No orphans.** Every good is made by a recipe or comes from extraction or loot (`GOOD_SOURCES`). Every good is used by a recipe or has another use (`GOOD_SINKS`).
- **Blueprints.** Recipes whose main output is stage 2 or later need a blueprint loaded in the processor; refining doesn't. Blueprints belong to the Living World plan (`peppy-jumping-pinwheel`). Its `applyBlueprint(recipe, bp)` scales inputs, outputs and cycle time.
- **Append-only.**
  - `GOOD_IDS` is persisted in hold JSON.
  - `RECIPE_IDS` will be a structure's `recipe` byte.
  - `ASTEROID_RESOURCE_IDS` will be an asteroid's wire byte.

  Append to these lists; never reorder or remove (the same contract as invariant #11).

## How production runs (P2b)

Code: [src/server/structures/ProductionSubsystem.ts](../../src/server/structures/ProductionSubsystem.ts), status bytes in [src/shared-types/production.ts](../../src/shared-types/production.ts).

1. **The network's storage is the warehouse.** A processor draws from the same-owner operational storage in its grid component: the Capital bank (minerals), Cargo Bays and Freight Docks.
2. **Start a cycle:** take the recipe's inputs, all or nothing. If one is missing, the processor is **starved**, and room state says which good it is waiting for.
3. **Run:** one step per powered pulse. With no power it pauses (**unpowered**); inputs it already holds stay held.
4. **Finish:** put the outputs into storage, all or nothing (minerals fill the Capital bank first, other goods fill holds by weight). With no room it stays **blocked** until there is space.

Other rules:
- **Scarce inputs are shared round-robin.** The starting processor rotates each pulse in a fixed order, so results are deterministic.
- **Storage is updated in place,** like mining and construction, and `StorageService.flushDirty()` persists it on the same pulse.
- **The recipe choice and a cycle in progress survive a restart.**
- **Changing recipe mid-cycle** hands the loaded inputs back, or refuses the change if they no longer fit.
- **Blueprints:** a recipe with `blueprintRequired` runs only with a matching blueprint in the processor's slot (`recipe:<id>`, or `structure:<kind>` for a pack recipe).
  - **Load and unload:** the owner sends `load_blueprint`, which takes the best one from base storage (an original first, then the highest quality), or `unload_blueprint`. Each move is ONE hold group, and the slot persists as the `bpslot:<uid>` hold. Bound NPC blueprints can't be unloaded.
  - **Effects:** Living World's `applyBlueprint` trims the inputs. A copy spends one run per cycle and leaves the slot when used up. Output quality gives a chance of one extra unit per goods output, rolled deterministically per processor and cycle. A packed structure carries the quality.
  - **Destruction:** a destroyed processor spills its (unbound) blueprint.
- **Cost:** 60 smelters with 20 storages take under 0.3 ms per pulse, locked by `ProductionSubsystem.test.ts`. Processors in one component share a single network lookup.
- **Wire:** room-state bytes `recipe`, `prodState` and `prodMissing`, sent only when not 0 (#16). Late joiners read them from the join payload.

## Active power: full draw only while working

User ruling (2026-11-01): "not everything should drain full power all of the time. Only when actively processing material should it draw full power. If it's idle it won't… They should draw a small amount when idle, just not full."

- **The rule** lives in one shared function, `structureDraw(powerConsumption, drawFull)` in [src/shared-types/structurePower.ts](../../src/shared-types/structurePower.ts). A structure draws its full `powerConsumption` while ACTIVE and `IDLE_DRAW_FRAC` (0.2) of it otherwise. The server's grid view and the client's grid mirror both call it (#15).
- **What counts as active:**

  | Structure | Active while |
  |---|---|
  | Processor (Smelter, Fabricator, …) | its cycle is running (`prodState === running`) |
  | Drill (Miner, Deep Core Rig) | it has an asteroid to mine |
  | Gas Collector | it is gathering (nebula sector, powered) |
  | Turret (every kind) | it has a target |
  | Research Lab | its job is advancing |

  Everything else (connectors, storage, shield pylons and gates) never becomes active, so it always draws the idle trickle. Pylons hold their walls on it; a hit on a wall is paid from the grid surplus and then from batteries, so batteries remain a real strategy.
- **The server decides.** `StructureGridSubsystem.setActive(rec, active)` flips `rec.drawFull` and adjusts the structure's grid component by the difference with `Grid.adjustDraw`, an O(1) update with no topology rebuild. The flag rides room state as `STRUCTURE_FLAG_DRAW_FULL` (64), so the client's power readouts and the inspector match.
- **Brown-outs alternate.** A grid that only affords its structures idle powers up, a structure starts working and draws full, the grid goes negative, the structure drops back to idle on the next pulse, and so on. Batteries cover the gap: that is what they are for.
- **The generator sizes for expected use.** `growBase` prices power at `expectedDraw(kind) = cons × (u + (1 − u) × IDLE_DRAW_FRAC)`, with utilisation `u` from `EXPECTED_ACTIVE` (processors 0.6, drills 0.8, turrets 0.15), and adds two extra batteries to fenced bases. So NPC bases don't build power for every machine at 100 % at once (`BASE_GROWTH_VERSION` 3).
- **Locks:** `StructureGridSubsystem.test.ts` (brown-out alternation, battery recovery, overdrawn turret), `structureMining.test.ts` and `structureTurret.test.ts` (integration: alternating drill, a drilling miner overdraws a turret), `researchLab.test.ts` (a lab draws full only while its job runs), `growBase.test.ts` (power ≥ 0 at expected draw).

## NPC bases in the galaxy (T1)

Every galaxy sector grows its own NPC base when its room is created (`SectorRoom.seedGalaxyBase`, enabled for every galaxy room by `resolveSectorConfig`):
- **Profile and growth.** `contextForSector` → `baseProfileFor` (tier, role, wealth, level cap, fence) → `growBase`. The seed is `hashString(sectorKey)`, so a sector's base is stable across restarts.
- **After the restore.** Seeding runs AFTER the sector snapshot restore, so saved player structures and parked hulls are already in place and always win the space.
- **Site.** The pure `chooseBaseSite` (`src/core/bases/baseSite.ts`) scans the sector on a 250 u grid for a Capital position where the whole base, plus a 250 u margin, fits inside the sector and touches no player structure or parked hull. It prefers the fewest asteroids, then the site farthest from the origin (where players spawn). Asteroids under the chosen footprint are cleared quietly (no destroy event).
- **Spawns.** A fresh spawn that would land inside any structure's box is moved to the nearest clear point (`nearestClearPoint`, 120 u clearance). A citadel (≈6,000 × 6,400 u) can't avoid the origin in a 10,000 u sector, so this matters.
- **Not persisted.** A restart regrows the base. **Kill switch:** `EQX_DISABLE_NPC_BASES=1`.

Today's galaxy (seeded): 13 outposts, 6 settlements, a stronghold (andromeda-rim) and a citadel (bloomgate), all trader bases.

Locks:
- `baseSite.test.ts`: site rules, and every real sector's base fits its sector;
- `tests/integration/sectorRoom/galaxyBases.test.ts`: the bloomgate citadel is placed in full in a real room with its asteroid field; a spawn on its Capital is nudged clear (fails without the nudge); the kill switch.

## Convoys between NPC bases (T2)

**Why no off-screen economy.** Every galaxy room is created at boot and simulates when empty, so every NPC base already runs its real production pulse. The plan's `advanceBaseEconomy` (with its 2 % equivalence test) isn't needed. Trade between bases is just convoys.

**Planning** (`src/core/economy/convoys.ts`, pure; every 15 s):
- **Rates.** Each room reports its NPC bases (`SectorRoom.npcBaseTrade`): storage stock, free space, footprint box, and per-minute use/make rates read from the base's own structures (processor recipes, Reactor fuel, ammo turrets, drills, gas collectors).
- **Need and spare.** A base **needs** an input below half of `TARGET_MINUTES` (10) of use, and is refilled to the target. It **offers** anything beyond its own 10 minutes, when that is at least `MIN_LOAD_WEIGHT` (20).
- **Matching.** `matchConvoys` serves the most-starved importer first, from the nearest exporter by galaxy hops, capped at a hauler-load (400 weight). Goods promised to convoys still on their way to pick up are not spare.

**Flying** (`src/server/economy/ConvoyDirector.ts`, process-global, 1 s loop). One convoy is one `trader-hauler`; its id prefix `hauler-convoy-` starts with `hauler-`, so every hauler rule applies.
- **Pickup.** It enters at the sector edge on the base's own side, stepped back until clear of the footprint (haulers cruise at about 40 u/s, so a far-side entry made each leg minutes long). It docks just OUTSIDE the base's box, since a fence blocks every ship and only player ships open gates, then loads in one atomic `tradeTransfer` take.
- **Outbound / transit.** It leaves at the same edge. Transit is abstract, `hopMs` (20 s) per galaxy hop; a same-sector convoy skips straight to delivery.
- **Delivery.** It enters the importer's sector the same way, docks, and unloads in one atomic `tradeTransfer` release; overflow drops as a pod.
- **Raids.** A hauler destroyed anywhere spills its hold (existing hauler rule), and the convoy ends.

**Limits.** At most 12 convoys in flight, at most 4 convoy haulers per sector, and the room's free-slot check applies. Convoys aren't persisted (neither are NPC bases); `start()` discards any convoy hold a crash left behind.

**Kill switch:** `EQX_DISABLE_CONVOYS=1` (also off with `EQX_DISABLE_NPC_BASES`). **Diagnostics:** `GET /dev/convoys` (phase, hauler pose, target).

**Measured live** (21 seeded sectors, first 3 minutes after boot): 9 convoys launched, 7 loaded and 4 delivered across sectors.

Locks:
- `convoys.test.ts` (needs, spare, matching);
- `ConvoyDirector.test.ts` (fake rooms): same-sector and cross-sector delivery with goods conserved and no hold left, a raid ends the convoy, crash holds discarded, entry outside the footprint, no double promise (fails without the fix);
- `tests/integration/sectorRoom/convoys.test.ts`: a real seeded base reports itself, loads a convoy hold, and a killed convoy hauler spills it.

## Packed structures

User rulings (2026-11-01):
- **Every non-starter structure is placed from a packed item.** Placing it costs only time.
- **NPC factions make packed structures, and players mostly buy them.** Traders sell them (Living World W4, priced from `packBillValue` plus a markup).
- **They can also be looted from ships:** raided haulers and convoys, and NPC loot.

How it works:
- **Pack recipes:** `pack_<kind>` recipes, one per non-starter kind, run on a Fabricator, or an Assembly Plant for the huge kinds. They need the structure's blueprint and pay its goods bill.
- **Placement seam:** `StructurePlacementSubsystem`'s `packedGateForBuild` hook.
  - **Who it checks:** only a player's `place_structure` of a non-starter kind (`requirePacked`).
  - **Order:** it runs after the overlap rules. The packed item is consumed only after the structure is registered, so a failed spawn spends nothing.
  - **Until it's on:** the hook is injected only when packed structures can be bought (W4). Until then, every kind still builds from minerals.

## Asteroids

A sector's asteroid field mixes three kinds, weighted by the sector's galaxy `features`:

| Kind | A Miner gets (per 10 units) | More common in |
|---|---|---|
| Rock | 10 minerals | everywhere |
| Ice | 10 ice | nebula sectors |
| Crystal-veined | 8 minerals + 2 crystal | mineral sectors, black holes |

`rollAsteroidResource(u, features)` picks a kind from an injected uniform roll; the room seeds it with an FNV hash of the asteroid's id, so a restart rolls the same kinds.
- **Room options:** the galaxy sector's `features` drive the mix. A testMode room can override them with the `sectorFeatures` room option (e.g. `['nebula']` to make Gas Collectors work); integration tests also use `_internals.spawnTestAsteroid(id, x, y, r, resource)`.
- **Full storage loses the extra:** ice and crystal that don't fit in network storage are lost (the drill keeps drilling). A later pass may pause the drill instead.

## What each phase adds

| Phase | Adds |
|---|---|
| P1 | This data and its tests. No live behaviour changes. |
| P2e | Minerals at the goods scale, and goods for upgrades. The Miner makes 20 minerals a pulse (was 1000), the Capital bank holds 50,000 (was 2,000,000) and the Deep Core Rig drills 120, so what a base can afford finally limits it. The structure catalogue version went 9 → 10, so saved structures reset once (user: "Resets are fine at this stage"). Upgrades to level 3, 4 and 5 also take `structureUpgradeGoods` (alloy, then components, then machinery) from base storage when they start, all or nothing; the Upgrade tooltip names them. The bank stays the Capital's minerals: production, deposits and trade already treat it as part of the network's mineral stock, so it is one pool. |
| P2d | Ammo. Physical ordnance spends munitions; lasers only spend power (user ruling). The new **Autocannon Turret** (kinetic `autocannon` shells) and the **Missile Turret** reload a magazine of `AMMO_SHOTS_PER_UNIT` shots (8 missiles / 40 bursts, `src/shared-types/ammo.ts`) from ONE unit of munitions in base storage when empty. With none, the turret doesn't fire, and the `STRUCTURE_FLAG_NO_AMMO` room-state bit shows "NO MUNITIONS" in the inspector. The Mine Layer comes next (it needs a mine entity). |
| P2c | Extraction by resource. Each asteroid gets a kind, rolled from its sector's features and seeded by its id; it rides the swarm wire's shared subtype byte (rock = 0, so existing rocks are unchanged), and the client tints ice and crystal. Miners (and the Deep Core Rig: any kind with a `miningRate`) yield by kind: minerals to the drill's buffer as before, ice and crystal straight into network storage. Gas Collectors gather `gasRate` gas per pulse in nebula sectors. |
| P2b | Production runs. `ProductionSubsystem` steps every built processor once per 1 Hz grid pulse (see "How production runs" below). The inspector shows "MAKES <recipe> · <status>", and owners change a multi-recipe processor with `set_recipe`. |
| P2a | The 12 production kinds join the structure catalogue (appended, no version bump), with footprints, drawings, build icons and a new Industry build category. The Deep Core Rig, Ore Processing Complex and Assembly Plant are hubs with 4 links. They can be placed but don't produce yet. |
| P2 | The production structures, a processing step in the 1 Hz grid pulse, Miner yields by asteroid kind, ammo, the upgrade goods bill, one mineral pool. Packed structures arrive once Living World's packed items land. |
| D1–D2 | The base generator grows a chain for each base's role (mining outpost, refinery, workshop, manufactory, assembly works, trade hub). |
| T | Trade between bases: convoys, regional prices, Freight Dock orders. Payments go through the Living World wallet. |
| D3 | Cities: the main consumers of provisions and consumer goods. |

## Base roles and the growth generator (D1)

Code: [src/core/bases/baseProfile.ts](../../src/core/bases/baseProfile.ts) and [src/core/bases/growBase.ts](../../src/core/bases/growBase.ts). Both are pure and seeded.

**`contextForSector(key)`** derives where a sector sits in its region:
- **Heart:** the sector nearest the region's hex centre.
- **Hops from the heart:** counted within the region.
- **Entry and chokepoint:** whether it is an entry (edge) sector, and whether it borders another region (a chokepoint).
- **Features:** the sector's own.

**`baseProfileFor(context, seed)`** picks:

| Choice | Rule |
|---|---|
| Tier | Outposts are the majority; citadels appear only at a region heart; edge sectors are almost always outposts |
| Role | Mining, refinery, workshop, manufactory, assembly (hearts only) or trade, weighted by features: extraction sectors mine, stations and chokepoints trade, central sectors manufacture |
| Wealth | Rises toward the heart |
| Level cap | 1–2 for outposts up to 4–5 for citadels |
| Fenced | ≥ 80 % of bases overall |

**`growBase(profile, seed, features)`** builds the base as a builder would:
1. **Buy:** the role's units, a Freight Dock, storage and turrets, within wealth and per-tier caps.
   - **Price:** each purchase costs its construction cost, its pack bill (for packed kinds), and the Solars that power it.
   - **Huge kinds:** at most one per base.
2. **Lay out:** connector rows around the Capital, with leaves above and below each row connector.
   - **Spine:** it stays bare, with relay connectors where a row gap exceeds range.
   - **Spacing:** the row pitch comes from the tallest structure.
   - **The huge kind:** it sits on its own outer row.
3. **Power:** lay out, measure the real draw (the fence depends on the layout), and add Solars until net power ≥ 0.
4. **Fence:** a rectangle of Shield Pylons around the extent, with a Shield Gate in the middle of each side, tapped from the row ends.
5. **Budget:** a base over its tier's budget spends 15 % less and regrows.

**Locks:**
- **`growBase.test.ts`** re-checks every base against the real `placementRejection` and `canConnect`, and checks that each one is:
  - connected to the Capital and powered;
  - within its tier's budget;
  - in fewer than 4 chain stages (an outpost in at most 2);
  - deterministic;
  - true to its role (mining bases are mostly extractors, trade hubs mostly storage).

  It runs a sweep over every galaxy sector.
- **`baseProfile.test.ts`** covers the profiles.

**Consolidated kinds (D1).** Each is priced above the standard units it replaces, so only wealthy bases have many.

| Kind | Replaces | Footprint |
|---|---|---|
| **Reactor** | ~8 Solars of power (240). It burns one unit of fuel from base storage every 10 pulses, and only produces while fuelled; out of fuel, it shows "NO FUEL" | 400 × 400 |
| **Battery Bank** | 10 Batteries | 360 × 360 |
| **Storage Vault** | 8 Cargo Bays | 480 × 320 |

The generator powers bases with Reactors first, then Solars, and uses a Battery Bank where it would otherwise need five or more Batteries. Fences used to dominate small bases (a Shield Pylon draws 20 power, a Solar makes 30).

| Tier | Before the Reactor | After |
|---|---|---|
| Fenced outpost | 78 | 43 |
| Settlement | 99 | 60 |
| Stronghold | 198 | 116 |
| Citadel | 236 | 123 |

`TIER_MAX_STRUCTURES` is now 50 / 80 / 160 / 260. NPC bases need fuel stock for their Reactors, so D2 seeds it and trade (T) keeps them supplied.

## NPC bases in the game (D2)

Code: [src/server/bases/NpcBaseSubsystem.ts](../../src/server/bases/NpcBaseSubsystem.ts). The `npcBases` room option takes specs like `{ baseId, role, tier, seed, x, y, features }`.

`seed(spec)` grows the base with `growBase`, then:
- **Place:** each structure goes through the real `StructurePlacementSubsystem` (`skipAutoConnect`), owned by `npc:<side>:<baseId>`.
- **Link:** the generator's edges are applied with `connectExplicit`, which re-checks the real `canConnect`.
- **Build:** every structure is built at its level, with its HP at the leveled maximum.
- **Set up processors:** their recipes, plus a BOUND faction blueprint (an original that can't be unloaded) where the recipe needs one.
- **Gates:** they open for anyone not hostile.
- **Stock:** an hour of Reactor fuel, munitions for ammo turrets, and 20 cycles of each processor's inputs.

Then the real systems run: power, batteries, fence, turrets, production. NPC structures aren't persisted; a restart regenerates them from the seed.

**Test rooms:** `npc-base-outpost` (mining), `npc-base-settlement` (refinery), `npc-base-stronghold` (manufactory) and `npc-base-citadel` (assembly works). Each has `filterBy(testId)` and spawns the pilot south of the fence.

**Lock:** `tests/integration/sectorRoom/npcBases.test.ts`.
- Every structure is placed, NPC-owned, built and reachable from the Capital through the live grid, with zero rejected placements or edges.
- After pulses, Reactors are fuelled and processors run.
- Gates are open, and manufactory blueprints are bound originals.
