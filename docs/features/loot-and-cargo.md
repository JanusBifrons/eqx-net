# Loot & Cargo

Plan: `peppy-jumping-pinwheel` (Living World: Allegiances, Loot & Trade).
Part 1 (P1a-1): loot pods, fly-over pickup, carrying cargo, losing it on death.
Part 2 (P1a-2) adds base storage, auto-deposit, derelicts and credit sinks.

## What the player sees

- **Every kill drops loot.** A destroyed NPC ship leaves a small glowing
  diamond, a *loot pod*, where it died. AI-vs-AI kills drop loot too, so a
  battlefield you stumble onto is worth picking over.
- **Fly over a pod to collect it.** No button: touching a pod with free cargo
  space moves its contents into your ship's hold. A popup confirms what you
  got ("+7 Salvage · +30 cr").
- **Your hold is on your ship.** The top-left chip shows weight / capacity,
  credits and blueprints (`▣ 340/500  ¢1,250  ★1`). It turns amber at 80 %
  and red when full; tap it for a per-good breakdown. A full hold still
  picks up credits and blueprints (they weigh nothing); the rest stays in the
  pod.
- **Hardcore.** If your ship dies, everything it carries spills as a bright
  magenta pod where it died, free for anyone to grab. The dead ship keeps
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

A dead player's spilled cargo glows bright magenta. Cargo capacity is derived
from the ship's toughness (`maxHealth × 2`), so heavier hulls haul more.

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

## Tests

- Unit: `src/core/cargo/hold.test.ts` (conservation, capacity, tiers, loot
  rolls), `src/server/cargo/LootSubsystem.test.ts` (pickup group, merge,
  cap, TTL, spill, restore), `src/server/db/holdsGroup.test.ts` (atomic
  group rollback, idempotent upsert), `lootView.test.ts`, `CargoChip.test.tsx`.
- Integration: `tests/integration/sectorRoom/lootLoop.test.ts` (kill → pod,
  fly-over → hold in the own-ship snapshot, death spills and keeps nothing),
  `lingeringDeathDeletesRoster.test.ts` (A1, failing-first).
- Test trigger: the `initialCargo` join option (testMode) seeds a hold.
