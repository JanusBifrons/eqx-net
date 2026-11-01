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
