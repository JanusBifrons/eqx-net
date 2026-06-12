# ADR — Asteroid interaction model (Equinox Round 2 front-gate)

**Status:** ACCEPTED (user sign-off 2026-06-12). Unblocks **WS-4** (mining-laser entity, R2.27/R2.16) and **WS-2's asteroid half** (R2.22 symptom 2: missiles pass through asteroids).

**Date:** 2026-06-12

## Context — what asteroids ARE today (grounded in the code)

Two Round-2 bugs hinge on one un-stated decision: *what is an asteroid — a destructible target, indestructible-but-mineable rock, or a pass-through?* The current code already answers most of it, just inconsistently:

| Weapon / system | Current behaviour | File |
|---|---|---|
| **HP / damage** | Asteroids (swarm `kind === 0`) are **non-damageable** — `EntityResolver.resolve` returns `null`, so `applyDamage` is a safe no-op. | `EntityResolver.ts:156-167` |
| **Bolts (projectiles)** | **Collide** (sphere) + despawn on contact; 0 HP damage (immune). | `ProjectilePipeline.ts:179` |
| **Beams (hitscan)** | **Terminate** at the asteroid (exact convex-polygon ray test); 0 HP damage. | `PlayerFireResolver.ts:386` |
| **Missiles** | **PASS THROUGH** — `lockOnTarget` + `sweepCollision` skip `kind === 0` entirely. ← the inconsistency / R2.22 bug | `MissileSimulation.ts:544,640` |
| **Mining** | Invisible **grid-pulse drain**: a built+powered Miner within `miningRange` of the nearest asteroid extracts a flat `miningRate` per ~1 Hz pulse into its `minerals`. No beam entity, no asteroid resource pool (effectively infinite). | `StructureGridSubsystem.ts:302-316` |
| **Resources** | Asteroids have **no `resources` / mass field** anywhere. | (none) |

So bolts + beams already treat an asteroid as **solid, indestructible rock**; only missiles disagree, and mining is invisible. The "fly into a capital / through a rock" feel and R2.22/R2.27/R2.16/R2.23 all point at the same coherent model.

## Decision

**Asteroids are SOLID, INDESTRUCTIBLE, MINEABLE rock.** Concretely:

1. **HP-immune (indestructible).** Asteroids are never destroyed by combat. `EntityResolver` keeps returning `null` for `kind === 0` — combat damage stays a no-op. **No destruction economy** (no asteroid HP, debris, fracture, or respawn) — explicitly out of scope for Round 2.
2. **Physically solid to ALL weapons.** Every weapon interacts with the rock physically and deals **0 HP**:
   - Bolts collide + despawn (unchanged).
   - Beams terminate at the surface (unchanged).
   - **Missiles detonate-on-contact + despawn** (the WS-2b change: remove the `kind === 0` skip in `sweepCollision`). A 0-HP detonation on indestructible rock is **correct** — the bug was the *pass-through*, not the zero damage. The missile shows its impact VFX and despawns instead of flying through; this also resolves R2.22 symptom 4 ("indicator flashes but missile continues") for the asteroid case.
   - Missiles do **not** lock onto asteroids (`lockOnTarget` keeps the `kind === 0` skip — you don't home on rock; you just can't fly through it).
3. **Mineable via a real beam entity (WS-4).** The Miner's extraction becomes a **visible, aimable, colliding mining beam** (R2.27): it draws a beam to its target asteroid, and a player who flies into that beam takes **light** damage (a real hazard, distinct from the indestructible rock). Mining is the **only** thing that depletes an asteroid — and it depletes a **resource pool, never HP**.
4. **Finite resource pool + selectable (RECOMMENDED — see open question Q1).** Add an optional `resources` (and `mass`) field to the asteroid so mining draws it down and the inspector can show it (R2.23 "select asteroids — mass/resources"). An **exhausted** asteroid simply stops yielding and **remains a solid obstacle** (it is NOT destroyed/despawned — that would reintroduce a destruction/respawn economy).

### Why not the alternatives

- **Fully damageable (HP + destructible).** Rejected for Round 2: introduces a destruction economy (HP pool, fracture/debris, respawn, mineral drops on death) far beyond the reported bugs, and contradicts the "solid cover" role asteroids already play. Revisit as its own feature if desired.
- **Pass-through (status quo for missiles).** Rejected: it *is* the R2.22 bug, and it's inconsistent with bolts/beams which already collide.

## Implementation implications (for WS-4 + WS-2b sub-plans)

- **WS-2b (asteroid half of R2.22):** remove ONLY the `sweepCollision` `kind === 0` skip (`MissileSimulation.ts:640`); keep the `lockOnTarget` skip (`:544`). On an asteroid sweep-hit, `detonate(... cause:'sweep')` runs and `releaseAtPos` despawns the missile; `applyDamage` on the asteroid id is the existing no-op (0 HP). Failing-first lock: a missile fired at an asteroid **despawns** (size→0 via detonate, not via lifetime expiry) and does NOT pass through. Netgate (missile sweep is live-loop).
- **WS-4 (mining beam, DEEP — its own sub-plan):**
  - New mining weapon def in `src/core/combat/` (a beam variant) OR a dedicated mining-beam path off the Miner structure; it is **server-authoritative** like all combat.
  - The Miner draws a beam to `findNearestAsteroid`'s target; a player intersecting the beam takes light damage (a new "mining beam hits a player" path — small, throttled).
  - Mining extraction reads/decrements the asteroid's `resources` (if Q1 = finite) instead of the flat `miningRate` (or keeps `miningRate` as the per-pulse *rate*, capped by remaining `resources`).
  - Client: render the mining beam (reuse `BeamSpritePool`/laser render) + a **mining-range indicator** ring on the Miner (R2.16).
  - `shared-types`: append the asteroid `resources`/`mass` fields; surface them on the `structures[]`/swarm selection slice for the inspector (R2.23). **Append-only** — no `SWARM_WIRE_VERSION` bump if it rides the JSON slice (the pose stays on the binary channel).
- **Selection (R2.23, lands in WS-9 but depends on this):** `pickEntity` starts returning asteroids; the inspector shows `mass` + `resources` (remaining). This ADR makes those fields exist.

## Resolved decisions (user sign-off 2026-06-12)

1. **Finite resources.** Asteroids get a `resources` pool that mining draws down; an exhausted asteroid **stops yielding but stays a solid obstacle** (NOT destroyed/despawned — no respawn economy). The inspector shows remaining resources + mass (R2.23).
2. **Mining-beam player damage:** a small per-tick chip (~1–2 HP/tick, well below a combat beam) — flying into a Miner's beam stings but isn't lethal. Tunable on smoke.
3. **Mining beam is a visual + a thin player-damage ray** to its target asteroid, **NOT a physics collider** — it doesn't block movement (the physics surface is unchanged).

## Acceptance

On sign-off I'll (a) write the WS-4 sub-plan (mining beam is a new mechanic — DEEP), (b) ship WS-2b (missile-detonates-on-asteroid) as a small failing-first PR, then (c) WS-4. Each gets a failing-first test + netgate where the live-loop is touched.
