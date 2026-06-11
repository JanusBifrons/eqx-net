# Equinox (EQX Peri) — Round 2 Bug Backlog: Categorisation & Action Plan

## Context

The "Equinox Bugs" Google Doc (Drive id `15Y9d6HFCflNW2KnoHx7b33cYYCiTh0HS7IWnx8v3L9Y`, last edited 2026-06-11) collects smoke-test findings in two rounds. The **`## Round 2`** section is the current backlog: it re-reports the still-broken Round 1 items and adds many new ones (33 distinct issues). This plan covers **Round 2 only** (per decision), categorises the issues by system, and lays out a **foundational-first**, dependency-ordered roadmap where each fix ships with a failing-test-first regression lock.

These are manual-play bug reports, so the project's **Invariant #13** governs every item: *reproduce the bug, write a failing test at the layer the bug lives, then fix.* We **assume each item is still broken**. Reproduction comes first — from the user's diagnostic capture or on-device — because that is what tells us *where the bug lives* and therefore which layer the test must target. A lock that **passes on its first run is NOT evidence the bug is fixed** — per Invariant #13 it almost always means the test is at the wrong layer or asserts the wrong thing (the canonical 2026-05-14 damage-number incident: a unit test passed easily while the bug was still live at the worker boundary). Green-first is a red flag about the *test*, not a green flag about the *code*: re-target it (boundary-crossing if the bug lives at a boundary). We only conclude an item is already fixed when a genuine **manual reproduction fails to reproduce it** — never from a green test alone. And not every item is automatable: visual/feel issues can be *guarded* against regression but their correctness is a human judgement (see "Test feasibility" below).

Goal: a steady stream of small, green, individually-shippable PRs that retire the backlog system-by-system, leaving behind E2E/integration tests that stop each bug recurring.

---

## Categorisation (Round 2, 33 issues)

| # | Category | Round 2 issues |
|---|---|---|
| **A. Combat & physics** | Collision/ram, missiles, beams | ram damage too high (R2.31); missiles pass through asteroids + lingering hulls, still jitter (R2.22); beams pass through shield walls (R2.28); interceptor aim-line longer than range (R2.14); beam range gradient + reverse-square falloff (R2.29) |
| **B. Mining & asteroids** | Mining-laser entity + asteroid model | mining laser should be a real aimable, colliding entity that mines asteroids + lightly damages players (R2.27); mining range indicator (R2.16) |
| **C. Power-grid topology** | Connection rules + counts | connector shows 4 options but connects to 1, limit 6, want green-to-N + red-to-overflow (R2.17); show max-connections, capital shorter range + only connectors may attach (capital = leaf) (R2.10) |
| **D. Structure visuals** | Connector/shield/pylon render | connectors don't pulse to show flow (R2.2); connectors much smaller (R2.11); shield effect too subtle vs connector lines (R2.19); shield pylons undamageable while shield up + tiny (R2.18); turret + miner render upside-down (R2.13) |
| **E. New structures** | Defence variety | new laser-bolt turret + missile turret (R2.15) |
| **F. Selection & info** | Picking, stats, world indicators | stats box "pops in" after delay — want instant/spinner (R2.8); move stats to world-space above the structure (R2.30); battery charge + capital resource indicators (R2.12); out-of-power icon (R2.20); select asteroids (mass/resources) + lingering hulls (owner) (R2.23) |
| **G. Placement UX** | Build flow | structure vanishes then reappears (R2.1, needs screenshot-E2E); desktop drag/follow state machine (R2.5); connection-range circle while placing (R2.3); hover outline as well as click (R2.4) |
| **H. Build menu** | Speed-dial | labels always visible, stay-open across placements, toggle, icon = drilled selection + back arrow (R2.6) |
| **I. Living world & AI** | Waves, indicator, steering | neutral fighters never return + first-qualify toast (R2.24); persistent warp-in indicator, colour-coded (R2.21); AI steering brain-dead — should decelerate-and-stop in weapons range (R2.25) |
| **J. Lingering ships** | Persistence, pose, render | linger forever, no TTL (R2.26); bumped hull re-entry teleports to stale pose (R2.33); lingering shields + weapons don't render (R2.32) |
| **K. Misc visual/transition** | Effects | remove warp glow/bloom (R2.9); map overlay low-res/blurry (R2.7); ship-change curtain briefly flashes the sector (R2.26) |

---

## Per-item protocol (applies to every workstream)

1. **Reproduce first.** Confirm the bug is real and understand the exact flow *before* writing any test — reconstruct it from the user's diagnostic capture (`diag/captures/<id>/` + `lifecycle.ndjson`/`combat.ndjson`) or by driving the app on-device. Reproduction is what reveals the layer the bug lives at; a test written without it is a guess.
2. **Write the lock at that layer and watch it FAIL.** A boundary bug must cross the boundary (Playwright + probe page); a logic bug can be unit/integration. **If the lock passes on its first run, do NOT record the item as fixed** — that means the test is mis-targeted (wrong layer / wrong assertion). Re-target it where the manual repro actually lives. An item is only "already fixed" when **manual reproduction itself fails** — documented as such, with the repro attempted, not inferred from a green test.
3. **Fix.** Smallest change that turns the (genuinely-failing) lock green.
4. **Inner loop:** `pnpm typecheck && pnpm lint && pnpm test` green → commit (imperative subject + plan ref). One coherent unit per commit.
5. **Live-loop gate:** where flagged 🔴, also run `pnpm e2e:netgate` (baseline-relative-green) before "done" — any change to `client/net`, `core/prediction`, physics, render loop, snapshot decode/interpolate, mount aim, or `SectorRoom` tick/snapshot (Invariant #8).
6. **Docs:** update the relevant zone `CLAUDE.md` + `docs/` when a workstream changes an invariant, contract, threshold, or teaches a lesson (Invariant #7, #10). Catalogue edits to `structureKinds.ts` are **append-only + version-bump** (Invariant #11).
7. **No new hot-loop allocation** (Invariant #14).

Reuse existing bespoke test primitives rather than bumping timeouts: `prebuiltStructures`/`scenarioDrones`/`scenarioAsteroids` + the `structure-scenario-test` room, `structureGridPulseMs`, `dronePoses`, `startHostile` + `auto-fire-test` room, `lingerMs` + `galaxy-test` room, `initialHull`/`initialShield`, `testTimeScale`, the `_internals` integration seams + `connectActive`, and the CDP two-touch pattern.

### Test feasibility — not every bug is automatable

Each item is one of three kinds. Knowing which *before* writing the lock stops us forcing a brittle assertion onto a bug that doesn't live in automatable logic.

- **[L] Logic lock** — state is assertable, so a hard automated test is the regression guard. *Ram damage values (R2.31), missile-vs-asteroid/lingering impact (R2.22), beam-stops-at-wall (R2.28), aim-line==range (R2.14), falloff curve (R2.29), mining mines/damages (R2.27), connection counts + capital-leaf rule (R2.17, R2.10), pylon-undamageable (R2.18), new turrets kill (R2.15), pick asteroid/lingering (R2.23), wave recurrence (R2.24), AI decelerate-and-stop (R2.25), linger-forever + live-pose re-entry (R2.26, R2.33), stats latency (R2.8).*
- **[V] Visual guard + human eyeball** — a screenshot/structural-diff E2E can guard *regression* (sprite present, filter detached, radius value, world-anchored position, hover outline appears) but **cannot assert "looks right"** — that judgement is the user reviewing the screenshot the spec captures. *Structure-never-disappears (R2.1), connector pulse readability (R2.2), connector size (R2.11), upside-down sprites (R2.13), shield distinctness (R2.19), out-of-power icon (R2.20), battery/capital indicators (R2.12), world-space stats (R2.30), mining-range circle (R2.16), placement range circle (R2.3), hover outline (R2.4), speed-dial behaviour (R2.6), persistent warp indicator (R2.21), lingering shield/weapon render (R2.32), remove glow (R2.9), map sharpness (R2.7).*
- **[M] Manual / feel** — resists reliable automation; the deliverable is a documented manual reproduction + diagnostic capture, and we state plainly "verified manually, not locked" rather than shipping a flaky test. *Desktop drag *feel* (R2.5) — the pointer state machine is [L]-assertable via Playwright pointer events, but "follows smoothly / doesn't give up" is [M]; ship-change curtain flash (R2.26) — sequence is screenshot-guardable [V], the "no flash" perception is [M].*

For **[V]** and **[M]** items, the spec's job is to **capture the artefact (screenshot / capture) for the user to confirm**, and to fail loudly if the *structural* precondition regresses — not to pretend a pixel assertion equals correctness. Where a screenshot baseline is used, the user signs off the first baseline.

---

## Red-team hardening — corrected diagnoses & gates (READ FIRST)

An adversarial review verified every claim against the source. **Six items' root-cause diagnoses were WRONG** — the code the plan called "missing" already exists, so the originally-named test would pass green on first run and an agent trusting the plan would wrongly retire the bug. For these, the original diagnosis is **void**: reproduce on-device, then RE-diagnose. Do **not** write the originally-named fix.

### A. Diagnosis known-wrong — reproduce & re-diagnose first

| Item | Original (WRONG) diagnosis | What the code actually shows | Re-diagnosis starting point |
|---|---|---|---|
| **R2.28** beams through walls | "server never consults walls; ADD a block" | Server ALREADY blocks: `PlayerFireResolver.hitscan` → `blockBeamAtWall` → `shieldWalls.blockShot` (wired `SectorRoom.ts:1135` player, `:1163` AI; projectiles `wallBlocksProjectile` `:1278`). | Find the GAP in the existing block — wall/pylon `active` state while "up", wall-segment geometry, or the CLIENT predicted beam diverging. |
| **R2.13** turret/miner upside-down | "double Y-flip in `buildStructureGfx`" | No double-flip; the `swarmSpriteUpdater.ts:104` flip is the standard game→Pixi conversion for ALL kinds; structure hulls are symmetric N-gons (invariant under 180°). A body-polygon test passes first-try. | The directional **mount/barrel aim angle** (`swarmSpriteUpdater.ts` ~148), not the body sprite. |
| **R2.25** brain-dead AI | "no decelerate-and-stop; DEEP rework" | `HostileDroneBehaviour.ts:476-499` ALREADY has arrival-standoff + reverse-thrust braking (added 2026-06-01). | MIS-TUNING (or a kind-specific thrust/torque issue), not absence. Reproduce the float, re-tune. NOT a DEEP rework. |
| **R2.24** waves never return | "dispatch-once; make recurring" | `WaveDirector` increments per-faction `waveCount`, rate-capped — already recurs. | A re-qualify / readiness-latch issue (player stops being seen as "ready"). The first-qualify TOAST half IS genuinely new + correct. |
| **R2.33** lingering re-entry pose | "restore reads frozen Limbo pose" | AMBIGUOUS: rebind path (`SectorRoom.ts:3232`) reads LIVE SAB; fresh-spawn-restore (`:3435`) reads the frozen pose. Which repro'd depends on the reconnect path taken. | Reproduce to identify WHICH reconnect path, fix that one. Don't assume. |
| **R2.1** structure vanishes | "screenshot E2E primary" | `pendingPlacementResolved()` (`structurePlacementClient.ts:85`) clears the ghost on a 3s-timeout OR real-arrival — a **unit-testable race**, pure client logic. | Lock at UNIT (the resolve race); screenshot for [V] sign-off only. Likely gap: timeout vs RTT, or snapshot-count mismatch. |

### B. Scoping & regression gates (resolve before coding)

1. **Asteroid-model ADR is a FRONT GATE, not punted.** WS-2's missile-vs-asteroid half and WS-4 (mining entity) both need ONE decision: *are asteroids damageable, mineable-only (chip resources, HP-immune), or both — and do projectiles/beams detonate on them?* Today asteroids are HP-immune (`EntityResolver.ts:156`), so removing the missile skip alone yields zero-damage detonations (= R2.22 symptom 4). **Write `docs/architecture/asteroid-interaction-model.md` (short ADR) + get user sign-off BEFORE WS-2b/WS-4.**
2. **WS-1 ram has NO mass to read.** The `Contact` shape carries no per-body mass. "mass-ratio + reverse-square" needs either threading mass into the contact (scoped change to `contactDrain.ts` + the contact struct) OR dropping the mass term for reverse-square-on-speed only. Decide explicitly; it rewrites `ramming.test.ts` linear goldens (deliberate golden change).
3. **WS-5 capital-as-leaf inverts the `isHub` model** and flips the passing `Grid.test.ts:84-88` golden — plan it as a deliberate golden-master rewrite.
4. **Radius shrink (R2.11/R2.18) is BEHAVIOURAL, not an append** — per-kind radius drives the polygon collider, shield-wall geometry, and grid edge-distance math (hardcoded in `structureGrid.test.ts`); forces a `STRUCTURE_KIND_CATALOGUE_VERSION` bump.
5. **Linearize the catalogue version bump** — WS-5 (per-kind range), WS-6 (radii), WS-8 (new kinds) all append + bump; sequence so the bump happens once per PR, never concurrently.
6. **Most "new" locks already EXIST — extend, don't create:** `pickEntity.test.ts`, `missileLifecycle.test.ts`, `structureGrid.test.ts`, `structure-grid-web.spec.ts`, `shieldFence.test.ts`, `ramming.test.ts`, `Grid.test.ts`. Extensions carry regression risk to existing assertions.

### C. Coverage fixes

- **R2.22 has FOUR sub-symptoms:** (1) jitter, (2) pass-through asteroids, (3) pass-through lingering hulls, (4) **"indicator flashes but missile continues" = detonate-without-despawn.** Add (4) to WS-2.
- **R2.22 jitter "already handled" is UNVERIFIED** — confirm `MISSILE_POSE_RING_DEPTH` covers `MISSILE_DISPLAY_DELAY_MS=100` at the ~20 Hz JSON cadence (≥3 deep); this is the exact Step-4 drone-interpolation regression mode (CLAUDE.md #12). Add a const assertion + on-device jitter repro before concluding it's fixed.
- **R2.32 splits by layer:** "shields still present (invisible)" is SERVER state [L, 🔴]; "weapons don't render" crosses the `WorkerRendererClient↔worker` structured-clone boundary [V — the test MUST cross the worker boundary, the 2026-05-14 incident class]. Two locks, two layers.
- **Tighten Round-1 exclusions:** fold a turret FIRE-CADENCE assertion into WS-8 (R1.5 "turrets fire in pulses" was dropped, but R2.15 ADDS two turrets — don't ship them stuttering); R1.4 "capital works" does NOT vouch for non-capital structure collision — keep a structure-block regression check.
- **WS-9 needs NO new wire fields** — the slice already carries `storedPower`/`minerals`/`powered` (`snapshotMessages.ts:199`); confirms WS-9 is not 🔴.

---

## Roadmap (foundational-first, dependency-ordered)

> ⚠ **Corrected diagnoses above override the inline text below** for: WS-1 (mass gate), WS-2 (R2.22 4th symptom + jitter ring-depth), WS-3 (R2.28 already-blocks), WS-7 (R2.13 mount-angle not body), WS-10 (R2.1 unit layer), WS-11 (R2.24/R2.25 already-implemented → re-tune), WS-12 (R2.32 split, R2.33 ambiguous path). Read §A/§B/§C first.

Tags: 🔴 = `e2e:netgate` required · **DEEP** = warrants its own sub-plan before coding · **QUICK** = shallow, low-risk filler.

### Phase A — Combat & physics foundations (gameplay-breaking, unblocks the rest)

**WS-1 🔴 — Ram-damage curve (R2.31).**
Root: `src/core/combat/Ramming.ts` already gates below a 50 u/s floor but the curve is linear on closing speed with no mass term. Add reverse-square on closing speed; for the mass term see the **gate (§B.2): the `Contact` shape carries NO per-body mass** — either thread mass into the contact (scoped change to `contactDrain.ts` + the contact struct) OR ship reverse-square-on-speed only and defer mass-ratio. Decide before coding; this also rewrites `ramming.test.ts`'s linear goldens (deliberate golden change).
Files: `src/core/combat/Ramming.ts`, `src/core/physics/contactDrain.ts` (+ contact struct if mass is threaded), `SectorRoom.ts` (pre-step velocity feed).
Lock: integration `tests/integration/sectorRoom/ramming.test.ts` — light tap on a heavy capital ≈ 0 dmg; high-speed + high-mass-ratio = expected dmg. Layer: core formula / integration. Primitives: `prebuiltStructures`, `dronePoses`, `initialHull`.

**WS-2 🔴 — Missiles: homing + lingering-hull collision + detonate-despawn (R2.22 symptoms 1,3,4).**
Root: `MissileSimulation.ts` `lockOnTarget`/`sweepCollision` skip `!isActive` ships (lingering hulls pass through) and re-acquire only every `MISSILE_REACQUIRE_INTERVAL_TICKS=10` picking nearest with no bias. Strengthen closest-enemy bias (lower interval, higher turn-rate, sticky-nearest) and make lingering hulls collidable. **Symptom 4 (§C): "indicator flashes but missile continues" = detonate-without-despawn** — ensure a registered hit despawns the missile (this is partly the asteroid-immunity interaction → WS-4). **Jitter (symptom 1): verify, don't assume fixed (§C)** — `MissileMirror` has a pose-ring, but confirm `MISSILE_POSE_RING_DEPTH` covers `MISSILE_DISPLAY_DELAY_MS=100` at ~20 Hz (≥3) + on-device repro before retiring it.
Files: `src/server/rooms/MissileSimulation.ts`, `src/core/ai/WeaponMountController.ts` (`pickTarget`), `EntityResolver.ts`; client `MissileMirror.ts` + the ring-depth const (conditional).
Lock: extend integration `missileLifecycle.test.ts` (damages a lingering hull; locks + commits to nearest in a pack; a registered hit despawns) + `pickTarget` unit + a ring-depth const assertion. **Symptom 2 (missile-vs-asteroid) ships with WS-4** behind the asteroid-model ADR (§B.1) — do NOT remove the `kind===0` skip before that ADR lands.

**WS-3 🔴 — Beams: shield-wall blocking + aim honesty + falloff (R2.28, R2.14, R2.29).**
Root: **R2.28 diagnosis CORRECTED (§A)** — the server already blocks beams at walls (`PlayerFireResolver.blockBeamAtWall` → `shieldWalls.blockShot`, wired `SectorRoom.ts:1135/1163`). Reproduce on-device first, then find the GAP (pylon `active` state while up / wall geometry / client predicted-beam divergence) — do NOT add a new block. R2.14 is a literal 2× bug: aim line `AIM_LINE_LENGTH=500` hardcoded vs interceptor range ~250. R2.29 (reverse-square falloff + visual taper) is genuinely new.
Files: `src/server/structures/ShieldWallManager.ts` + `PlayerFireResolver.ts` (locate the block gap), `src/core/combat/Weapons.ts` + `WeaponCatalogue.ts` (range + new append-only `falloff` field), `src/client/render/MountVisualManager.ts` (aim line from active weapon range), `BeamSpritePool.ts` (visual taper), predicted-beam path.
Lock: integration `laserShieldWall.test.ts` (beam stops at + damages the wall, doesn't pass through); unit: aim-line length == active weapon range; unit: reverse-square falloff curve. Reuse `prebuiltStructures` (shield pylons) + `auto-fire-test`.

### Phase B — Asteroid model + structures

**WS-4 🔴 DEEP — Mining-laser entity + asteroid interaction model (R2.27, R2.16); unblocks WS-2 asteroid half.**
Root: mining is a passive grid-pulse drain with no beam entity; asteroids are damage-immune. **Decide the asteroid model once** here: asteroids are *mineable* (resource chip, distinct from HP damage) **and** collidable by projectiles/beams. Make the miner's beam a real aimable, colliding entity (mines asteroids, deals small player damage on hit). Add the mining-range indicator (R2.16). Removing the missile asteroid-skip (R2.22) then has a coherent target.
Files: `src/server/structures/StructureGridSubsystem.ts` (decouple mining from the pulse), new mining-weapon def in `src/core/combat/`, `EntityResolver.ts` + `entity/leaves/`, `src/shared-types/` (asteroid `resources` field), client beam render + miner range overlay.
Lock: integration `miningLaser.test.ts` (mines asteroid resources; damages a player it hits; asteroid takes no HP damage); E2E aimable-beam screenshot. Primitives: `scenarioAsteroids` + `prebuiltStructures` + `structureGridPulseMs`.
**Sub-plan before coding** — new mechanic + the shared asteroid-damageability decision that WS-2 consumes.

**WS-5 🔴 DEEP — Grid topology & connection rules (R2.17, R2.10).**
Root: `structureGridView.autoConnectStructure` connects to the *nearest* hub only (shows 4 options, connects to 1); `Grid.canConnect` lacks a per-endpoint range and the capital-leaf rule (capital is a hub, so leaves attach directly today). Add per-kind `connectionRange` (capital small), "capital accepts only connectors", connect-to-all-qualifying up to the cap, and client green-to-N / red-to-overflow preview lines.
Files: `src/core/structures/Grid.ts` (`canConnect`, `maxConnections`, range), `structureGridConstants.ts`, `src/shared-types/structureKinds.ts` (per-kind range; append-only + version bump), `structureGridView.ts`, `src/client/render/pixi/ConnectorRenderer.ts` (preview).
Lock: `Grid.test.ts` golden + new cases (capital-only-connectors; per-kind range; N-not-1); E2E `structure-grid-web` green/red preview screenshots.
**Sub-plan before coding** — the capital-leaf invariant ripples into placement/preview/auto-connect; split into topology-rule PR → preview PR.

**WS-6 🔴(partial) — Connector/shield visuals + pylon rules (R2.2, R2.11, R2.19, R2.18).**
Root: server grid pulse is already ~1 Hz but the client renders connectors a constant colour (no flow animation); connector/pylon radii too large; shield visual too faint vs connector lines; pylons are damageable while the wall is up.
Files: `ConnectorRenderer.ts` + `connectorVisual.ts` (delayed flow pulse showing direction), `structureKinds.ts` (smaller connector + pylon radii; version bump), `ShieldWallManager.ts` (route pylon damage to the wall while active).
Lock: `connectorVisual.test.ts` (pulse phase/direction); extend `shieldFence.test.ts` (pylon takes 0 damage while wall up — 🔴 server path); screenshot E2E for size + shield distinctness.

**WS-7 — Structure orientation + miner range (R2.13).**
Root: **CORRECTED (§A)** — NOT a body double-flip (hulls are symmetric N-gons, invariant under 180°; a body-polygon test passes first-try). The upside-down look is the **directional mount/barrel aim angle** (`swarmSpriteUpdater.ts` ~148). Reproduce, then fix the mount-angle sign for kind=2.
Files: `swarmSpriteUpdater.ts` (mount/barrel aim angle for structures), `src/client/render/pixi/spriteBuilders.ts` (only if a marker/notch is asymmetric). (Miner range circle delivered in WS-4.)
Lock: sprite-orientation unit + screenshot E2E. Pure client, no gate. **QUICK.**

**WS-8 🔴 — New defence structures (R2.15).**
Root: need a laser-bolt turret + a missile turret. Depends on WS-3 (beam), WS-2 (missile spawn), WS-5/6 (structure plumbing).
Files: `structureKinds.ts` (append + version bump), `StructureGridSubsystem.ts` (per-kind fire / missile spawn), `spriteBuilders.ts`, `SpeedDialMenu.tsx` (menu entries).
Lock: extend `structureTurret.test.ts` per new turret (kills a `scenarioDrones` drone) **+ a fire-cadence assertion** (folds the dropped R1.5 "turrets fire in pulses" — don't ship the new turrets stuttering).

**WS-9 — Selection, stats & world indicators (R2.8, R2.30, R2.12, R2.20, R2.23).**
Root: stats panel polls ~1 Hz so it "pops in"; stats live in screen-space; no world-space battery/capital/out-of-power indicators; `pickEntity` skips asteroids (kind 0) and never scans `mirror.lingeringShips`.
Files: `src/client/render/pickEntity.ts` (+asteroid, +lingering), `EntityStatsPanel.tsx` (spinner/instant + asteroid mass/resources + lingering owner), `SelectionStatsSubsystem.ts`, `swarmSpriteUpdater.ts` (world overlays: battery charge bar, capital resource readout, out-of-power icon — slice already carries `storedPower`/`minerals`/`powered`).
Lock: `pickEntity` unit (pure) for asteroid + lingering; `structure-scenario` E2E screenshots for the indicators + world-space stats. Gate only if the snapshot slice gains fields (likely not).

**WS-10 — Placement UX (R2.1, R2.5, R2.3, R2.4).**
Root: **R2.1 CORRECTED (§A)** — it's pure client logic, not screenshot-primary: `pendingPlacementResolved()` (`structurePlacementClient.ts:85`) clears the ghost on a 3s-timeout OR real-arrival, a **unit-testable race**. Lock at unit (the resolve race; suspect the timeout-vs-RTT window or a snapshot-count mismatch); keep the screenshot for [V] sign-off only. Desktop drag (R2.5) needs a proper state machine: click → ghost follows the **window** pointer → right-click/Escape cancels, left-click places (suspected listener-on-canvas-not-window). Plus connection-range circle while placing (R2.3) + hover outline (R2.4).
Files: `structurePlacementClient.ts` (`pendingPlacementResolved`), `PixiRenderer.ts` (`routePlacementPointer`, `_placementFollowing`, `_placementGhost`), `pointerCapture.ts` (window-level listeners), `SelectionBracket.ts` (hover outline), `ConnectorRenderer.ts` (range circle at ghost).
Lock: **unit on the ghost-resolve race (R2.1 primary)** + a screenshot spec for [V] sign-off ("never disappears", user-mandated); extend `structure-placement-ghost.spec.ts` for follow/cancel/place + hover. No gate.

### Phase C — Living world, AI & lingering

**WS-11 🔴 — Wave re-qualify + warp indicator + AI re-tune (R2.24, R2.21, R2.25).**
Root: **R2.25 + R2.24 diagnoses CORRECTED (§A)** — `HostileDroneBehaviour.ts:476-499` already brakes/decelerates-to-standoff (so R2.25 is MIS-TUNING — reproduce the float, re-tune; NOT a DEEP rework) and `WaveDirector` already recurs via `waveCount` (so R2.24 is a re-qualify / readiness-latch issue, not dispatch-once). The genuinely-new, well-diagnosed work is the **persistent warp indicator** (R2.21 — the current `WarpInWarningBanner` is transient; build an always-mounted, colour-coded variant) and the **first-qualify toast** (R2.24 half).
Files: `WarpInWarningBanner.tsx` (persistent variant) + toast (NEW, solid); `FactionLedger.ts`/`Faction.ts` + `WaveDirector.ts` (re-qualify latch — repro first); `src/core/ai/HostileDroneBehaviour.ts` (re-tune after repro, not a rework).
Lock: banner component test (idle = empty, colour by relation); integration `livingWorldDirector.test.ts` extended (neutral re-qualifies + returns after interval; toast fires once on first qualify). For R2.25, an `HostileDroneBehaviour.tick` assertion is only valid AFTER an on-device repro pins the actual mis-behaviour — a naïve "stops in range" lock passes today (§A).

**WS-12 🔴(partial) — Lingering ships: forever + live re-entry pose + render (R2.26-linger, R2.33, R2.32).**
Root: `OwnerlessShipEvictor` evicts on `LIMBO_DISCONNECT_TTL_MS` (15 min) → never-expire the lingering branch (respect `LIMBO_MAX_ENTRIES=10k`). **R2.33 CORRECTED (§A)** — the rebind path (`SectorRoom.ts:3232`) already reads LIVE SAB; the fresh-spawn-restore path (`:3435`) reads the frozen pose. Reproduce to find WHICH reconnect path the user hit, fix that one. **R2.32 SPLITS by layer (§C)**: "shields still present (invisible)" is SERVER state [L, 🔴]; "weapons don't render" crosses the `WorkerRendererClient↔worker` structured-clone boundary [V — the test MUST cross the worker boundary].
Files: `OwnerlessShipEvictor.ts`/`LeaveHandler.ts` (never-expire), the identified restore path, `PixiRenderer.ts` `updateLingeringShips` + `MountVisualManager`/shield aura.
Lock: integration `lingering.test.ts` (no eviction; the correct restore path uses live post-bump pose) via `lingerMs` + `galaxy-test`; server lock for lingering shield-state; **worker-boundary** E2E (probe page) for weapon/shield render — NOT a unit test on the renderer class (2026-05-14 incident class).

### Phase D — Quick visual/UX fillers (interleave between heavy workstreams)

**WS-13 — Build speed-dial UX (R2.6). QUICK, pure React.** Labels always visible; stay open across placements; toggle open/closed; icon = drilled-down selection + a back arrow (tree nav). File: `SpeedDialMenu.tsx`. Lock: extend `speed-dial.spec.ts`. No gate.

**WS-14 — Misc visual + transition (R2.9, R2.7, R2.26-curtain). QUICK.** Remove the warp bloom/glow from the warp-in path (`WarpFilterChain.ts`/`warpParams.ts` — keep a single subtle arrival reveal); fix map sharpness (`GalaxyMapLayer.ts` — renderer `resolution`/`antialias`); fix the ship-change curtain flash by raising the curtain *before* the destination reveal (`PixiRenderer.setLoadCurtain` + `useWarpOrchestration.ts`). Locks: warp-param unit + screenshot; map-config unit + screenshot; curtain-sequence screenshot. No gate.

---

## Dependencies & sequencing notes

- **Asteroid model is a FRONT GATE (§B.1), not punted.** WS-2's "missiles hit asteroids" half (symptom 2) and WS-4 (mining entity) both hinge on one decision: *are asteroids damageable, mineable-only, or both, and do projectiles/beams detonate on them?* Today they're HP-immune (`EntityResolver.ts:156`). **Produce `docs/architecture/asteroid-interaction-model.md` (short ADR) + user sign-off BEFORE either lands.** WS-2's homing + lingering-hull + detonate-despawn halves have no such dependency and ship in Phase A; only the `kind===0`-skip removal waits on the ADR.
- **WS-8 (new turrets)** depends on WS-3 (beam), WS-2 (missile spawn) and WS-5/6 (structure plumbing) — schedule after them.
- **WS-9 (world indicators)** reads cleaner after WS-7 (orientation) and WS-5/6 (grid/visuals) land.
- **DEEP items (WS-4, WS-5)** get their own sub-plan (written when we reach them) before any code — they introduce a new mechanic or change an invariant. (WS-11 is **no longer DEEP** — §A downgraded R2.25 from a steering rework to a re-tune; the new work is the warp indicator + toast.)
- **Reproduce-first items (§A):** WS-3 (R2.28), WS-7 (R2.13), WS-10 (R2.1), WS-11 (R2.24/R2.25), WS-12 (R2.33) — the executing agent MUST reproduce on-device and re-diagnose before writing the lock; the inline diagnosis was falsified by the red-team.
- **QUICK fillers (WS-7, WS-13, WS-14)** are low-risk and can slot between heavy workstreams to keep a steady cadence of green PRs.

Recommended order: **WS-1 → WS-2 → WS-3 → WS-4 → WS-5 → WS-6 → WS-7 → WS-8 → WS-9 → WS-10 → WS-11 → WS-12**, with WS-13/WS-14 interleaved as buffers.

---

## Verification (per workstream + at the end)

- **Inner loop (every commit):** `pnpm typecheck && pnpm lint && pnpm test`.
- **Server-touching workstreams:** boot smoke — `timeout 8 pnpm dev:server` must print `INFO: EQX Peri server started port: 2567` with no uncaught exception (kill any stale 2567/5173 listener first).
- **Targeted E2E (outer loop):** run only the new/changed spec, narrowed, e.g. `pnpm e2e --project=chromium tests/e2e/<spec>.spec.ts --reporter=line` with an explicit Bash timeout ~1.5× expected; screenshot specs for R2.1/R2.13/R2.19/R2.26 as the user asked.
- **Netcode-health gate (🔴 workstreams):** `pnpm e2e:netgate` — baseline-relative-green; report the metric + magnitude, never predict from the diff.
- **On-device confirmation:** after each phase, the user smoke-tests the relevant flow; any new bug found becomes a fresh failing-test-first lock (Invariant #13) before its fix.

---

## Appendix A — Round-1 items NOT in Round 2 (out of scope; pull back in if still seen)

Round 2 either supersedes or marks these resolved. Flagged so nothing is silently dropped:
- **Fly-into-capital collision** (R1.4) — Round 2 (R2.13) says "the collision box is mostly right… the capital works." Structures already have Rapier colliders (`SwarmSpawner.spawnStructure` → `spawnObstacle`; `tests/e2e/structure-ram-blocked.spec.ts` exists). Treat as resolved; the residual is the turret/miner *orientation* (WS-7).
- **Defence turrets fire in pulses** (R1.5) — not re-reported in Round 2.
- **Building health doesn't show at all when selected** (R1.3/R1.8) — Round 2 (R2.8) reports it shows but *slowly* (covered by WS-9).
- **Drones spawn instantly in Sol, no warp-in** (R1.12) — superseded by the merged `feat/drone-warp-in-director` (edge-only ingress + ~5-min spool); the live concern is wave *recurrence* (R2.24, WS-11).
- **Mobile one-input-at-a-time** (R1.1) and **respawn-as-existing-ship locked** (R1.6) — not re-reported in Round 2. *(Both are real-feeling and have known fix patterns — say the word and I'll add a WS-15 (mobile multitouch) and WS-16 (respawn lock) to scope.)*

## Appendix B — Code that already exists in this area (reproduce against it; do NOT assume fixed)

These items have partial implementations in the tree. That is **context for where to look**, not permission to skip — the user still sees the bug, so the implementation is either incomplete, mis-tuned, or failing at a layer the existing code doesn't cover. **Reproduce the reported symptom first** (Invariant #13). If the manual repro *still shows the bug*, the existing code is the starting point, not the answer. Only if a real manual repro *cannot* reproduce it do we mark it fixed — and we say so with the steps we tried, never on the strength of a green test.
- **Missile interpolation** (R2.22 jitter half) — `MissileMirror` already has a per-missile pose-ring + display-delay interpolation. If it still jitters on-device, the cause is elsewhere (homing path, server cadence, teleport guard) — find it by reproduction.
- **Placement pending-ghost** (R2.1) — `structurePlacementClient.PendingPlacement` holds a dim ghost (3 s timeout). The user reports vanish *still happens*, so reproduce on-device + capture screenshots; the gap is likely the timeout window, a snapshot-count mismatch, or the ghost not covering the full RTT.
- **Ram-damage floor** (R2.31) — `Ramming.ts` already zeroes below 50 u/s; WS-1 is a *refinement* (add mass-ratio + reverse-square), not from-scratch.
- **Structure colliders** (Appendix A) — present server + client predWorld; the residual Round 2 complaint is orientation (WS-7), not collision.
