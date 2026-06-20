# Leveling & Upgrades

Equinox Phase 4, plan `effervescent-umbrella`. This document tells the story of
ship leveling: how a ship earns XP, how XP becomes levels, where the level lives
on the wire and the screen, and why progression is destroyed with the ship.

WS-B1 (this document's scope at first writing) ships the **XP core**:
per-instance attribution, the curve, level-up, and the public badge. WS-B2 (stat
upgrades / free allocation) and WS-B3 (dynamic weapon mounts via latent slots)
build on the roster columns + the level seeded here. WS-B4 covers structure
leveling, documented in `structures-and-power-grid.md`.

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

## Future (WS-B2 / WS-B3)

- **WS-B2** spends the `level`-granted points across a stat pool (free allocation
  + respec) via the per-instance `stat_alloc` roster column; multipliers read at
  the one `applyShipInput` clamp seam, identically server + client.
- **WS-B3** activates latent mount slots and binds weapons, persisted in the
  per-instance `mounts` roster column; geometry looked up client-side by
  `(shipKind, slotId)` (no new geometry wire).
