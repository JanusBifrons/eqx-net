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
  - Starter hulls (scout, fighter) are always free.

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
- **W4 — gates:**
  - packed structures for non-starter kinds;
  - the structures agent's `packedGateForBuild` placement seam;
  - processor blueprint slots, which call `applyBlueprint`.
- **W5 — Shipyard:** ship blueprint + goods → a packed hull → unpack into your
  roster. Modules become manufactured items.
- **W6 — blueprint market:** buy and sell blueprints with traders.

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
