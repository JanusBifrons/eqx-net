# Blueprints and packed items (economy v2, Eve-style industry)

Plan `peppy-jumping-pinwheel`, economy v2, built in unison with the structures
agent's production chains (plan `soft-leaping-truffle` v3).

## The vision (the user's rulings)

- **You need a blueprint to produce anything complex**: components, end
  products, ships, and every structure beyond the starter set. That makes
  blueprints valuable.
- **Originals (BPO)** have infinite runs. **Copies (BPC)** have limited runs;
  you can loot or buy them.
- **No tiers. A blueprint has real stats:**
  - `material`: % fewer inputs;
  - `output`: output quality;
  - `runs`: copies only.

  The UI's "quality" is only a glance score summarising those stats.
- **Research** an original in a Research Lab to improve its stats. **Copy** an
  original into copies. **Combine** worse blueprints into a better one (gacha).
  This is W3.
- **A blueprint makes one packed item.** A packed structure ("Packed Smelter")
  or a packed hull is a normal, heavy cargo item. **Placing or unpacking it
  costs nothing but time**: the full goods bill is paid when it is
  manufactured.
- **Casual players don't meet blueprints until mid-game.**
  - Starter structures are built from minerals, exactly as before: capital,
    connector, solar, battery, miner, cargo bay, turret, shield pylon and
    shield gate.
  - Starter hulls (scout, fighter, and the capital classes and fits) are always free.

## Shipped so far

**W2: the item model.**
- **Blueprint items.** `Hold.blueprints` holds `BlueprintItem`s:
  `{ uid, product, kind: 'bpo'|'bpc', runs, material, output, research, bound? }`
  (`src/shared-types/items.ts`).
  - Products are namespaced: `structure:<kind>`, `hull:<shipKind>`,
    `module:<id>`, `recipe:<id>`. Recipes are the structures agent's
    `recipes.ts`.
  - `bound` marks an NPC base's blueprint, which can't be taken out of its
    processor.
- **Packed items.** `Hold.packed` holds `{ product, quality }` entries. Each
  has weight: the catalogue's `packedWeight`, or a default of 25 for
  structures and 40 for hulls. The helpers `addPacked`, `takePacked`
  (best quality first), `packedCount` and `packedWeightOf` live in
  `core/cargo/hold.ts`. They are pure, so the off-screen economy uses the
  same maths.
- **`applyBlueprint(recipe, bp)`** returns `{ inputs, outputs, cyclePulses,
  yieldBonus, quality }`:
  - `material` (max 10 %) trims inputs;
  - `output` (0–100) becomes a chance of an extra unit per cycle (max +12 %),
    which the processor rolls with its own seeded counter;
  - `quality` is stamped onto a discrete product.
  - **Balance cap:** the best blueprint gains at most ~1.24× value, so a
    recipe worth ≤ 1.6× its inputs stays under ~2×. Production can't print
    money.
- **`blueprintQuality(bp)`** is the 0–100 glance score; nothing reads it as
  an input.
- **Runs:** `spendBlueprintRun` spends one run (an original never runs out),
  and `isBlueprintUsedUp` reports a spent copy.
- **Drops.** Elites (~40 %) and incursion caches (~50 %) drop a blueprint for
  a random non-starter product. It is usually a copy (1–10 runs, modest
  stats) and rarely an original (5 %).
- **Migration.** A pre-W2 hold row's bare string ids parse into single-run
  module copies, so nothing is lost.
- **Modules.** P5's installable ship upgrades (Missile Rack, Cargo Expander,
  Reinforced Hull) are now `module:` blueprints. Until W5 makes them
  manufactured items, a module blueprint still installs onto your active ship
  at your storage.

**W4a: packed structures as loot.** The user's ruling: most packed structures
are BOUGHT from NPC factions and traders, and some are LOOTED from ships.
- A robot **nexus** always drops one packed structure, a **hexagon** 6 % of the
  time and a **circle** 2 %. Squares never do.
- Elites drop one ~30 % of the time and incursion caches ~50 %.
- A drop is a random non-starter kind at middling quality (10–59).
- It rides the pod → your hold (it has weight) → your base storage, like any
  cargo. The popups name it: "+Packed Smelter".
- Rolls: `rollPackedStructure` in `blueprints.ts`, wired through each loot
  table's `packedChance`.

## Coming next

- **W3 — Research Lab:** research, copy and combine (gacha). Shipped: see
  [research-lab.md](research-lab.md).
- **W4 — gates.** Shipped:
  - W4a: packed structures drop as loot (above);
  - W4b: traders SELL packed structures (see
    [trade-deals.md](trade-deals.md)), and placing any non-starter structure
    now needs one, from your storage in that sector or your ship's hold;
  - the structures agent shipped the processor blueprint slots and the pack
    recipes (see [production-chains.md](../architecture/production-chains.md)).

  A structure placed from a packed item **costs nothing but time**: it builds
  at the normal rate with no minerals, even unconnected. Deconstructing it
  returns no minerals, since it never used any. Without one, placement is
  refused with a notice saying how to get one. Starter kinds still build from
  minerals.
- **W5 — Shipyard:** ship blueprint + goods → a packed hull → unpack into your
  roster. Modules become manufactured items.
  - **W5a, shipped: unpacking.**
    - A packed hull (`hull:<kind>`) in your storage shows as an **▢ Unpack
      \<ship\>** chip in that storage's inspector. Tapping it turns the crate
      into a ship parked beside the storage, in your roster; pick it from
      the roster like any other.
    - Your roster cap (10) is checked first, and the crate stays put if
      you're full.
    - Elites (~15 %) and incursion caches (~15 %) can drop packed hulls.
  - **W5b, shipped: the Shipyard and the hull gate.**
    - **Shipyard:** a huge hub structure (Build ▸ Industry), 220 power while it
      works. Give it a ship blueprint (`hull:<kind>`) and goods and it builds
      a packed hull into your storage: `build_interceptor`, `build_gunship`,
      `build_heavy` and `build_missile_frigate`. Set the recipe, then load the
      blueprint, like any processor. It also comes packed (`pack_shipyard`).
    - **Traders sell packed hulls:** two hull offers on the board at all times,
      priced from the Shipyard recipe's goods value × 1.3 (`hullBillValue`).
    - **The picker gate:** a NEW ship is always a starter hull (scout, fighter or a capital). Any other
      kind is locked in the picker ("Buy & unpack"); you get one by buying or
      looting a packed hull, unpacking it at your storage, and picking it from
      your roster. A fresh spawn asking for another kind gets a fighter and a
      notice. The server enforces this in galaxy rooms; test rooms opt in with
      `enforceHullGate`.
- **W6 — blueprint market. Shipped.** The Trade tab's **Blueprints** section:
  - **Traders sell** four real blueprints at a time: mostly copies, an original
    1 time in 10. Each is one item, pre-rolled, so what you see is what you get,
    and it leaves the board once bought. Offers expire and restock.
  - **You sell** any blueprint in the selected base back to traders.
  - **Price** = the product's goods bill × 0.3 per run (an original counts as 40
    runs), plus up to 50 % for good stats. Traders sell at × 1.25 and buy at
    × 0.5, and your trader standing shifts both. NPC (bound) blueprints can't
    be sold.
  - **Instant:** a blueprint is weightless data, so buying puts it straight into
    your storage and selling pays straight into your wallet. Each is one
    atomic group with the wallet change.

  **The Build menus show your stock:** every non-starter kind shows how many
  packed ones you have in this sector ("Smelter ×2"), and a kind you have none
  of is dimmed and can't be picked ("Smelter · buy packed"). That covers both
  the speed-dial drill and the desktop bottom bar. It's a request/reply view
  (`packed_stock_query` → `packed_stock`) asked every few seconds while a build
  menu is open, counting the same places the placement gate looks.

  **Quality matters:** a packed item's quality (0–100, set by the blueprint's
  output stat) gives what's made from it up to **+10 % max hull**: the structure
  placed from it, or the ship unpacked from it (stored on the roster row as
  `hull_quality`). Repacking keeps the quality.

  **Repacking:** taking down a structure that was placed from a packed item
  gives the packed item back, at the same quality (EVE-style repackaging). It
  goes into your storage in that base, or drops as a pod where the structure
  stood if no storage is linked to it.

## Tests

- `src/shared-types/blueprints.test.ts`:
  - products (starter kinds excluded) and names;
  - `applyBlueprint` maths and the balance cap;
  - the glance score;
  - runs and used-up copies;
  - drops;
  - legacy-row migration and a W2 round trip.
- `src/core/cargo/hold.test.ts`: packed items weigh, move whole when they fit,
  and come back best quality first.
- `tests/integration/sectorRoom/blueprintInstall.test.ts`: module blueprint
  items install onto a ship through a real room.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

### Build menus show packed stock (economy v2)

- Non-starter structures are placed from a PACKED item. Both build surfaces (the `SpeedDialMenu` kind drill and the desktop `BottomControlPanel`) label each kind via the pure `buildEntry(kindId, counts)` (`shared-types/packedStock.ts`): "Smelter ×2", or LOCKED ("Smelter · buy packed", dimmed, no-op on click/hotkey). Starter kinds are never locked; before the first reply (`counts === null`) nothing is.
- The counts come ONLY from `packed_stock` replies (#16) via `usePackedStock(active)`, asked while a build menu is open. The Zustand `packedStock` field is a discrete map, written only on a reply.
- Locks: `packedStock.test.ts`, `BottomControlPanel.test.tsx`, `packedBuy.test.ts` (server counts).
## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](../architecture/server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Blueprint ITEMS + packed items (economy v2 W2)**: `Hold.blueprints` holds `BlueprintItem`s (`src/shared-types/items.ts`: `uid`, namespaced `product` `structure:|hull:|module:|recipe:`, `bpo`/`bpc`, `runs`, `material`, `output`). **Rules:** (1) blueprint effects go through the ONE pure `applyBlueprint(recipe, bp)` (shared-types; the off-screen economy calls it too); never re-derive the maths. The balance cap (best blueprint <= ~1.24x value) is locked in `blueprints.test.ts`; (2) `blueprintQuality` is a glance score only, never an input; (3) packed structures/hulls live in `Hold.packed` and move ONLY via `core/cargo/hold.ts` `addPacked`/`takePacked` (weight from `packedWeightOf`), so transfers stay conserving; (4) starter kinds (`STARTER_STRUCTURE_KINDS`, `STARTER_HULL_KINDS`) never need a blueprint; (5) pre-W2 string ids parse into single-run module copies (`legacyBlueprintItem`). Story: [docs/features/blueprints.md](blueprints.md).
- **Blueprint market (economy v2 W6)**: `economy/BlueprintMarket.ts` (galaxy-wide board, not persisted: it restocks) + the `bp_market_query` / `bp_buy` / `bp_sell` handlers in `SectorRoom` (`buyBlueprint` / `sellBlueprint`). Buying and selling are INSTANT and each commits the storage change and the wallet op as ONE group (`StorageService.commitChanged`). Values come ONLY from `shared-types/blueprintMarket.ts` (`blueprintValue`); standing via `TradeSink.traderRep`. Bound (NPC) blueprints sell for 0. Lock: `tests/integration/sectorRoom/blueprintMarket.test.ts`.
- **Ship-picker hull gate (economy v2 W5b)**: in `onJoin`, a FRESH spawn (`!resumedFromStore`) in a galaxy room asking for a non-starter hull (`STARTER_HULL_KINDS` = scout, fighter and the player capitals: the five capital classes and three fits) is downgraded to `DEFAULT_SHIP_KIND` with a notice. A ship you OWN (roster row, e.g. unpacked) resumes by its `shipId` as its own kind. Off in test rooms unless the `enforceHullGate` room opt is set (the many tests/showcases that join as other kinds stay unaffected). The client picker locks non-starter cards to match. Packed hulls come from the Shipyard (`build_<ship>` recipes, run by the ProductionSubsystem), trader offers (`PACKED_HULL_OFFERS_ON_BOARD`, priced via `hullBillValue`) and loot. Lock: `tests/integration/sectorRoom/shipyard.test.ts`.
- **Quality → max hull (economy v2)**: `qualityHullFactor(q)` (shared-types/blueprints, up to +10 %) is the ONE source. Structures: `effectiveStructureMaxHealth(base, level, rec.packedQuality)` at EVERY max-HP site (build seed, repair cap, snapshot hpPct, inspector). Ships: `SectorRoom.shipHullMax` multiplies by the roster row's `hullQuality` (new `player_ships.hull_quality` column + migration; threaded through both DB writers and hydrate). Locks: `dbWorker.integration.test.ts` (round trip + old-DB migration), `unpackHull` / `shipyard` / `packedBuy` integration tests.
- **Unpacking hulls (economy v2 W5a)**: `SectorRoom.unpackHull` (the `unpack_hull` message) turns one packed `hull:<kind>` in the owner's storage network into a PARKED roster row (`PlayerShipStore.create`, inactive, beside the storage). Order is load-bearing: check the roster cap, take the crate (one hold group), THEN create the row, and put the crate back if creating fails, so a hull is never duplicated. Galaxy rooms only. Lock: `tests/integration/sectorRoom/unpackHull.test.ts`. Trade has NO sign-in gate (guests are full players; lock: `tradeMessages.test.ts`).
- **Packed structures gate placement (economy v2 W4b)**: a PLAYER's `place_structure` of a non-starter kind needs a packed item. `SectorRoom.packedGateForBuild` (the structures agent's seam, injected here) takes one from the owner's operational storage in this sector, else their active ship's hold, and commits ONLY after the structure registers. A structure placed that way is `prepaid` (persisted): it builds with NO minerals and no route, and deconstructing it reclaims NO minerals (never mint minerals from credits); instead it REPACKS: the grid's `onRepack` hook (before despawn) gives the packed item back at `packedQuality` (persisted) into the owner's linked storage, else a pod (`SectorRoom.repackStructure`). Starter kinds and generated builds (NPC/scenario/scale) skip the gate. Packed structures come from trader offers (`TradeDirector` board, pack-recipe value × `PACKED_MARKUP`, one-off only, carried in the hauler's hold) and loot (W4a). Lock: `tests/integration/sectorRoom/packedBuy.test.ts`. A test placing a non-starter kind by message must stock the packed item first (see `structureTurret.test.ts`).

- **Module blueprints (plan peppy-jumping-pinwheel P5; products `module:<id>` since W2)**: rare weightless loot in `Hold.blueprints`. **Rules:** (1) INSTALLED blueprints are a `fitted` hold keyed `fitted:<shipInstanceId>` — install = ONE atomic hold group (`StorageService.installBlueprint`: storage loses it, fitted gains it); never a roster column; (2) effects go through one seam each: hull = `SectorRoom.shipHullMax` (every hull-seed site + on install), cargo = the loot-collector capacity, weapon gate = `activateMount` (`weaponUnlocked`, shared); (3) `spillOrLoseShipHold` (every death/abandon seam) drops the fitted hold; (4) the own ship's list rides `states[].fitted` (own-only, emit-when-non-empty, read from the `fittedCache` — alloc-free). Lock: `tests/integration/sectorRoom/blueprintInstall.test.ts`. 🔴 netgate (snapshot slice + hull caps). Story: [docs/features/blueprints.md](blueprints.md). Story: [docs/features/bounties-and-events.md](bounties-and-events.md).
