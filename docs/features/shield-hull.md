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
ships; asteroids deal ramming damage but take none. Drones are 1:1 with
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
