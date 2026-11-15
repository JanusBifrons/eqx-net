# Loot & Cargo

Plan: `peppy-jumping-pinwheel` (Living World: Allegiances, Loot & Trade).
Part 1 (P1a-1): loot pods, fly-over pickup, carrying cargo, losing it on death.
Part 2 (P1a-2) adds base storage, auto-deposit, derelicts and credit sinks.

> **Economy v2 W1 supersedes the credits on this page.** Credits are now a
> virtual per-player **wallet**: never in a hold, pod or storage, never dropped,
> spilled or stolen. Kills pay a bounty into the wallet, and repairs and
> respecs are paid from it. See [economy-wallet.md](economy-wallet.md). Where
> this page says credits ride in pods or holds, read "goods and blueprints".

## What the player sees

- **Every kill drops loot.** A destroyed ship, whoever flew it, leaves a
  small glowing diamond, a *loot pod*, just beside where it died (off to the
  side of the shot that killed it, so the rest of the volley doesn't blow it
  up). AI-vs-AI kills drop loot too, so a
  battlefield you stumble onto is worth picking over. A ship burned away
  whole by a heavy beam or a railgun (vaporised) leaves half as much salvage
  again: the beam rendered the whole ship down.
- **Fly over a pod to collect it.** No button: touching a pod with free cargo
  space moves its contents into your ship's hold. A popup confirms what you
  got ("+7 Salvage · +30 cr").
- **Your hold is on your ship.** The top-left chip shows weight / capacity,
  credits and blueprints (`▣ 340/500  ¢1,250  ★1`). It turns amber at 80 %
  and red when full; tap it for a per-good breakdown. A full hold still
  picks up credits and blueprints (they weigh nothing); the rest stays in the
  pod.
- **Hardcore.** If your ship dies, everything it carries spills as a bright
  magenta pod beside where it died, with the salvage its hull is worth (the
  same as an AI pilot's ship of that kind), free for anyone to grab. The dead ship keeps
  nothing. Abandoning a ship spills its hold too (P1a-2 turns that into a
  salvageable hulk).
- **Pods don't last.** A pod expires after 15 minutes, and a pod can be shot
  and destroyed (its contents are lost).

## Goods

| Good | Weight | Tier (glow) |
|---|---|---|
| Minerals | 0.1 | grey |
| Salvage | 1 | grey |
| Alloy | 2 | blue |
| Robot Core | 5 | gold |
| Credits, blueprints | 0 | gold (blueprint) |

A dead player's spilled cargo glows bright magenta. An NPC's drop is an
ordinary pod coloured by its contents (owner 2026-11-13: bright NPC pods read
as live ships among the wreckage). Cargo capacity is derived
from the ship's toughness (`maxHealth × 2`), so heavier hulls haul more, unless
the kind sets a `cargoCapacity` override (the robot harvester's 400; later a
mining barge). Server clamp, client HUD and NPC collectors all call the one
`cargoCapacityForMaxHealth(kind)`. An NPC kind with `collectsLoot: true` scoops
pods through the same pickup path as players (`SectorRoom.forEachLootCollector`).

## How it works

**One shape everywhere: the hold.** Every unit of value lives in exactly one
*hold*: a ship's, a pod's, and in P1a-2 a storage structure's. Moving value is
always a `transferInto(dst, src, capacity)` (`src/core/cargo/hold.ts`). Value
only moves; it is never copied. A test locks conservation.

**One table: `holds`.** All holds persist in one SQLite table keyed by holder
id, written as *absolute* state (upserts, never deltas). The in-memory
`HoldStore` is the authority. Every transfer is committed as ONE atomic
`GROUP` op, applied inside a SAVEPOINT. A pickup (ship gains, pod deleted) can
never half-apply, and a failing group rolls back alone without discarding
other players' writes. Replays are idempotent.

**Pods ride the scrap wire.** A pod is a scrap-kind swarm entity whose parent
ship kind is `cargo-pod` and whose `componentIndex` is its glow tier. The
client already draws scrap by `(parentKind, componentIndex)`, so pods needed
no wire change. Pods are kept OUT of the scrap FIFO (its eviction would delete
value) and OUT of the sector snapshot. They persist only via the `holds` table
and are restored on room hydrate, so there is no double-restore.

**Caps.** At most 64 live pods per sector. A drop within 60 u of a pod, or any
drop at the cap, merges into a pod instead of evicting one.

**Who can collect.** Only ACTIVE, alive hulls with a roster row. Lingering
hulls never collect. A ship with no roster row (engineering rooms, roster
full) has nowhere to keep a hold, so it can't pick anything up.

**Client truth.** The own active ship's hold rides `SnapshotMessage.states[].cargo`
(invariant #16, zero bytes when empty). `loot_collected` is only the popup
accelerator. A lost message loses a popup, never value.

## Death seams (all spill the hold)

| Seam | Where |
|---|---|
| Active hull killed | `SHIP_DESTROYED` handler, before the roster wipe |
| Lingering hull killed | `LeafDeps.onLingeringHullDeath` (runs before teardown) |
| Active ship abandoned | `abandonShipToScrap` |
| Lingering hull abandoned | `abandonLingeringHullToScrap` |

Fixing the lingering seam exposed a pre-existing bug (hostile-review A1): a
killed lingering hull never deleted its roster row. See `docs/LESSONS.md`.

## Hull salvage: every ship, and vaporised ships (owner 2026-11-15)

**Every ship drops its hull loot, whoever flies it.** Owner: "Why would the
player be special?" A ship's hull loot is its kind's loot table (`rollLoot`,
an elite's `rollEliteLoot`), rolled from a seed by the one helper
`rollHullLoot` (`src/server/cargo/hullLoot.ts`):

- **AI-flown:** rolled ONCE per spawn into its hold (`npcHold`, seed
  `<id>:<entityId>`), so a break-in that took some leaves less to drop.
- **Player-flown:** rolled as it dies (seed: its `shipInstanceId`) and
  dropped in the SAME pod as its carried hold (`spillOrLoseShipHold`'s
  `death` argument → `LootSubsystem.spillShipHold`'s `extra`, one atomic
  group). A player ship with nothing aboard still drops its hull loot, as an
  ordinary pod; with cargo the pod is the bright spill tier as before. An
  abandoned hull drops no hull loot (it is a derelict, not a kill). The
  kill bounty is still for AI-flown kills only (economy-wallet.md).

**Vaporised ships leave more salvage.** A ship a cut weapon burns away whole
(heavy-beam slice or railgun channel, `destroy.vaporised`, fracture v11)
still leaves ONE pod, with its hull's salvage × `VAPORISE_SALVAGE_MUL` = 1.5
(`shared-types/lootTables.ts`, rounded: `vaporiseSalvageBonus`), "because the
beam rendered the whole ship down". Only the hull roll's `salvage` scales:
carried cargo, alloy, cores, blueprints and packed items don't. For an AI
ship the bonus is on the hull salvage still aboard (`min(rolled, aboard)`), so
cargo salvage a harvester scooped is never multiplied. Each death path knows
the outcome before it drops: a drone through `evictSwarmEntity({ vaporised })`
→ `dropKillLoot`, a lingering hull through `onLingeringHullDeath(…,
vaporised)`, an active hull through `spawnActiveHullWreck` noting
`vaporisedActiveDeath` for the `SHIP_DESTROYED` handler.

**Placement.** Every kill pod (AI or player) spawns beside the dead hull, to
the side of the killer's line (`killPodSpot`: 1.2 hull radii plus the pod's
radius, side seeded from the ship), so the rest of a salvo and a heavy beam's
kill follow-through (`followThroughTicks`, which runs on down that line) pass
it. AI and turret shots never hit a loot pod anyway (`isLootPod`); only a
pilot's own shot can.

Example, a fighter (default table, `maxHealth / 50` scale): a normal kill
rolling 14 salvage drops 14; vaporised, 21.

Locks: `tests/integration/sectorRoom/vaporiseSalvage.test.ts` (an AI fighter
vaporised by the heavy beam: one pod, 1.5× its hull salvage, a normal kill
1×; a player fighter killed normally: hull loot + hold in one pod; vaporised:
1.5× + hold; an AI beam cruiser's vaporising kill: the pod sits off the kill
line and survives the follow-through), `lootLoop.test.ts` (the hardcore spill
counts the hull roll).

## Part 2 (P1a-2): base storage, auto-deposit, derelicts, credit sinks

### What the player sees
- **Bring it home.** Fly within 400 u of your own Capital or **Cargo Bay** and
  hold position for 2 s. A bar under the cargo chip fills, then everything you
  carry is banked ("Banked +9 Salvage · +77 cr").
  - Minerals go to the Capital's construction bank, so loot funds building.
  - Everything else fills the storage hold by weight. Capital 5000, Cargo Bay
    2000.
- **Storage is a network.** Same-owner storage connected by your grid forms one
  network: a deposit fills the nearest storage, then overflows across it.
  Whatever doesn't fit stays aboard.
- **Cargo Bay.** A cheap leaf structure (Economy build category) you can put at
  an outpost as a forward drop-off.
- **Inspector.** Selecting your own storage shows `HOLD 12/5000 · Salvage 9 ·
  ¢77`. Only the owner sees the contents; the server strips them for everyone
  else. A Capital with salvage gets a **Refine** action (1 salvage → 10
  minerals). Any owned storage has **Repair** (fix your ship to full here).
- **Credits have uses.**
  - Instant repair costs 0.5 cr per missing hull point.
  - A stat respec costs 100 cr.
  - Both are paid from credits banked in that sector. Not enough credits or not
    near your storage gives a short HUD notice.
- **Lose it like you earned it.** A storage structure that is razed (or
  deconstructed) spills its whole payload as a pod.
- **Derelicts.** An abandoned ship's cargo becomes a bright *derelict* hulk that
  lasts an hour. Fly alongside to salvage it over time (15 weight units per
  step), and anyone else alongside it competes for the haul.
- **Logging off is risky.** A ship whose pilot disconnected is AI-targetable.
  You can't combat-log a full hold to safety. A just-joined ship still being set
  up is NOT targetable.
- **Radar.** Loot pods and derelicts show as gold diamonds on the off-screen
  ring.

### How it works
- **Stable structure identity.** Entity ids are re-minted on restart, so each
  structure has a `uid`: a deterministic hash of sector, owner, kind and
  rounded pose. All four are persisted, so a restore recomputes the same uid
  with no snapshot change.
- **One store of value (hostile-review A4).** Each storage structure's payload
  (goods hold + the Capital's mineral bank) is a `holds` row keyed by `uid`.
  - Player transfers (deposit, refine, credit spends) commit the ship side and
    every touched structure as one atomic group.
  - Server-internal mineral flows (mining, hauling, construction) are
    dirty-flushed on the 1 Hz grid pulse. A crash can lose about a second of
    mining but never duplicate player value.
  - On hydrate the fresher holds row overlays the snapshot.
- **Derelicts** are pods with holder type `derelict`. They are never merge
  targets and are rate-limited per collect step. Popups are throttled.

### Deferred
- **Buy ship** (decision 8) moves to P2. Spawning happens from the galaxy
  picker, outside any sector's bank, so it needs P2's player-wide economy view.
- **Ownerless storage** becomes derelict when a base loses its owner. Nothing
  in the game removes an owner yet, so there is no trigger.

## Part 3 (C1): open a structure's cargo and move items by hand

Plan soft-leaping-truffle v3, phase C1. Auto-deposit banks everything you carry; opening the cargo lets you choose.

**What the player does.** Fly up to a storage structure (a Capital, Cargo Bay, Storage Vault…) and open its cargo. One pane is the structure's contents, including a Capital's mineral bank; the other is your ship's hold. Move items either way: **take** loads them aboard, **put** unloads them into that structure.

**When it opens** (server-checked on every message, `SectorRoom.cargoAccess`):
- **Who:** the relation allows it. `cargoOpensFor(relationOf(you, owner))` opens for your own and friendly cargo; allied cargo only if the owner allows it, and there is no owner setting yet, so not today. Neutral and hostile cargo is **locked**, and later needs a break-in (C2). An NPC trader base is neutral, so it is locked.
- **A live ship:** ACTIVE, alive, with a roster row (#17, the same liveness as loot pickup).
- **In range:** within `CARGO_ACCESS_RANGE` (400 u) of the structure's **footprint edge**, not its centre (large structures).

**How a move works** (`StorageService.cargoTake` / `cargoPut`):
- **Exactly what was asked.** `extractRequested` (core/cargo/hold.ts) pulls exactly the requested items, clamped to what is there.
- **Capacity.** `transferInto` applies the destination's capacity, and whatever doesn't fit goes back. Value is conserved.
- **Minerals.** A take draws a Capital's minerals from its goods hold first, then its bank. A put fills the bank first, like a deposit.
- **Atomic.** The ship row and the structure row commit as ONE hold group.

**A withdrawal sticks.** After a manual move, auto-deposit stays off for that pilot until they fly out of deposit range of their storage (`SectorRoom.manualCargo`). Otherwise anything you took from your own storage would be banked straight back 2 s later.

**Wire (#16).** `cargo_query` / `cargo_move` → `cargo_state` (`shared-types/messages/cargoMessages.ts`). `cargo_state` carries BOTH the structure's hold and the pilot's ship hold, so the two panes always agree; the panel is rebuilt from it only. The inspector's hold readout (`entity_stats`) shows to anyone the cargo would open for. Each move is audited as `cargo_moved`.

**Lock:** `tests/integration/sectorRoom/cargoAccess.test.ts`:
- take and put move items;
- a withdrawal sticks (this fails without the manual-cargo rule);
- a stranger and an NPC base are locked;
- too far reads "Fly closer".

Unit locks: `hold.test.ts` (`extractRequested`) and `StorageService.test.ts` (cargo access).

**The panel (C1b).** Select any BUILT storage structure; the inspector shows an **Open cargo** button (`cargo-open-toggle`). It opens `CargoPanel`, which asks every second while open:
- **Here:** the structure's contents, each row with Take 1 / Take all.
- **Aboard:** your hold, each row with Put 1 / Put all.
- **Locked or far:** it shows why.

Rows come from the pure `cargoRows` (goods by name, "Smelter (packed)", "Smelter blueprint (3 runs)"; never ids).

Locks:
- `cargoRows.test.ts`, `CargoPanel.test.tsx`, `EntityStatsPanel.test.tsx`;
- `tests/unit/tradeClientWireParity.test.ts`: the real senders' payloads parse with the server schemas;
- the feature-tier E2E `tests/e2e/cargo-panel.spec.ts`: place a Capital in `trade-test`, open it, take 1 alloy, put it back.

**Next (C1c):** holds on every structure kind (with "is a deposit target" separate), and NPC ship holds rolled from a seed.

## Part 4 (T4): trade at an NPC Freight Dock

Every generated NPC base has a Freight Dock, and its gates open for anyone not hostile. Fly in and open the dock (the same **Open cargo** button). If you aren't hostile to its side, it opens as a **market**, not free access:
- **For sale:** the base's stock across its whole storage network. **Buy** moves goods aboard and the wallet pays.
- **Aboard:** your hold. **Sell** moves goods into the dock and the wallet is paid.
- **Prices:** the trade board's, for you, here. That means the regional factor (T3) and your trader standing: the dock charges more than it pays (the spread), and traders who refuse to deal with you keep it closed.
- **Clamps:** each trade is clamped to the stock, your cargo space, your credits and your hourly trade volume.
- **Atomic, and part of the economy.** Each good is ONE atomic group: the ship row, the storage and the wallet op. Every fill moves the galaxy market and counts toward volume, exactly like a deal.
- **Code:** `SectorRoom.cargoAccess` (market mode) → `dockMarket`; `StorageService.marketBuy` / `marketSell`; the trade sink's `dockQuote` / `volumeLeft` / `recordDockFill`. Audit: `dock_trade`.
- **Your own Freight Dock (T4b):** the cargo panel adds **Standing orders**: "buy up to N" or "sell above N" per good. NPC convoys fill them at the board price; see [production-chains.md](../architecture/production-chains.md#standing-orders-at-a-players-freight-dock-t4b).
- **Locks:** `tests/integration/sectorRoom/dockMarket.test.ts` (buy and sell at the board price; wallet, hold and base stock all move), `StorageService.test.ts` (the wallet op rides the same group), `CargoPanel.test.tsx` (market mode: priced Buy/Sell, goods only).

## Part 5 (C2): break-ins

Cargo that doesn't open for you (another player's, or an NPC base's when the market is closed to you) can be broken into. The cargo panel's **Break in · Ns** button starts it.
- **Duration.** `breakInDurationMs(holdCapacity, level)` in `shared-types/breakIn.ts`: 10 s for a small level-1 store, longer for bigger and higher-level ones, at most 45 s.
- **A hostile act from the first second.** It goes in the `HostileActLedger`:
  - the owner's turrets engage you. **Player turrets now target pilots hostile to their owner**; this path is skipped while the ledger is empty, so it is byte-identical otherwise;
  - an NPC side's ships within `ON_SIGHT_ENGAGE_RANGE` turn on you (`markHostile` + `bot_aggro`);
  - a player owner is alerted: a `break_in_notice` toast online, a push offline.
- **What interrupts it:** leaving range, either side dying, or taking ANY hit. A defended base usually stops a break-in this way.
- **Success** opens the cargo to you for `BREAK_IN_ACCESS_MS` (60 s), with normal take/put.
- **Truth (#16).**
  - Your progress rides `cargo_state.breakIn`, which the panel polls.
  - Everyone else sees the structure's **BREACH** room-state flag (`STRUCTURE_FLAG_BREACH`); the inspector shows "BREACH".
  - `break_in_notice` toasts are accelerators.
- **Code:** `server/rooms/BreakInSubsystem.ts` (channels + grants over injected hooks, ticked with the 10 Hz structure tick), `SectorRoom.onBreakInStart` / `onBreakInEnd`.
- **Locks:**
  - `BreakInSubsystem.test.ts`: success, grant window, interruptions;
  - `tests/integration/sectorRoom/breakIn.test.ts`: undefended, the alarm and BREACH, then the cargo opens and goods are taken; defended, the owner's turret engages the thief and the hit interrupts it;
  - `CargoPanel.test.tsx` and wire parity.

## Part 6 (C3): ship cargo

Ships have cargo you can open too. Select one and use **Open cargo**:
- **Your own parked hulls** open to you, so you can move cargo between your ships.
- **Another player's ship** (active or a parked hull) is locked. Breaking in works like a structure break-in (Part 5): it's a hostile act, the owner gets an alarm (a push if they're offline), and success opens the hold for 60 s. The range check uses the target's LIVE pose, so a ship that flies off ends the break-in.
- **An NPC ship's loot is its hold.** Its loot table is rolled ONCE per spawn (seeded from its id, `npc-hold` stream), on top of anything it already carries (a nexus hoard, a harvester's scoop, a hauler's cargo). What you take from it is gone: its death spills only what's left, never a second roll. Breaking into one turns its side's nearby ships on you.
- **Targets on the wire.** `cargo_query` / `cargo_move` / `break_in` take exactly one of `entityId` (a structure or NPC ship) or `ship` (a playerId for an active ship, or a shipInstanceId for a parked hull). `cargo_state.targetShip` echoes the ship target.
- **Liveness (#17).** A player target is an ACTIVE ship (by playerId) or a LINGERING hull (by shipInstanceId); DEAD ships aren't targets. NPC targets are live swarm drones.
- **Holds.** Player hulls and trade/convoy haulers keep persisted holds. NPC loot holds live in memory only and are dropped when the NPC is evicted.
- **Code:** `SectorRoom.shipTarget` / `shipCargo` / `npcHold` / `onShipBreakInStart`.
- **Locks:** `tests/integration/sectorRoom/shipCargo.test.ts` (a PvP break-in alarms the owner and moves goods between both holds; an NPC ship robbed clean drops no pod) and the wire-parity ship cases.

## Tests

- Part 2: `src/server/cargo/StorageService.test.ts` (uid determinism, atomic
  deposit, network overflow, rejection cases, refine, restore overlay, dirty
  flush, spill), `tests/integration/sectorRoom/storageDeposit.test.ts`
  (deposit → refine → raze spill; repair at your storage spends credits),
  `lingeringAiTargetable.test.ts` (an offline hull is in the AI view; RED with
  the change reverted), the derelict cases in `LootSubsystem.test.ts` +
  `lootLoop.test.ts`, the respec credit cases in `shipUpgradeApply.test.ts`.
- Unit: `src/core/cargo/hold.test.ts` (conservation, capacity, tiers, loot
  rolls), `src/server/cargo/LootSubsystem.test.ts` (pickup group, merge,
  cap, TTL, spill, restore), `src/server/db/holdsGroup.test.ts` (atomic
  group rollback, idempotent upsert), `lootView.test.ts`, `CargoChip.test.tsx`.
- Integration: `tests/integration/sectorRoom/lootLoop.test.ts` (kill → pod,
  fly-over → hold in the own-ship snapshot, death spills and keeps nothing),
  `lingeringDeathDeletesRoster.test.ts` (A1, failing-first).
- Test trigger: the `initialCargo` join option (testMode) seeds a hold.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

### Cargo HUD (Living World P1a-1, plan peppy-jumping-pinwheel)

- The local ship's hold is decoded ONLY from the authoritative own-ship `SnapshotMessage.states[].cargo` slice (`ColyseusClient.applyLocalCargo`, invariant #16). It writes the discrete Zustand `cargo`/`cargoCapacity` ONLY when the contents changed (`net/lootView.ts` `cargoChanged`, field-by-field, alloc-free), so a steady hold costs zero React renders.
- `loot_collected` (zod-validated) only pushes a short-lived popup line (`lootFeed`, capped at 4, `LOOT_FEED_TTL_MS`). Never derive cargo from it.
- `CargoChip` lives in the `top-left` slot at `order={3}` (under the sector chip). Testids: `cargo-chip` (`data-cargo-weight/capacity/fill`), `cargo-breakdown`, `loot-feed-line`. It shows NO credits.

- Loot pods render through the EXISTING scrap path (`parentShipKind 'cargo-pod'`, `componentIndex` = tier colour). There's no separate pod renderer.

### Cargo panel (plan soft-leaping-truffle v3, C1)

- `components/CargoPanel.tsx` (opened by `CargoAction` from the inspector, for any BUILT storage structure) is rebuilt ONLY from `cargo_state` replies (#16). It polls while mounted. The reply carries the structure's hold AND the ship's hold, so the panes never disagree.
- Rows come from the pure `components/cargoRows.ts`: names, never ids (uids ride inside the requests).
- Every client → server message sender must pass its server schema: add a case to `tests/unit/tradeClientWireParity.test.ts` (strict schemas need the `type` the client's `send()` adds; LESSONS 2026-11-01).

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

- **Gate:** `SectorRoom.cargoAccess` opens a structure's cargo only when ALL of these hold. Every `cargo_query` / `cargo_move` re-checks it.
  - `cargoOpensFor(relationOf(…))` passes: own and friendly; neutral and hostile are locked until the C2 break-in.
  - The pilot has a live ship: ACTIVE, alive, with a roster row (#17).
  - The ship is within `CARGO_ACCESS_RANGE` of the footprint edge.
- **Moves:** `StorageService.cargoTake` / `cargoPut`, each ONE hold group with the ship row. Never move items between a ship and a structure any other way.
- **A manual move switches auto-deposit off for that pilot** (`manualCargo`) until they leave deposit range. Without it, a withdrawal from your own storage is banked straight back.
- **`entity_stats` holds** show to anyone the cargo opens for (`ownerGateStats`).
- **Market mode (T4):** an NPC `freight_dock` opens as a market for a non-hostile pilot (`dockMarket`): Take buys, Put sells.
  - **Prices:** the trade sink's `dockQuote`, the same quote as the board.
  - **Clamped** to stock, space, wallet and volume.
  - **Atomic:** one group per good, with the wallet op passed as `extraOps` to `StorageService.marketBuy` / `marketSell`.
  - Never let a market fill skip `recordDockFill`: the galaxy market and volume must see it.
- **Break-ins (C2):** `break_in` / `break_in_cancel` → `BreakInSubsystem` (ticked in `structureTurretTick`).
  - **Starting is a hostile act.** `onBreakInStart` records it in `hostileActs` and alarms the owner, or aggros the NPC side's nearby ships.
  - **Hits cancel it.** `applyDamage` calls `onActorDamaged` for any hit.
  - **A grant opens `cargoAccess`** for 60 s.
  - **Player turrets** also engage pilots hostile to their owner (`nearestHostilePilot`). The scan only runs while `hostileActs.size() > 0`.
- **Ship cargo (C3):** cargo messages target an `entityId` OR a `ship` (playerId of an ACTIVE ship / shipInstanceId of a LINGERING hull). `npcHold` rolls an NPC's loot table ONCE per spawn (seeded, memory-only, merged onto any stash it carries) and `dropKillLoot` spills that same hold, so stolen loot never drops twice. Break-ins tick BEFORE `structureTurretTick`'s no-structures early return (a sector with no structures can still have a ship break-in).
- **Standing orders (T4b):** `set_freight_orders` (owner, built `freight_dock`) → `rec.freightOrders` (persisted). The dock joins convoy planning as a `player` base.
  - **Who trades with whom:** the ConvoyDirector pairs it with NPC bases only.
  - **When money moves:** it prices and clamps the order at planning. The wallet op lands in the SAME group as the goods: a credit at pickup via `extraOpsFor(taken)`, a debit at delivery with the release.
- Lock: `tests/integration/sectorRoom/cargoAccess.test.ts`. Story: [docs/features/loot-and-cargo.md](../features/loot-and-cargo.md) Part 3.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](../architecture/server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Holds, loot pods, cargo (plan peppy-jumping-pinwheel P1a-1, 2026-10-31)**: every unit of value lives in exactly ONE hold (ship / pod / later storage / hauler) in the unified `holds` table, keyed by holder id. **Rules:** (1) value only MOVES (`core/cargo/hold.ts` `transferInto`), never copied; (2) every transfer is ONE atomic `GROUP` op of ABSOLUTE `HOLD_PUT`/`HOLD_DELETE` (SAVEPOINT in BOTH writers via `db/holdsSql.ts`; a failing group rolls back alone — hostile-review A5); `HoldStore` (memory) is the authority; (3) loot pods are scrap-kind swarm entities (`parentShipKind 'cargo-pod'`, `componentIndex` = glow tier) spawned DIRECTLY — never via the `ScrapSpawner` FIFO and never in the sector snapshot (`scrapEntitiesForSnapshot` skips them; A3) — and restored on hydrate from `holds`; (4) `LootCollector` liveness = ACTIVE + alive + roster row (lingering never collects; no roster row ⇒ no pickup, A2); (5) EVERY death seam spills the hold — active `SHIP_DESTROYED`, lingering `LeafDeps.onLingeringHullDeath` (which ALSO fixed A1: a killed lingering hull never deleted its roster row), and both abandon paths; (6) the own active hull's hold rides `states[].cargo` (#16, emit-when-non-empty, shared ref). Per-sector pod cap 64 (merge, never evict value), TTL 15 min, pickup radius 80 u, collect every 6 ticks / sweep ~1 Hz. Test trigger `initialCargo`; the integration harness resets `HoldStore` per boot. Locks: `hold.test.ts`, `LootSubsystem.test.ts`, `holdsGroup.test.ts`, `tests/integration/sectorRoom/{lootLoop,lingeringDeathDeletesRoster}.test.ts`. 🔴 netgate (snapshot slice + kill path). Story: [docs/features/loot-and-cargo.md](loot-and-cargo.md).
- **Base storage, auto-deposit, derelicts, credit sinks (plan peppy-jumping-pinwheel P1a-2, 2026-10-31)**: storage kinds have `StructureKind.holdCapacity` (Capital 5000, Cargo Bay 2000; structure catalogue v8). **Rules:** (1) a structure's `uid` is a DETERMINISTIC hash of (sector, owner, kind, rounded pose) — all persisted — so a restore recomputes it; it keys the structure's `holds` row (entity ids are re-minted on restore, never key on them); (2) `StorageService` = the ONE store of value for storage: player transfers (deposit / refine / credit spend) are ONE atomic group with the ship side; mining/hauling/construction mutate `rec.minerals` directly and are dirty-flushed on the 1 Hz grid pulse (A4); hydrate overlays the holds row AFTER the snapshot restore; (3) auto-deposit = active + roster-row hull, own OPERATIONAL storage (built OR mid-upgrade) within `DEPOSIT_RANGE` 400 for `DEPOSIT_DWELL_TICKS` 120; minerals → a Capital's bank, goods by weight, overflow across the same-owner grid component, leftovers stay aboard; progress rides own-ship `states[].depositing`; (4) any storage leaving the world spills its payload; (5) a storage hold is OWNER-ONLY on `entity_stats` (`ownerGateStats` strips it at send); (6) credit sinks `repair_ship` / respec are paid from the WALLET (economy v2 W1 — superseded the "credits banked in this sector" rule), all-or-nothing, constants in `shared-types/goods.ts` (#15); (7) abandoned hulls become `derelict` pods (salvaged over time, never merge targets, 1 h TTL); (8) **#17 AI targeting liveness**: ACTIVE hulls + DISCONNECTED hulls (session gone) + displaced lingering hulls (`ownerId`) — a CONNECTED inactive hull is a pending join and stays untargetable. Locks: `StorageService.test.ts`, `tests/integration/sectorRoom/{storageDeposit,lingeringAiTargetable,lootLoop}.test.ts`, `bankSeed.ts` test helper. 🔴 netgate (AI view + snapshot slice). Story: [docs/features/loot-and-cargo.md](loot-and-cargo.md) Part 2.

### Server rules in full (moved from src/server/CLAUDE.md)

The zone `CLAUDE.md` keeps a condensed form of these rules; this is the full wording with its lock tests.

**Cargo and storage** ([loot-and-cargo](../../docs/features/loot-and-cargo.md)):
- 🔴 Value only moves (`transferInto`), never copies; every transfer is ONE atomic `GROUP` of absolute `HOLD_PUT` / `HOLD_DELETE`; `HoldStore` is the authority. Every death and abandon seam spills the hold.
- Loot pods are spawned directly (never via the `ScrapSpawner` FIFO, never in the sector snapshot) and restored from `holds`. Only an ACTIVE, alive hull with a roster row collects.
- A structure's hold is keyed by its deterministic `uid`. `StorageService` is the one store of value for storage; a storage hold is owner-only on `entity_stats`; storage leaving the world spills.
- 🔴 AI targets ACTIVE, disconnected and displaced lingering hulls; a connected inactive hull (pending join) is untargetable (#17). `storageDeposit.test.ts`, `lingeringAiTargetable.test.ts`.

#### Cargo access

- **Gate:** `SectorRoom.cargoAccess` (relation, live ACTIVE ship #17, `CARGO_ACCESS_RANGE`) is re-checked on every `cargo_query` / `cargo_move`.
- **Moves:** only via `StorageService.cargoTake` / `cargoPut` / `marketBuy` / `marketSell` (one hold group each, wallet ops as `extraOps`); never let a market fill skip `recordDockFill`. A manual move sets `manualCargo` (auto-deposit off).
- **Break-ins and ship cargo:** starting a break-in is a hostile act and any hit cancels it; an NPC's loot is rolled once per spawn (`npcHold`), so stolen loot never drops twice. Standing-order wallet ops land in the same group as the goods. Lock: `cargoAccess.test.ts`.
- Detail: [loot-and-cargo.md](../../docs/features/loot-and-cargo.md#server-implementation-notes).

