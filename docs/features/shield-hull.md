# Shield + Hull (player-facing)

Every ship — player **and** AI drone — now has two survivability layers.

## The model

- **Shield** wraps the whole hull and absorbs incoming damage. The shield
  regenerates; the hull does not.
- **No-spillover rule:** the *last* hit before a shield drops is **fully
  absorbed**. A 1-HP shield eats an arbitrarily large single shot and is
  then 0 — the overkill is lost, the hull is untouched. So a shield is
  always worth *something*: it guarantees you survive one more hit.
- Once the shield is **0**, damage goes to the **hull**. Hull works exactly
  as health always did (it persists across sessions; it never heals). At
  hull 0 the ship explodes.
- **Halo regen:** after ~5 s with **no damage of any kind** (shield *or*
  hull), the shield refills over ~2 s. Any hit — even one the hull takes —
  resets the 5 s timer. Per-ship-kind tunable (`shieldMax`,
  `shieldRegenDelayTicks`, `shieldRegenRate` in the ship catalogue).

## Collision changes

While the shield is **up**, a ship collides as a cheap **circle** (exactly
as before — most combat is unchanged and just as fast). The instant the
shield drops, the ship collides as its **exact rendered hull polygon**:
shots that would clip the circle but miss the actual silhouette (the
notched tail of a scout/fighter/interceptor, the corners) now **miss**.
Killing a shielded ship still means landing real hits; finishing a
shield-down ship means hitting the *hull you can see*.

This applies to weapons (hitscan + projectiles) **and** physical ramming.
Ramming now deals damage: a hard collision chips shield then hull on both
ships; asteroids deal ramming damage but take none. How much depends on how
hard the hit really is (2026-11-13): a head-on ram at full speed takes a big
chunk off both ships (two fighters each lose their whole shield), a glancing
scrape barely scratches, a slow bump is free, and the lighter ship always
takes more (a fighter into a capital takes nearly all of it). See
[collision-layers.md](../architecture/collision-layers.md) for the formula. Drones are 1:1 with
players — same shield, hull, regen, no-spillover, and exact-hull collision
when their shield is down.

## HUD

A small top-left two-bar readout: **SHLD** (cyan) over **HULL**
(green → amber → red). It eases between values; the shield bar climbs
smoothly as it regenerates. Intentionally minimal for now — it will grow.

Per-kind starting values (shield ≈ hull at launch; balance-pass tunable):
fighter 100/100, scout 60/60, heavy 180/180, interceptor 80/80,
gunship 140/140.

See [docs/architecture/collision-layers.md](../architecture/collision-layers.md)
for the engine internals.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Shield/Hull + ramming (2026-05-16)

- Two-layer survivability for all ships. `applyDamage` routes
  active/lingering/drone through `ShieldHull.applyLayeredDamage`
  (no-spillover: the final pre-drop hit is fully absorbed). Per-update
  `tickShieldRegen` (cheap full-shield skip, no per-tick alloc). On the
  shield 0-cross/restore: `SET_HULL_EXPOSED` worker post + bus
  `SHIELD_BROKEN`/`SHIELD_RESTORED` + `shield_broken`/`shield_restored`
  serverLogEvent diagnostics.
- Shield value reaches clients on DISCRETE events only: `DamageEvent`
  (`newShield/shieldMax/hullMax/hitLayer`) per hit + `ShieldEventMessage`
  (`restored`/`regen_complete`). The regen ramp is NEVER streamed (no
  Colyseus schema field; `ShipState.shield` is a plain non-@type field).
- Drones: `SWARM_RECORD_FLAG_SHIELD_DOWN = 1<<1` (spare recordFlags bit
  — NO stride change, NO `SWARM_WIRE_VERSION` bump) + `drones[].shieldDown`
  on the snapshot. `SwarmEntityRecord.shieldDown` maintained event-driven.
- Ramming (`src/core/combat/Ramming.ts`): CONTACT_BATCH aggregated per
  unordered {aId,bId} per tick BEFORE floor/damage/broadcast (a
  shield-down hull is N triangle colliders → N sub-events). **Impact-based
  model (owner decision 2026-11-13, "ramming as a weapon"; replaced the
  2026-06-12 WS-1/R2.31 mass-differential model):** damage comes from the
  closing speed ALONG THE CONTACT NORMAL (`Contact.normalSpeed`), as the
  reduced-mass impact energy `½·μ·(vN − floor)²` × `RAM_DAMAGE_PER_ENERGY`,
  shared by weight (`mOther/(mSelf+mOther)`), capped at `RAM_DAMAGE_MAX` per
  side. Head-on hurts, a glancing scrape barely does, equal ships are both
  hurt, the lighter more (the per-side `RamPair.damageA`/`damageB` are applied
  independently in `onContactBatch`; `ram_damage` logs `normalSpeed`).
  Behaviour change: allied ships (e.g. squadmates) that collide hard now damage
  each other, with the other id as the "shooter". Masses are the folded Rapier body masses threaded via
  `Contact.aMass`/`bMass` (`World.getBodyMass`); asteroids still deal but don't
  take (no `swarmHealth`). **P3.3 (2026-06-13): damage is `Math.round`ed BEFORE
  the emit guard in `onContactBatch`** — a sub-0.5 collision emits NO `ram_damage`
  / no DamageEvent (so no client sparks + no "0" damage number; "sparks and
  damage still show… it just now shows 0s"). The applied damage now matches the
  client's displayed integer. Lock: `ramming.test.ts` (a low-speed fractional
  collision fires `collision_resolved` but no `ram_damage`). 🔴 netgate
  (contact→damage live-loop).
- `feel-test-lockstep.spec.ts` is host-load sensitive — confirm on a
  quiet host/CI (it fails on pre-shield HEAD too in a loaded session;
  see docs/LESSONS.md 2026-05-16). Catalogue version bumped 1→2.
