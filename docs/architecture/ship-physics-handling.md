# Ship Physics — Top-Down Arcade Handling

The ship physics in EQX Peri is a **drifty top-down arcade** model: somewhere between full space-feel (no friction) and a road car (sticky tyres). Designed for ships that handle like vehicles in *Micro Machines* / top-down GTA: you can feel momentum on releases, and a hard turn produces visible drift before the velocity vector aligns with the new heading.

The model lives in [src/core/physics/World.ts](../../src/core/physics/World.ts) `applyInput` and is parameterised per kind by the catalogue at [src/shared-types/shipKinds.ts](../../src/shared-types/shipKinds.ts). Drones use `applyImpulse` directly with per-kind tuning in `kind.ai.*` and **deliberately bypass** the four-step model below — they're swarm bodies with a different physical character, and merging the two paths would require re-tuning every existing drone behaviour.

## Four-step `applyInput`

Every tick, for every player ship, the controller runs in this order:

```
1. Throttle    — forward/reverse impulse along the body's facing
2. Snappy turn — direct `setAngvel(±maxAngvel)` while held; `setAngvel(0)` on release
3. Lateral grip — 1-pole low-pass on the sideways component of `linvel`
4. Max-speed cap — clamp `|linvel|` at `kind.maxSpeed`
```

Steps 1, 3, 4 run **every** tick — even when no key is held — so a coasting ship continues to bleed lateral velocity and stays inside its speed envelope. Step 2 is the only one that tests for input shape.

### 1. Throttle

```ts
throttle = (input.thrust ? 1 : 0) - (input.reverse ? kind.reverseFactor : 0);
boostMul = (input.boost && throttle > 0) ? kind.boostMultiplier : 1;
impulse  = kind.thrustImpulse * boostMul * throttle;
body.applyImpulse({ x: fx * impulse, y: fy * impulse });
```

Steady-state speed under continuous thrust is the analytical terminal of a damped 1-D first-order system at the fixed 60 Hz step:

```
v_terminal = thrustImpulse · boostMul / (1 - e^(-linearDamping/60))
```

Catalogue tunings are derived from this formula — the per-kind comments in [shipKinds.ts](../../src/shared-types/shipKinds.ts) show the maths inline.

Reverse and forward cancel additively, so holding both keys yields zero net impulse — same as releasing both. `reverseFactor` defaults to 0.4–0.5 so reverse is intentionally weaker than forward.

### 2. Snappy turn

```ts
target = (input.turnLeft ? 1 : 0) - (input.turnRight ? 1 : 0);
body.setAngvel(target * kind.maxAngvel);
```

Direct write — no easing, no torque-impulse. While a turn key is held, `angvel` is exactly `±kind.maxAngvel`. On release, `target = 0` writes `angvel = 0` immediately.

This means **per-tap rotation is exactly proportional to tap duration**: a 100 ms tap of `maxAngvel = 2.0` yields `0.2 rad ≈ 11.5°` of rotation, every time. That's the resolution the player has for fine aim.

An earlier version of this code used `applyTorqueImpulse` to ease angvel toward the target. Two problems with that:
1. The mass-scaled torque-impulse was off by a factor of `0.5 · m · r² / m = 72` for the default ball collider — `applyTorqueImpulse(impulse)` divides by **moment of inertia** `I`, not mass. See [docs/LESSONS.md](../LESSONS.md) for the incident write-up.
2. Even with the correct inertia, leaving `angvel` to decay via `angularDamping` after release added a fixed `maxAngvel / angularDamping` rad of post-tap rotation that broke fine aim.

`angularDamping` is therefore set to **0** on player ship kinds — `applyInput` owns the angvel every tick and Rapier's exponential decay would never get to act on it.

### 3. Lateral-grip filter

```ts
fwd = (v.x · fx + v.y · fy);                  // forward component
lat = v - fwd · facing                         // lateral component
v   = v - lat · kind.lateralGrip               // bleed lateral
```

This is a 1-pole low-pass on the sideways velocity. `lateralGrip` controls the per-tick decay rate; the half-life of lateral velocity is `ln(2) / -ln(1 - grip)` ticks at 60 Hz:

| grip | half-life | feel |
|---|---|---|
| 0.012 | 960 ms | heavy slide |
| 0.025 | 460 ms | clear drift (Fighter) |
| 0.05 | 230 ms | quick drift (Scout) |
| 0.25 | 40 ms | instant snap (too grippy for arcade) |
| 1.0 | 0 ms | on-rails (cancels lateral every tick) |
| 0.0 | ∞ | ice (drift forever — pure space-feel) |

**Stability**: the subtractive form `v - lat · g` is a stable 1-pole filter for any `g ∈ [0, 1]` at any timestep. Don't substitute `applyImpulse(-lat · k / dt)` — at 60 Hz with `mass ≈ 1` it's mathematically identical, but the subtractive form is unconditionally stable while the impulse form breaks down at large `k`.

**Why drones bypass this**: Phase-5-era drones used `applyImpulse` with damping=0, behaving like dense pucks that bounce predictably off asteroids. Adding the lateral-grip filter to drones would require re-tuning the AI's `thrust / turnKp` against a much stickier base. v1 keeps drones on the legacy path; future work can unify if drone steering needs car-feel.

### 4. Max-speed cap

```ts
if (|v|² > kind.maxSpeed²) v *= kind.maxSpeed / |v|;
```

Hard ceiling that protects against runaway boost or post-collision overshoot. Set ~5–10% above the analytical boosted terminal so it's only reached transiently (collisions, grazing impulses), not as the steady-state limit.

## Why the model produces the right feel

- **Momentum on release** — high `thrustImpulse` with moderate `linearDamping` means terminal velocity is reached over several seconds, and a release leaves the ship gliding for a similar duration.
- **Aim-able rotation** — direct `setAngvel(0)` on release means tap rotation is just `maxAngvel × duration`. Predictable, not vague.
- **Drift on hard turns** — when you yaw 90° at speed, the velocity vector is now lateral relative to the new heading. The lateral filter bleeds it slowly enough that you see a clear curved trajectory before the ship "catches".
- **Per-kind character** — Scout has high yaw + low max speed → twitchy, agile. Heavy has low yaw + high momentum + low grip → slides like a tank. Fighter is the middle.

## Capital-vs-capital collision (2026-11-12)

Capitals collide solidly with each other by design (owner: "They absolutely should collide by design"). Rapier alone can't hold that at capital scale:

- between two multi-thousand-unit hulls its contact **disappears** once the overlap is deep (a precision limit at these coordinates; a 100× smaller copy of the same hull resolves), so nothing pushes and thrust drives the hulls deeper;
- where the contact survives, push-out is capped at ~10 u/s per contact (`normalized max corrective velocity × lengthUnit`), and the bodies fall asleep partway.

So `PhysicsWorld.tick` runs a capital-only pass after every fixed step ([capitalOverlap.ts](../../src/core/physics/capitalOverlap.ts)). For each pair of capital bodies whose real hulls (`shipCollisionParts`) overlap by more than `shipTuning(kind).overlapSkin` (a quarter of the shield pad), it:

1. moves them apart along the SAT axis by `CAPITAL_OVERLAP_RATE` (10 %) of the depth per step, at most `overlapMaxStep` (0.3 % of the hull radius, ~390 u/s for a 2× heavy cruiser), split by inverse mass;
2. removes their closing speed along that axis (inelastic, momentum kept), so held thrust can't keep a hull inside another.

A forced 350 u overlap clears in about a second. Shallow contact (shield against shield) is still Rapier's; the pass only acts when hulls actually interpenetrate. Only bodies spawned as capitals (`spawnShip` with a capital kind, or an NPC drone spawned with a capital `shieldKind`) are registered, and a capital on a warp run is skipped, so **fighter, asteroid and structure physics is untouched** and Rapier's global parameters stay at their defaults. `PhysicsWorld` is the same class on the server worker and the client predWorld, so both run the pass (#15).

Not chosen: raising `lengthUnit` (fixes only the cap, and raises every body's sleep threshold to ~40 u/s), a plain polygon instead of the rounded shield hull (loses its contact at depth just the same), full CCD (suppresses static-overlap contacts, see src/core/CLAUDE.md).

Locks: [World.capitalContact.test.ts](../../src/core/physics/World.capitalContact.test.ts) (overlaps clear in 2 s shields up and down, bow-to-bow under thrust, Rapier globals unchanged, a fighter ram's exact pre-fix trajectory) and [capitalsCollideSolidly.test.ts](../../tests/integration/sectorRoom/capitalsCollideSolidly.test.ts) (real room: pilot vs NPC, parked hull, NPC vs NPC, cruiser thrusting into a battleship).

## Verification

- **Unit**: [src/core/physics/ShipKindPhysics.test.ts](../../src/core/physics/ShipKindPhysics.test.ts) drives a real `PhysicsWorld` per kind and asserts the archetype ordering: top speed `heavy > fighter > scout`, yaw rate `scout > fighter > heavy`. The top-speed test runs 25 simulated seconds so Heavy's slow time-constant (5 s) has fully converged before the assertion.
- **Manual feel**: spawn into any sector at each kind. Hold W to feel the time-constant differences; tap A briefly to verify aim resolution; turn 90° at full speed to see the drift duration matches the kind's grip value.
- **Boot smoke** (per [project CLAUDE.md](../../CLAUDE.md)): `PORT=2568 timeout 8 pnpm dev:server` after any World.ts edit.

## Tuning a kind

Three knobs per kind, in order of impact:

1. **`linearDamping`** sets the time-constant. Want a kind that "glides forever"? Lower damping (0.1–0.3). Want a kind that "stops quickly"? Higher damping (1.0+). Halving damping doubles the coast time.
2. **`thrustImpulse`** sets the absolute speed scale. Solve for it from the terminal-velocity formula given the desired top speed AND the chosen damping.
3. **`lateralGrip`** sets the drift visibility. Lower = more drift, exponentially. Use the half-life table above.

`maxAngvel` and `maxSpeed` are aim-able and self-explanatory. `reverseFactor` and `boostMultiplier` are usually fine at 0.4–0.5 and 2.0 respectively.

## Arcade (Micro Machines) tuning, 2026-11-13

Owner direction: "I don't mind adjustments to the health, shields and acceleration and handling to make it more like micro machines and make fights a bit longer. Also don't forget the afterburner to gain speed fast..." Handling belongs to the ship, not the pilot, so this tunes the **kinds**: players, client prediction and NPC drones all read the result off the catalogue.

**Where:** [shipScale/arcadeHandling.ts](../../src/shared-types/shipScale/arcadeHandling.ts). `defineShipKind` applies it after the size scale, as one row per **handling class** (`classifyHandling`, from the AUTHORED hull: light ≤ 120, medium ≤ 220, heavy above). No record was hand-edited.

| class | × linearDamping | × thrust (and drone `ai.thrust`) | × maxAngvel | × hull / shield / regen |
|---|---|---|---|---|
| light | 16 | 16 | 4.2 | 1.6 |
| medium | 18 | 18 | 4.2 | 1.75 |
| heavy | 18 | 18 | 4.2 | 1.75 |
| capital, exempt | 1 | 1 | 1 | 1 |

- **Damping sets the time constant; thrust scales with it so cruise is unchanged.** Rapier scales velocity by `1 / (1 + d·dt)` a step, so a per-tick impulse `a` settles at `a / (d·dt)`: thrust × k and damping × k keep the terminal speed exactly (the measured cruise matches to the unit). Weapon leads, AI standoffs and the `maxSpeed` cap keep their meaning. The old exponential formula in the section above is ~3 % off at the new dampings; use the Rapier form.
- **The afterburner** (`boostMultiplier`, unchanged at 2× for fighters) now reaches its boosted terminal in ~0.6 s instead of never. Energy is unchanged: a fighter's 150 pool at `BOOST_TICK_COST` 1/tick and 0.25/tick regen gives ~3.3 s of boost from full, bursts not permanent.
- **Grip is unchanged.** Halving it was tried: slide after a held 90° turn at cruise rose to 0.6 of cruise (too icy once turns got 4× faster). At grip × 1 a quick 90° still leaves ~0.55 of cruise sideways, which the high damping bleeds within ~0.3 s: a visible slide, then bite.
- **Toughness** scales by class; shield regen rate follows the max so regen TIME to full is unchanged. Weapons are unchanged.
- **Exempt:** engineering rigs, kinds with no afterburner (robot nexus, loot pods) and **capitals**, whose handling comes from the WW2-grounded solver and is locked against its reference turn-response targets (`capitalShips.test.ts`, `capitalReference.test.ts`). Making capitals "less glacial" is a change to those reference targets, not this layer.
- **Ramming** (`RAM_DAMAGE_PER_ENERGY`) is unchanged. Two fighters head-on at the new boosted top speed (vN ≈ 1130) deal ~146 each, ~28 % of a fighter's new 525 pool (was ~55 % of 300): a real hit, never a one-shot.
- **XP side effect:** `xpForKill` reads the victim's `maxHealth`, so kills of tuned kinds give ~1.6–1.75× the XP.

Measured at the 2× shipping scale by [ShipHandling.arcade.test.ts](../../src/core/physics/ShipHandling.arcade.test.ts) (real `PhysicsWorld` + `applyShipInput`; `EQX_HANDLING_REPORT=1` prints the table). t90 = rest to 90 % of cruise; 180° = nose round from rest; brake = distance to stop from cruise with reverse held; slide = lateral speed left after a held 90° turn at cruise, ÷ cruise; TTK = shield + hull under one 72 dps laser, no misses.

| kind | t90 s (before → after) | cruise u/s | boost u/s | boost t90 s | 180° s | brake u | slide | TTK s |
|---|---|---|---|---|---|---|---|---|
| fighter | 10.9 → 0.63 | 283 | 566 | 10.9 → 0.63 | 3.15 → 0.75 | 598 → 34 | 0.38 → 0.55 | 4.2 → 7.3 |
| scout | 6.5 → 0.43 | 255 | 509 → 485 | 6.5 → 0.32 | 2.10 → 0.50 | 323 → 20 | 0.32 → 0.53 | 2.5 → 4.0 |
| interceptor | 8.2 → 0.53 | 265 | 530 → 526 | 8.2 → 0.50 | 2.52 → 0.60 | 421 → 27 | 0.33 → 0.54 | 3.3 → 5.3 |
| gunship | 13.1 → 0.75 | 297 | 529 → 504 | 6.9 → 0.33 | 3.93 → 0.95 | 834 → 47 | 0.41 → 0.54 | 5.8 → 10.2 |
| heavy | 16.3 → 0.93 | 318 | 636 | 16.3 → 0.93 | 4.50 → 1.08 | 1117 → 63 | 0.48 → 0.58 | 7.5 → 13.1 |
| missile-frigate | 21.6 → 1.23 | 283 | 424 → 411 | 7.8 → 0.38 | 7.87 → 1.88 | 1481 → 83 | 0.38 → 0.49 | 12.5 → 21.9 |
| patrol-fighter (NPC) | 10.9 → 0.63 | 283 | 566 | 10.9 → 0.63 | 3.15 → 0.75 | 598 → 34 | 0.38 → 0.55 | 5.6 → 9.7 |
| robot-square (NPC) | 9.3 → 0.62 | 242 | 364 | 9.3 → 0.62 | 2.87 → 0.68 | 440 → 28 | 0.36 → 0.55 | 2.8 → 4.4 |
| robot-circle (NPC) | 9.3 → 0.55 | 267 | 400 | 9.3 → 0.55 | 2.42 → 0.58 | 484 → 27 | 0.41 → 0.58 | 5.0 → 8.8 |
| robot-hexagon (NPC) | 8.2 → 0.48 | 318 | 366 → 339 | 1.5 → 0.03 | 3.93 → 0.95 | 505 → 28 | 0.29 → 0.42 | 9.4 → 16.5 |
| robot-harvester (NPC) | 8.2 → 0.48 | 255 | 356 | 8.2 → 0.48 | 3.15 → 0.75 | 404 → 23 | 0.34 → 0.48 | 6.3 → 10.9 |
| trader-hauler (NPC) | 3.9 → 0.20 | 295 → 271 | 295 → 271 | — | 5.72 → 1.37 | 413 → 20 | 0.20 → 0.25 | 19.4 → 34.0 |
| capitals | unchanged (8–38 s) | 155–180 | no afterburner | — | unchanged (156–170 s) | 348–1645 | 0.01 | unchanged |

(The trader's measured cruise drops because its old 3.9 s rise never quite settled inside the old maxSpeed clamp; its terminal is the clamp.) The harness locks per-class bands (t90, 180°, TTK floor, afterburner ratio and rise time for flyable kinds, slide between 0.1 and 0.75, brake under 0.4 s of cruise travel), so a later change can't drift back to floaty or fragile without failing.
