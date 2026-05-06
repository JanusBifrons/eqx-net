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
