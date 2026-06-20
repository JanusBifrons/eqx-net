# Leveling & Upgrades

Equinox Phase 4, plan `effervescent-umbrella`. This document tells the story of
ship leveling: how a ship earns XP, how XP becomes levels, where the level lives
on the wire and the screen, and why progression is destroyed with the ship.

WS-B1 (this document's scope at first writing) ships the **XP core**:
per-instance attribution, the curve, level-up, and the public badge. WS-B2 (stat
upgrades / free allocation) and WS-B3 (dynamic weapon mounts via latent slots)
build on the roster columns + the level seeded here. WS-B4 (structure leveling)
is documented in full in the "WS-B4 — structure leveling" section below, with the
grid-pulse build-phase mechanics cross-referenced from
[structures-and-power-grid.md](structures-and-power-grid.md).

## Locked design decisions (from the Phase-4 Q&A)

- **D8 — XP is per ship INSTANCE.** A veteran ship is genuinely stronger;
  switching ships switches your progression. There is no player-wide XP pool.
- **D9 — destroying a leveled ship WIPES it.** Level / XP / upgrades / mounts are
  lost — the hull becomes scrap and leaves the roster. High stakes; matches the
  existing destruction model. No "rebuild at level" mechanic.
- **D10 — capped, escalating curve** (~10 levels; each level costs more; tougher
  enemies award more XP than scouts).
- **D13 — ship level is PUBLIC** — a small badge renders on the ship (visible to
  all) and on the roster card.

## The curve (zone-pure)

`src/core/leveling/shipXp.ts` is blind, pure, and the single source of the curve
numbers. Three functions:

| Function | Meaning |
|---|---|
| `xpForKill(victimMaxHealth)` | XP a kill is worth: `round(maxHealth / XP_PER_KILL_DIVISOR)`, floored at 1. Linear in the victim's hull cap, so a gunship/capital (high `maxHealth`) is worth proportionally more than a scout (D10). |
| `xpToNext(level)` | XP to advance FROM `level` to `level + 1`: `round(XP_CURVE_BASE · level^1.5)` (escalating, D10). Returns `Infinity` at and beyond `LEVEL_CAP` so the apply loop terminates cleanly. |
| `applyKillXp(level, xp, gained)` | Folds an award into `(level, xp)`. Crosses thresholds one-at-a-time (a single kill never double-counts a level; a fat award can cross several), carries the remainder, and pins `xp` to 0 at `LEVEL_CAP`. |

Tunables (`XP_PER_KILL_DIVISOR`, `XP_CURVE_BASE`, `LEVEL_CAP`) are exported
balance knobs — adjust them on-device; the architecture doesn't change when they
move. Locked by `shipXp.test.ts`.

## Attribution — keyed by the KILLER ship instance

XP is awarded to the **killer ship instance**, never a player pool (D8). The
attribution funnels through one server method, `SectorRoom.awardKillXp(killerId,
victimMaxHealth)`, called from **two seams**:

1. **Drone kills** (the primary XP source) — `auditCombatDestruction`'s drone
   branch, weighted by `getDroneMaxHealth(rec.shipKind)`. A drone death rides the
   swarm death policy → `evictSwarmEntity({ emitDestroyed: true, shooterId })` →
   `auditCombatDestruction`, where the shooter id is in hand.
2. **PvP hull kills** — the `SHIP_DESTROYED` bus handler, weighted by
   `getShipKind(victim.kind).maxHealth`. Run BEFORE the roster wipe (D9) so the
   victim's kind is still resolvable.

`awardKillXp` resolves `killerPlayerId → resolveActiveShipKey(killerId) →
shipInstanceId → roster row`. **Only PLAYER killers earn XP**
(`classifyAttacker(killerId) === 'player'`); a drone/structure/bot killer has no
roster ship instance, so it's skipped. On a kill it:

- `applyKillXp` the curve over the roster's `(level, xp)`,
- `PlayerShipStore.setProgress(shipId, { level, xp })` to persist,
- writes `ShipState.level` (the live mirror) so the next snapshot ships the
  public badge,
- on a threshold cross only: emits `SHIP_LEVEL_UP { shipInstanceId, newLevel }`
  on the bus and broadcasts a `ship_level_up` Colyseus message to all clients.

## The public level on the wire (D13)

Level is public, so it rides `SnapshotMessage.states[].level`, emit-when > 1
(`SnapshotBroadcaster`). An un-levelled sector pays **zero extra bytes** (notepack
skips `undefined`); the client treats an absent value as level 1. This is the
same slim-JSON discipline as `energy` / `shieldDown` / `mountAngles` — there is
**no `SWARM_WIRE_VERSION` bump** (the binary swarm core is untouched; `level`
rides player `ShipState`).

`ShipState.level` is a PLAIN instance field (NOT `@type`-decorated) — like shield
and energy, it reaches clients via the per-recipient snapshot slice, never the
Colyseus diff. It is seeded from the roster row on join, so a previously-levelled
ship shows its badge from the first snapshot.

## The public level on the screen

- **In-world badge** — the client mirrors `states[].level` (and lingering-hull
  level) onto each ship's `mirror.ships[id].level` via `applyShipLevels`
  (`snapshotRemoteSync.ts`); the renderer reads it. The reusable `<LevelBadge>`
  React component (`src/client/components/LevelBadge.tsx`) is the one place the
  badge's look lives; it renders nothing for level ≤ 1.
- **Roster card** — `ShipRosterCard` (the single roster-row component) shows
  `<LevelBadge>` in BOTH the compact and full variants, fed by the
  `/dev/player-ships` roster's new `level` field.
- **Screenspace level-up icon** — on the OWNER's own `ship_level_up`, the client
  pushes a pooled one-frame trigger (`mirror.pendingLevelUps`) that the renderer
  drains into the pooled `LevelUpIconManager` — a floating "LEVEL N" icon over
  the ship, recycle-not-destroy (invariant #14, mirrors `DamageNumberManager`).
  The trigger is cleared in `consumeOneFrameTriggers` (same skip-frame discipline
  as `explodingShips`). A discrete Zustand `pendingLevelUp` scalar is the seam
  WS-B2's upgrade modal reads to open on level-up.

## Destroyed → wipe (D9)

When a hull dies, the existing `SHIP_DESTROYED` handler calls
`deleteRosterRow(victim.shipInstanceId)`, which drops the **whole roster row** —
`level`, `xp`, `statAlloc`, and `mounts` all go atomically. A destroyed ship's
progression is gone; there is no orphaned persistence row. The XP-award for the
killer runs first (a different instance), so the ordering is safe. Locked by
`tests/integration/sectorRoom/shipXpAttribution.test.ts` (the D9 case).

## Regression locks

| Concern | Test |
|---|---|
| Curve (kill weight, escalation, cap, one-level-per-threshold) | `src/core/leveling/shipXp.test.ts` |
| Per-instance persistence (`setProgress`, two ships separate) | `src/server/playerShips/PlayerShipStore.test.ts` |
| Full kill→XP-to-firing-instance, per-ship separation, level-up fires once, D9 wipe | `tests/integration/sectorRoom/shipXpAttribution.test.ts` |
| `ship_level_up` wire schema + assignability | `src/shared-types/messages.test.ts` |
| `states[].level` → mirror (emit-when > 1, clear stale) | `src/client/net/snapshotRemoteSync.shipLevels.test.ts` |
| `<LevelBadge>` + roster-card badge | `LevelBadge.test.tsx`, `ShipRosterCard.test.tsx` |
| Pooled level-up icon (no per-frame alloc, recycle) | `src/client/render/LevelUpIcons.test.ts` |
| One-frame trigger clear discipline | `src/client/render/perFrameTriggers.test.ts` |

## Netgate

The kill + snapshot path is live-loop, so `pnpm e2e:netgate` is required at track
integration (the `level` field is emit-when > 1 and rides the same snapshot the
gate already measures — characterise, don't widen margins). Deferred to the
human gate.

## Stat upgrades — free allocation + respec (WS-B2)

WS-B2 spends the `level`-granted points across a stat pool, FREELY (re-distribute
any way within the budget), with a respec that refunds everything.

### The stat pool (pure, zone-blind)

`src/core/leveling/shipStats.ts` is the single source of truth for the pool +
the multipliers. `STAT_IDS` (append-only order): `hull`, `energy`, `damage`,
`topSpeed`, `turnRate`, `shield`. Each spent point multiplies that stat's base by
an extra `STAT_POINT_FRAC` (5 %/point — a balance knob), so N points ⇒
`1 + N·STAT_POINT_FRAC`. `pointBudget(level) = level - 1` (one point per level).

| Function | Meaning |
|---|---|
| `pointBudget(level)` | Available points: `level - 1` (≥ 0). |
| `isAllocValid(alloc, level)` | The SERVER's authoritative gate: every key a known stat id, every value a non-negative integer, total ≤ budget. The budget CANNOT be exceeded. |
| `deriveStatMultipliers(alloc)` | `StatAlloc → ShipStatMultipliers` (`maxHull`/`energy`/`damage`/`topSpeed`/`turnRate`/`shield`). Empty / undefined ⇒ every factor 1 (byte-identical to an un-upgraded ship). |

### Prediction integrity — the ONE seam (risk #1)

The canonical failure mode is prediction drift from the physics multipliers. The
PHYSICS pair — `topSpeed` (scales `thrustImpulse` + the `maxSpeed` clamp so the
ship can reach the raised cap) and `turnRate` (scales `maxAngvel`) — is applied
at **exactly one seam**: `applyShipInput(body, kind, input, mul?)`
(`src/core/physics/applyShipInput.ts`). `World.applyInput` reads the
per-instance `mul` off the body record (`World.setStatMultipliers(id, mul)`).
BOTH sides drive that one seam:

- **Server worker** — `SectorRoom.applyStatMulToWorker(bodyKey, statAlloc)` posts
  the `SET_STAT_MUL { id, topSpeed, turnRate }` worker command (on spawn /
  restore / reclaim / upgrade) → the worker calls `World.setStatMultipliers`.
- **Client predWorld** — `ColyseusClient.applyLocalStatAlloc` re-anchors
  `predWorld.setStatMultipliers(localId, mul)` off the authoritative own-ship
  `statAlloc` snapshot slice, deriving the SAME multipliers via the SAME
  `deriveStatMultipliers`.

So the client never PREDICTS the upgrade — it reads the server's truth off the
snapshot. The non-physics factors (`maxHull`/`energy`/`damage`/`shield`) are
server-authoritative (applied in the damage/shield/energy calcs — NOT in
`applyShipInput`, so they are NOT physics-clamped and need NO prediction
mirror; the client reads the results off the authoritative `DamageEvent` /
snapshot), riding the same per-instance `StatAlloc`.

Locked by `applyShipInput.levelMultiplier.test.ts` (two independent
`PhysicsWorld`s stepped with the same allocation reach byte-identical velocity /
turn; an upgraded ship is genuinely faster; an empty alloc is byte-identical to
the legacy no-`mul` path).

#### The non-physics four — wiring (review must-fix #1, 2026-06-20)

> **History:** `deriveStatMultipliers` always returned all six factors, but for
> the first build of WS-B2 **only `topSpeed`/`turnRate` were ever consumed** —
> `SectorRoom.applyStatMulToWorker` forwarded just those two to the worker, and a
> repo-wide grep found `maxHull`/`energy`/`damage`/`shield` read NOWHERE. So
> spending points on 4 of the 6 stats was a **silent no-op** (a trap the player
> could not see), and typecheck + unit tests did not catch it (the factors WERE
> computed — just never read). The fix below wires them in; the docs/comments
> that claimed they were "applied" now describe the now-true behaviour.

The four non-physics factors are applied through **three pure cap helpers**
(`src/core/leveling/shipStats.ts`, the ship analogue of
`effectiveStructureMaxHealth`) plus `mul.damage` in the fire path:

- `effectiveShipMaxHealth(baseMaxHealth, alloc)` = `round(base × mul.maxHull)`.
  The ONE source for `ship.maxHealth`, applied at every player-hull seed site:
  the **active-spawn** seed (this ALSO fixes a latent bug — that path never set
  `ship.maxHealth`, leaving it at the `500` schema default; it now seeds
  `kind.maxHealth × mul`, and a fresh spawn fills hull to the upgraded max), the
  **lingering-hull reconstruction**, and the **in-sector reclaim**. The hull bar
  divides by `ship.maxHealth` (the `DamageEvent.hullMax`), so the denominator
  always matches the seed.
- `effectiveShipShieldMax(baseShieldMax, alloc)` = `round(base × mul.shield)`.
  Read by `ShieldHullRouter.damageShipLayered` (the `DamageEvent.shieldMax`),
  `tickShieldRegen` (the regen cap + the 0-cross / regen-complete broadcasts —
  `regenStep` gained an optional `shieldMaxOverride`), the spawn/reconstruct/
  reclaim seeds, and the `entity_stats` inspector denominator.
- `effectiveShipEnergyMax(baseEnergyMax, alloc)` = `round(base × mul.energy)`.
  Read by the spawn seed + the `tickEnergy` regen cap.
- `mul.damage` scales **OUTGOING PLAYER weapon damage** in `PlayerFireResolver`
  (the `_damageMul` set once per `resolve()` from `ship.statAlloc`, applied to
  the hitscan base damage BEFORE range falloff, and to the projectile + missile
  spawn damage). **Player ships ONLY** — the drone `AiFireResolver` and
  structure/turret damage are deliberately untouched (only player ships level).

**Live upgrade / respec clamp.** `applyShipUpgrade`, when the edited instance is
the player's ACTIVE hull, recomputes `ship.maxHealth` / shield-max / energy-max
from the new alloc and **clamps the current hull/shield/energy DOWN to the new
max** (a respec that lowers a cap must not leave current above it) — **no free
heal** (clamp only; the bar shrinks, it never refills).

Locked (RED-then-GREEN): `PlayerFireResolver.damageMul.test.ts` (an upgraded
shooter's projectile damage was stuck at the catalogue base on the pre-fix code),
`tests/integration/sectorRoom/shipStatUpgradeEffects.test.ts` (the live
hull/shield caps the client reads off the `DamageEvent` were stuck at the `500`
schema default + base shield; plus the respec clamp), and the `effectiveShip*`
unit cases in `shipStats.test.ts`.

### Messages + persistence

- `apply_ship_upgrade { shipId, alloc }` / `respec_ship { shipId }` (client →
  server, strict zod). `SectorRoom.applyShipUpgrade` validates ownership (the
  roster row's `playerId`) + the budget (`isAllocValid`), persists via
  `PlayerShipStore.setProgress(shipId, { statAlloc })` (per-instance, D8),
  mirrors `ShipState.statAlloc` + re-pushes the worker multipliers when the
  instance is the player's ACTIVE hull, and echoes
  `ship_upgrade_applied { shipInstanceId, alloc, spent, budget }` to the owner.
  A foreign / over-budget / unknown request is a silent no-op.
- The per-instance `statAlloc` lives in the roster `stat_alloc` JSON column
  (WS-0). The OWN-ship snapshot slice carries `states[].statAlloc` (own-active
  only, when non-empty — the client physics re-anchor); no `SWARM_WIRE_VERSION`
  bump (a slim JSON field, like `energy`/`level`).

### The modal

`UpgradeModal` (MUI `Dialog`, `keepMounted`, cloned from `ShipDetailModal`) +
`UpgradeModalHost` (opens on the local ship's level-up via the WS-B1
`pendingLevelUp` seam, closes on the `upgradeAck` echo). The draft math is pure
(`upgradeModalDraft.ts`) — budget-clamped spend/refund, canonical zero-stripped
alloc.

### Regression locks (WS-B2)

| Concern | Test |
|---|---|
| Stat pool curve (budget, validation gate, derivation) | `src/core/leveling/shipStats.test.ts` |
| Server==client physics multiplier (no drift) + upgrade is real | `src/core/physics/applyShipInput.levelMultiplier.test.ts` |
| Wire schemas (apply/respec/echo, S5 bounds, strict) | `src/shared-types/messages.test.ts` |
| `setProgress(statAlloc)` per-instance persistence + respec | `src/server/playerShips/PlayerShipStore.test.ts` |
| Full apply→budget→respec→foreign-drop server chain | `tests/integration/sectorRoom/shipUpgradeApply.test.ts` |
| Client re-anchor guard | `src/client/net/localStatAlloc.test.ts` |
| Modal draft logic + React wiring | `upgradeModalDraft.test.ts`, `UpgradeModal.test.tsx` |

### Netgate

The physics multipliers touch client prediction (the snapshot reconcile path), so
`pnpm e2e:netgate` is required — deferred to the human gate.

## WS-B3 — dynamic weapon mounts (latent slots) — SHIPPED

- **WS-B3** activates latent mount slots and binds weapons, persisted in the
  per-instance `mounts` roster column; geometry looked up client-side by
  `(shipKind, slotId)` (no new geometry wire — the scrap-collider trick). A
  ship-level upgrade `activate_mount { shipId, slotId, weaponId }` activates the
  next latent hardpoint; the activated `{ slotId, weaponId }` rides the PUBLIC
  `SnapshotMessage.states[].mounts` slice (emit-when-non-empty, no
  `SWARM_WIRE_VERSION` bump). The catalogue `ShipKind.latentMounts` declares the
  candidate hardpoints (record-shape add → `SHIP_KIND_CATALOGUE_VERSION` 11→12).
  **The full architecture (the three pure resolvers, the lockstep aim/fire seam,
  the renderer + UI) lives in [docs/architecture/weapon-mounts.md](weapon-mounts.md)
  "Dynamic weapon mounts — latent slots".**

## WS-B4 — structure leveling (paid Upgrade + visible build phase) — SHIPPED

Structures level via a PAID Upgrade that runs a **visible build phase** — the
same construction-pulse machinery the initial build uses (D14). It's the
structure analogue of ship XP, but **player-economy-driven, not kill-driven**:
there is no structure XP, only a resource cost.

### The pure curve (zone-blind)

`src/core/leveling/structureLevel.ts` is the single source of truth, mirroring
`shipStats.ts`:

- `STRUCTURE_LEVEL_CAP = 5` — `canUpgradeStructure(level)` is false at the cap
  (the client hides the Upgrade affordance; the server drops the request).
- `structureUpgradeCost(baseConstructionCost, level)` = `base · (1 + level·FRAC)`
  rounded — escalating per level (`STRUCTURE_UPGRADE_COST_FRAC = 1.0`). 0 at the cap.
- `structureLevelMultipliers(level)` / `structureLevelFactor(level)` = a single
  scalar `1 + (level-1)·STRUCTURE_LEVEL_FRAC` (`0.25`) applied to the kind's KEY
  stats: **maxHealth** (universal), **weaponRange + weaponDamage** (turrets),
  **powerOutput** (generators). (Storage is a documented future grant — its read
  sites span the mineral economy; deferred to keep WS-B4 surgical.) Level 1 is the
  identity (byte-identical to pre-WS-B4). All are **balance knobs** — tune on-device.
- `effectiveStructureMaxHealth(baseMaxHealth, level)` — the ONE helper both the
  HP seed on (re)build AND the snapshot `hpPct` denominator read, so a leveled
  structure's bar is consistent (a full-HP leveled structure reads 100 %).

### The upgrade build phase (server)

`StructureGridSubsystem.upgradeStructure(id)` (owner-gated by the CALLER, like
`reconnect`/`clearConnections`) validates BUILT + not-deconstructing + below-cap +
not-already-upgrading, then **reuses the construction machinery**: flips
`isConstructed=false`, resets `constructionProgress=0`, sets `constructionCost`
to the upgrade cost, and stashes `upgradeTargetLevel = level+1` on the
`StructureRecord`. The cost is NOT pre-charged — it's **drained DURING the build
by the grid pulse** (`processConstruction`), exactly like a fresh blueprint, so an
upgrade started against an empty bank simply waits for minerals. On the build's
completion `processConstruction` increments `level` to `upgradeTargetLevel`,
clears it, restores `constructionCost` to the kind base (so a SUBSEQUENT upgrade
re-derives cleanly), and seeds HP to the LEVELED effective max. The leveled
turret range/damage (`tickTurrets`) + power output (`structureToGridNode`) read
the level factor at their catalogue read-sites.

### The wire + the UI

- `level` rides the `StructureRecord` → persists in the sector snapshot
  (`SectorSnapshotStructure.level`, WS-0; `restoreStructuresFromSnapshot` restores
  it) → rides the live `SnapshotMessage.structures[].level` wire slice (emit-when
  `> 1`, the same slim-JSON discipline as `states[].level`; absent ⇒ level 1; **no
  `SWARM_WIRE_VERSION` bump**) → `StructureRenderState.level` on the client mirror.
- `EntityStatsPanel` shows a `LVL n` line (`data-testid="entity-stats-level"`,
  level > 1 only) + a 4th **Upgrade** action button
  (`data-testid="structure-action-upgrade"`) in the owned-structure action row,
  gated OWNED + BUILT + below-cap (`canUpgradeStructure`). It sends
  `upgrade_structure { entityId }` via `structureActionsClient.sendUpgradeStructure`.
- Message `upgrade_structure { entityId }` (strict zod, `clientMessages.ts`) →
  `SectorRoom` resolves the swarm entityId → registry record → OWNER-gate →
  `structureGrid.upgradeStructure`.

### Regression locks (WS-B4)

- `structureLevel.test.ts` — the curve (clamp / cap gate / escalating cost /
  multipliers / effective HP).
- `messages.test.ts` "Structure leveling message" — `UpgradeStructureSchema`.
- `EntityStatsPanel.test.tsx` — the LVL line (shown > 1, hidden at level 1), the
  Upgrade action gating (owned + built + below-cap; hidden under-construction /
  foreign / at-cap), and the `upgrade_structure` send on click.
- `tests/integration/sectorRoom/structureUpgrade.test.ts` — the real
  `upgrade_structure` message end-to-end on a player-owned scenario grid: charges
  resources (Capital bank drains), the build phase runs via the deterministic
  pulse, level increments 1→2, the effective max HP rises; plus the foreign-owner
  silent no-op.

### Netgate (WS-B4)

The structures `level` rides the 20 Hz snapshot, so **`pnpm e2e:netgate` is
required** (invariant #8) — deferred to the human gate. (The wire change is a
slim emit-when-`>1` JSON field; characterise, don't widen margins.)
