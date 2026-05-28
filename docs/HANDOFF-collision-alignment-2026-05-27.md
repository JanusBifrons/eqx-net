# HANDOFF — Collision/Shield Render-vs-Physics Misalignment (2026-05-27)

## TL;DR for the next session

Smoke-tested the new `shield-test` engineering room (4× huge Crossguard
T-ships, 1× fighter, 1× scout — all peaceful, stationary). **Both
collisions and shield contact are visibly misaligned with the rendered
silhouette.** User report verbatim:

> "The collisions are way off."
>
> "Also the shield and actual don't align... I could go a little ways
> into the render area which just felt wrong. Might be a lag compensation
> thing or a history thing or something..."
>
> "It might be a north/east thing cardinal default thing or something, a
> visual render Vs actual mismatch."
>
> "But basically both shield and collisions didn't work properly."

The user wants the **next step** to be a deterministic E2E test that
reliably places the player at known coordinates and asserts the collision
point matches the rendered silhouette. Iterate against that test until
green; don't smoke-test again until it is. (Per Invariant #13: failing
test BEFORE the fix, at the level where the bug lives.)

---

## State of the branch

Branch: `claude/game-visuals-particles-gdWgc`

HEAD: **`72c3560`** — `feat(shield-test): huge T-ship gallery + peaceful
drones + shield-aura alignment`. Unpushed. The commit is what shipped
into the smoke-test that surfaced this bug — it is the regression-lock
target for whatever E2E test the next session writes (the test must
FAIL on `72c3560`).

What that commit added (full body in `git log -1 72c3560`):
- Shared `SHIELD_RADIUS_PAD = 10` constant — physics ball, server hit-test,
  visual aura all read it (was hardcoded 12 u in `SectorRoom.playerHitscanDist`).
- `PassiveDroneBehaviour` (zero-impulse) + `peacefulDrones: boolean` room option.
- `Crossguard` T-ship — concave 8-vertex polygon, scale 10, radius 200,
  mass 30, hull/shield 1500 each, twin scaled mounts at (±120, -120).
- Optional `mass?: number` ShipKind field (default 1, every legacy kind
  unchanged). World.spawnShip + setHullExposed scale inertia via the disc
  formula `0.5 * m * r²`.
- shield-test room: 4 crossguards + fighter + scout, `swarmRadius: 2400`.

Inner loop green at the time of commit: typecheck, lint (2 pre-existing
errors in untouched files), `pnpm test` (4 newly-realigned tests pass; the
2 pre-existing host-load-sensitive failures are unrelated).

---

## What we know — and don't know — about the bug

We did **not** capture a diagnostic, take a screenshot, or run a
Playwright reproduction. Everything below is the user's verbal report.

### Symptoms

1. **Ramming a Crossguard lets the local ship penetrate into the
   rendered silhouette before the bump registers.** Magnitude unknown
   (user said "a little ways") — could be 10 u, could be 100 u. At
   scale 10 the visual silhouette is huge (crossbar tips at ±140, stem
   to y=120), so "a little ways" against a 200-radius hull could be
   anywhere from 5 % to 50 % of the radius.
2. **The shield bubble's apparent reach doesn't match where you stop.**
   The visual aura is drawn at `kind.radius + ringPad = 200 + 10 = 210`.
   The physics ball is also at `kind.radius + SHIELD_RADIUS_PAD = 210`.
   In theory they match — but the user felt a gap, so SOMETHING in the
   render pipeline OR the physics pipeline is reading a different radius.
3. **User flagged "cardinal default" / "north/east" as a possible class
   of cause** — i.e. the misalignment might be directional (only on one
   axis, or rotated by the Y-flip).

### Hypotheses, ranked by my prior

**H1 — Mount-position / sprite-position frame mismatch (most likely).**
The Crossguard authored mounts at `(±120, -120)` because the polygon
`scale: 10` multiplies the polygon points (so crossbar tips visually live
at ±140 world-units). But `mountWorldOrigin` reads `mount.localX/Y` raw,
WITHOUT applying `shape.scale`. So if the SPRITE renderer applies scale
but COLLISION code path does not (or vice versa), the collider geometry
and rendered silhouette are in different frames. I patched mounts up
front, but the polygon-collision triangles `shipCollisionTriangles(kind)`
go through `shipShapeToPolygon` which DOES apply scale — so triangle
collision matches the rendered hull. The ball collider uses
`kind.radius + SHIELD_RADIUS_PAD`, NOT `shape.scale * point_max` — so the
ball might not match the polygon footprint at scale ≠ 1.
  - Crossguard polygon bounding circle (post-scale): `sqrt(140² + 160²) ≈ 213`.
  - Crossguard `radius`: 200. Ball collider: 210.
  - Ball is SMALLER than the rendered polygon — exactly the symptom
    ("ship enters render area before bumping"). **This is the strongest
    suspect.**

**H2 — Snapshot-interpolated drone pose vs the predWorld drone body.**
`updateMirror` calls `interpolateSwarmPose` exactly ONCE per frame and
writes the result into `entry.x/y/angle` + the predWorld drone body's
kinematic follower. The renderer sprite reads `entry.x/y` AFTER. The
one-pose-per-frame rule (src/client/CLAUDE.md drone section) says the
sprite and the collision body MUST agree per frame. If the
`syncSwarmIntoPredWorld` path is calling `interpolateSwarmPose` at a
*different* `now` than `updateMirror`, the sprite and collider diverge
by raf-jitter ms. This is the 2026-05-19 jitter bug class. Worth
greppying for unexpected `interpolateSwarmPose` callers.

**H3 — Server-authoritative ramming-damage uses a different collision
geometry than the client predWorld.** Rapier on the server is in the
physics worker, with the same `setHullExposed` swap — should be identical
geometry. But the `CONTACT_BATCH` aggregation that fires
`Ramming.applyRammingDamage` is in `src/core/combat/Ramming.ts` — it may
use radii from `getShipKind` (kind.radius) without the shield pad, so
ramming damage may register at a DIFFERENT distance from the visible
collision. Worth verifying.

**H4 — Y-flip in mount or sprite positioning.** The catalogue is
"Pixi-up authored" (Y goes down on screen). The renderer flips Y
(`sprite.y = -ship.y`). If mount positions were authored in standard-Y
they'd appear mirrored. My Crossguard mounts at `localY: -120` should
sit at the TOP of the screen (where the crossbar is). Verify by checking
that beams emerge from the visual crossbar tips, not from below the ship.

**H5 — Lag compensation tampering with stationary targets.** The drones
are stationary (peacefulDrones); the snapshot ring still records their
pose every tick. If `SnapshotRing.getPoseAt(droneId, fireTick)` returns
slightly off-axis vs `swarmRegistry.all()` (which reads current SAB
pose), hits resolve at the lag-comp pose while the visual is at the
current pose. For stationary targets this shouldn't matter — Δpose = 0
— but worth confirming `interestScratch` is correctly populated for
the new high-radius drones.

### What was specifically NOT verified

- Whether the polygon collision triangles for Crossguard actually
  triangulate as expected at `scale: 10`. The `triangulate.test.ts`
  asserts `n - 2 = 6` triangles, but does NOT assert the triangles
  cover the right region. Would a vertex check (centroid, bounding box)
  catch a Y-flipped or unscaled triangulation? Probably yes.
- Whether `mountWorldOrigin` actually skips `shape.scale` (assumed
  above — verify with `grep -n shape.scale src/`).
- Whether the visual sprite for Crossguard is being rendered with
  scale 10 or scale 1 (the `shape.scale` field is consumed by
  `buildShipGfxFromShape` — but does any code path bypass it?).

---

## The test the next session needs to write

Per Invariant #13 (failing test BEFORE the fix, AT THE LEVEL THE BUG
LIVES). The bug crosses:

- Server-authoritative pose (`SwarmEntityRegistry.all()`)
- Wire (binary swarm format + snapshot `drones[]` slice)
- Client snapshot decode + `interpolateSwarmPose` + `syncSwarmIntoPredWorld`
- Client renderer (`PixiRenderer.updateSwarmSprites`)
- Player-side ramming → CONTACT_BATCH on the server

**The right level is Playwright E2E** because the bug spans wire +
predict + render. A unit test on `World.spawnShip` would have caught H1
in isolation but would not have caught H2/H3/H5. Write BOTH (per the
CLAUDE.md "when unsure, write BOTH" rule), but the regression-locking
gate is E2E.

### Suggested E2E shape

```ts
// tests/e2e/crossguard-collision-alignment.spec.ts

import { test, expect } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';

test.describe('Crossguard collision matches rendered silhouette', () => {
  test('local ship cannot enter the visible hull', async ({ page }) => {
    // Use the test-sector-fast room with a deterministic spawn:
    //   - Local player: fighter at (0, 0), zero velocity
    //   - Single Crossguard drone at (1000, 0), stationary, peaceful
    // Drive the local ship straight at +x toward the drone using
    // bespoke triggers (NOT timeouts — per the test-harness rule).
    //
    // Read the local ship's x position when the FIRST CONTACT_BATCH
    // ramming damage event lands (server emits 'damage' broadcast).
    // Crossguard hull face at x=1000 - 140 = 860 (crossbar tip at
    // local x=140 after scale).
    // Crossguard shield bubble at x=1000 - 210 = 790 (ball collider).
    // Local ship + shield = +22 in front (fighter r=12, pad=10).
    // EXPECTED ramming x (shield-on-shield): 790 - 22 = 768.
    // OBSERVED in smoke test: presumably > 768 (player penetrated).

    // Assert: local ship x at first ramming-damage event ∈ [765, 775].
    // Tolerance: ±5 u to cover a single tick of penetration.
  });

  test('beam from local ship stops at Crossguard shield bubble', async ({ page }) => {
    // Same setup, but fire a hitscan toward the drone instead of ramming.
    // Read hit_ack.dist from the wire. Should be 1000 - 210 = 790
    // (ball collider distance from ray origin at x=0).
    // Beam visual endpoint (read from data-laser-endpoints attribute,
    // which the renderer exposes for E2E inspection) should match.
  });
});
```

### Bespoke triggers we'll likely need to ADD

Per the test-harness philosophy section of root CLAUDE.md ("bespoke
gameplay triggers, never bump timeouts"):

1. **`initialShipPose: { x, y, vx, vy, angle }`** JoinOption — already
   exists partially (initialHull, initialShield); add pose so the test
   doesn't need to drive the ship across the sector to get into ramming
   range. Saves seconds per case.
2. **`spawnSingleDrone: { kind, x, y }`** room option (or repurpose
   `droneKinds` + `singleAsteroid` semantics) — exactly one drone, exact
   coords. Saves the spawner's uniform-disc placement noise.
3. **`data-ramming-event`** test-mode DOM attribute mirroring the latest
   `damage_event` payload (or a new dedicated `data-last-ramming-damage`
   testid). Lets Playwright assert the ramming-damage payload's
   `hitX`/`hitY` directly. Probably easiest path is to extend
   `HudTestAttributes.tsx`.

Cost of adding these is low (each is ~30 min) and they pay off the
moment the next ramming/collision bug appears.

### Where to start the investigation AFTER the failing test exists

1. Verify Crossguard's polygon collision triangles (`shipCollisionTriangles('crossguard')`).
   Compute the bounding box, signed-area sum, centroid — assert they
   match the scaled polygon (visual silhouette). 5 minutes; rules out H1
   for triangle geometry.
2. `grep -n "kind.radius" src/` — every site that reads the bare radius
   and uses it as a collision/render parameter. Audit each: is it
   reading the SCALED bounding circle or the raw catalogue field? At
   scale 10 the rendered polygon's bounding circle is ~213, but
   `kind.radius` is 200. Anything that should use the scaled value but
   uses the raw is a misalignment site.
3. `grep -n "shape.scale" src/` — every site that consumes `shape.scale`.
   If the renderer applies it but the collider config doesn't, that's H1.
4. Check `interpolateSwarmPose` callers — verify the one-pose-per-frame
   rule isn't being broken by a new consumer (H2).
5. Check `Ramming.ts` — confirm it uses the same effective radius as
   the visual+physics (H3).

---

## Useful greps + jump-points

- Shield pad single source of truth: `src/shared-types/shipKinds.ts:115`
  (`SHIELD_RADIUS_PAD`).
- Crossguard kind: `src/shared-types/shipKinds/crossguard.ts`.
- Per-kind mass logic: `src/core/physics/World.ts:154-163` (spawnShip);
  `setHullExposed` does NOT re-apply mass (sticky additional-mass).
- Drone client-side sync: `src/client/net/ColyseusClient.ts` →
  `syncSwarmIntoPredWorld`, `updateMirror`, `interpolateSwarmPose`.
- Server-side hit-test (now per-kind): `src/server/rooms/SectorRoom.ts`
  → `playerHitscanDist`, `playerProjectileSweep`.
- Mount world origin: `grep -rn "mountWorldOrigin" src/`.
- Sprite scale: `grep -rn "shape.scale\|buildShipGfx" src/client/render/`.
- Ramming geometry: `src/core/combat/Ramming.ts`.

## Related history

- 2026-05-15 docs/LESSONS.md "Pixi-up vs game-space coords" — the warp
  filter ripple was at the player's vertical mirror because Y wasn't
  flipped. The same Y-flip class could explain a directional
  misalignment.
- src/core/CLAUDE.md "Shield/Hull collider model (2026-05-16)" — every
  ship collider is density 0; mass is pinned. The Crossguard mass=30
  override changes the pinned value but NOT the density (still 0); the
  inertia formula auto-scales by m. Sanity-check that the parity test
  `World.setHullExposed — collider swap does NOT change mass or inertia`
  still passes with `mass !== 1` (current passing tests use fighter
  default mass=1; add a Crossguard variant).

---

## State for the next session at handoff time

- Dev servers running (`http://localhost:5173/?room=shield-test`) — if
  you don't need them, kill 2567 + 5173 before the test run (per the
  "Claude owns the dev servers" memory).
- 28 untracked diag captures in `diag/captures/` — these are user smoke
  sessions today; safe to leave alone.
- All inner-loop gates green at `72c3560`. Pre-existing failures
  (TickBudgetTelemetry, spiral-ondevice-replay, 2 lint errors in
  mirrorToEngineEmitter.test.ts + PlayerSlotMap.test.ts) are NOT mine.

## Don'ts

- **Don't smoke-test on device until the E2E gate is green.** Per the
  user's standing rule: automated repro first, user testing last.
- **Don't widen test tolerances to make the gate pass.** If 5 u
  tolerance isn't enough, the bug isn't fixed — figure out why.
- **Don't add a per-symptom patch.** The user explicitly asked for the
  general fix: "what about remote/bot? generalise to the abstraction,
  cover real symmetric cases" (feedback memory). If Crossguard has a
  scale-aware-radius bug, EVERY kind with scale ≠ 1 has it; fix the
  primitive, not the symptom.
- **Don't bump SHIELD_RADIUS_PAD or kind.radius to "make it look right"
  on Crossguard.** The visual and physical have to agree by construction,
  not by tuning.

---

## Resolution (2026-05-28, plan `lively-patterson`)

Three changes shipped on `claude/game-visuals-particles-gdWgc`:

1. **Crossguard `radius` 200 → 213** (matches the scaled polygon's
   bounding circle exactly). Catalogue version 4 → 5. This is the H1
   fix from the hypothesis table — the shield ball collider now fully
   encloses the rendered silhouette. The Don't above (don't tune to
   make it look right) holds: 213 isn't a feel-tuned number, it's the
   bounding circle.

2. **Concave decomposition pivoted from in-house ear-clipping to
   `poly-decomp`** (NPM). `src/core/geometry/triangulate.ts` deleted;
   replaced by `src/core/geometry/shipHullDecomp.ts`. Each kind's
   polygon is now decomposed into convex parts (Crossguard T → 2 parts:
   crossbar rectangle + stem rectangle). Verified geometrically correct
   in unit + integration + E2E tests.

3. **`World.setHullExposed` continues to emit `RAPIER.ColliderDesc.triangle`
   colliders**, NOT `convexHull` — fan-triangulating each convex part.
   The 2026-05-28 investigation found that `convexHull` and `cuboid`
   shapes do NOT fire `CONTACT_FORCE_EVENTS` for static interpenetration
   in Rapier 2D (positional-correction impulse ≠ contact force); only
   `triangle` shapes do. Locked by
   `src/core/physics/hullCollisionNoTouch.test.ts` DIAGNOSTIC + the
   E2E positive-control case.

Regression locks:
- `tests/e2e/t-ship-no-self-collision.spec.ts` — negative + positive
  control. NEGATIVE: two crossguards with 20 u gap → 0
  `collision_resolved`. POSITIVE: two crossguards stacked → 30+
  `collision_resolved` + `ram_damage` per ~30 snapshots.
- `src/core/physics/hullCollisionNoTouch.test.ts` — direct physics
  layer; bare-Rapier shape comparison + ship-spawn + obstacle-spawn.
- `src/core/geometry/shipHullDecomp.test.ts` — per-kind convexity,
  CCW winding, area conservation, Crossguard ≥ 2 parts, fighter
  notch honoured.

Critical caveat — **`data-pred-stats.collisionEventsApplied` is NOT a
valid signal for drone-vs-drone collisions.** The client's `applyCollision-
Resolved` only counts events when both bodies are in the client's
predWorld, and drones are keyed `swarm-${entityId}` there while the
server broadcasts the drone's `id` string. They never match. The E2E
spec uses `/dev/events` (server log) instead — the unfiltered source
of truth. Any future drone-vs-drone collision spec must do the same.

Verification:
- `pnpm typecheck && pnpm test` — green for everything touched (pre-
  existing TickBudgetTelemetry / spiral-ondevice-replay / 2 lint errors
  in mirrorToEngineEmitter + PlayerSlotMap are unchanged baseline).
- `pnpm playwright test --project=feature tests/e2e/collision-events.spec.ts tests/e2e/t-ship-no-self-collision.spec.ts` — 3/3 green.

What this work DOES and DOES NOT resolve:

- DOES — concave hull geometry is provably correct. The negative
  control (two T-ships with a 20 u stem-tip gap) emits zero
  `collision_resolved` events; the positive control (two stacked)
  emits 30+ per ~30 snapshots. The polygon collider matches the
  rendered silhouette.
- DOES — shield ball collider now encloses the rendered silhouette
  (radius 213 ≥ polygon bounding 213; with `SHIELD_RADIUS_PAD = 10`
  the ball sits at 223 ≥ silhouette).
- DOES NOT — on-device verification of the user's smoke-test
  "way off collisions" report. The user disputed the shield-up
  framing; the hull-down concave geometry is now locked-in correct
  but a separate test on-device is still required before the original
  smoke-test bug can be considered resolved. Per the standing
  no-handoff-mid-work rule, do that ONLY after merge to main + a
  clean working tree.
