# Playtest 2026-06-10 — bug analysis + resolution plan

> Source: the user's "Equinox Bugs" Google Doc (playtest 2026-06-10, recorded 2026-06-10/11).
> Analysed against `main @ ec69ce6` (includes structures-followups, tap-placement, wave-attacks,
> selection-stats/Item B5, and the squishy-canyon security work — the playtest ran on this code).
> Execution contract: **Invariant #13 — every bug gets a FAILING test before the fix, committed
> together.** Same handoff style as `docs/HANDOFF-smoke-followups-2026-06-06.md`.

## The 12 reported issues (user's words, abridged)

1. Input-hold bug: only one input at once on mobile; steering blocks buttons — "only the auto button is impacted".
2. "Connectors break between buildings... they just don't seem to connect sometimes."
3. "The health on buildings doesn't work when a building is selected."
4. "The collision boxes are just completely broken... you can fly right into a 'capital'."
5. "The defence structures fire in like pulses instead of constantly, like the player does."
6. "If you try to respawn as an existing ship you're just locked and broken" — needs a dedicated E2E.
7. "When you place a structure it just kinda vanishes then appears after a second or two."
8. "More stats are needed for buildings when selected" — build %, power, health.
9. Desktop build-drag breaks — user suspects update events on the object instead of window.
10. Missiles "should bias tracking the closest enemy a lot more".
11. Missiles "lag... like they only update 20hz" — smooth like drones/players.
12. Drones "spawn by default in the Sol sector... they should never just magically appear" —
    intended: enter at leaf sectors, ~5 min of warping to reach Sol.

User decisions taken during planning:
- **Turrets (5)**: NOT visual-only — all laser beam weapons work the same everywhere: constant
  visual AND constant small damage-over-time, exactly like players.
- **Missiles (11)**: backport the drone pose-ring interpolation to the JSON missile path (no wire bump).
- **Drone spawning (12)**: full phased design (the largest item).

---

## A. Quick wins

### A1. Mobile multitouch — AUTO button dead while steering (Issue 1)

- **Cause (confirmed)**: `src/client/components/AutoFireToggleButton.tsx:32-38` deliberately binds
  `onClick` ONLY (bare `onTouchStart` was reverted — it double-toggled because the synthesized click
  still followed). But mobile browsers synthesize clicks only for the PRIMARY touch — a second
  simultaneous touch (joystick held) never produces a click. FIRE/BOOST escape via `onTouchStart`
  (`MobileControls.tsx:194-219`); the SpeedDial was fixed with the suppress-window pattern.
- **Fix**: apply the `touchActivate`/`clickActivate` + `TOUCH_CLICK_SUPPRESS_MS` (700 ms) pattern from
  `src/client/components/SpeedDialMenu.tsx:68-93` to `AutoFireToggleButton` — extract a shared helper
  (e.g. `src/client/components/touchClickActivate.ts`) so both consumers use one implementation.
  `onTouchStart` toggles + suppresses the trailing synthesized click; `onClick` stays for desktop.
- **Tests (failing first)**: reuse `tests/e2e/speed-dial-multitouch.spec.ts`'s CDP two-touch technique
  (`Input.dispatchTouchEvent`, two touchPoints): touch A held on `mobile-joystick`, touch B taps
  `auto-fire-toggle` → `aria-pressed` flips EXACTLY once (locks the dead-button bug AND the historical
  double-toggle). Unit test the shared helper's suppress window.

### A2. Placed structure vanishes for 1–2 s (Issue 7)

- **Cause**: client clears the placement ghost the moment Confirm sends `place_structure`; the server
  entity only becomes visible once the swarm wire + `structures[]` slice catch up (slice rebuild rides
  the 1 Hz grid pulse) → worst case ≈ 1 s+ of "neither ghost nor structure".
- **Fix**: (1) server — `rebuildStructuresSlice()` synchronously in the `place_structure` handler after
  a successful spawn (verify; the gap suggests it's pulse-only today); (2) client — keep the ghost in a
  "pending" state (dimmer alpha) after Confirm, cleared only when the structure's entityId appears in
  `mirror.swarm` (or on a rejected/timeout ~3 s).
- **Tests**: extend `tests/e2e/structure-build-placement.spec.ts`: after Confirm, at every polled frame
  EITHER the ghost feedback (`data-placement-*`) OR the structure entity is present — no gap; structure
  visible within ~500 ms (use `?structureGridPulseMs=50`). Integration: handler rebuilds the slice in
  the same message turn (`_internals.getStructuresSlice`).

### A3. Desktop build-drag breaks (Issue 9)

- **Cause (matches the user's hypothesis)**: `PixiRenderer.routePlacementPointer` is fed by
  canvas-element listeners (`installCanvasEventListeners` / worker `forwardPointerEvent`). Fast drags
  leave the element (or another element captures the pointer) and move events stop — the ghost stalls.
- **Fix**: on pointerdown while placement is active, `setPointerCapture(pointerId)` on the canvas;
  release on pointerup. Keep the screen→world conversion renderer-side (the camera lives there — do NOT
  move `screenToWorld` to the main thread, per `src/client/CLAUDE.md`).
- **Tests**: E2E in `structure-placement-ghost.spec.ts`: pointerdown on the ghost, fast large-delta
  `page.mouse.move` path ending outside the canvas, assert `data-placement-world-x/y` tracked to the
  end point.

## B. Structures — functional bugs

### B1. Connectors intermittently fail to form (Issue 2)

- **Cause (confirmed)**: `autoConnectStructure` (`src/server/structures/structureGridView.ts:58-85`)
  runs ONCE at placement (`StructurePlacementSubsystem.ts:114` — obstacles ARE passed now, Item D
  shipped) and never retries. Failure modes that strand a structure unconnected forever: hub placed
  AFTER its leaves; asteroid line-of-sight block at placement time; target hub at `maxConnections`
  with a slot freeing later; collinear leaves blocking each other.
- **Fix**: add a reconnect sweep to `StructureGridSubsystem.pulse()` (1 Hz wall-clock, off the 60 Hz
  tick): for each structure with zero connections (and hubs below capacity), re-attempt
  `autoConnectStructure` with current obstacles. Cap attempts per pulse. Topology-dirty → slice rebuild
  so the client web updates.
- **Tests**: unit (`structureGridView.reconnect.test.ts`): leaf placed with no hub → hub placed →
  next pulse connects; hub-at-capacity → slot frees → reconnects. Integration via
  `_internals.pulseStructureGrid` on the seeded scenario.

### B2. Building health broken when selected + richer stats (Issues 3 + 8)

- **Root cause (FOUND, confirmed in code)**: an id-namespace mismatch between the wire and the mirror.
  `pickEntityAt` returns structure ids in mirror form `swarm-<entityId>`; `toSelectWire`
  (`src/client/net/selectionClient.ts:19-29`) strips the prefix and sends the bare numeric id; the
  server (`SectorRoom.resolveSelectionStats`, ~line 2542) resolves it fine and **echoes the stripped
  id back**. But `EntityStatsPanel.readData` (`src/client/components/EntityStatsPanel.tsx:72`) guards
  `selectionStats.id !== id` against the Zustand selection id — the UNSTRIPPED `swarm-<entityId>` —
  so for structures the guard never matches and the panel permanently renders the placeholder
  (`hpPct: 0`, name "Structure"). Ships work because their id (playerId) is identical in both forms.
- **Fix**: compare/store the wire id consistently — e.g. `readData` compares `selectionStats.id`
  against `toSelectWire(id, kind).id`, or the gameRafLoop bridge stores the wire id alongside the
  mirror id. One ownership site for the mapping (it already exists: `toSelectWire`).
- **More stats (Issue 8)**: `mirror.structures` already carries `buildPct`, `powered`, `netPower`,
  `connTo`, `minerals`. Extend `EntityStatsPanel` to merge the slice entry for the selected structure:
  show build % (blueprints), powered/netPower, minerals where relevant. No wire change needed for
  these; optionally extend `EntityStatsSchema` later if server-only fields emerge.
- **Tests (failing first)**: component test in `EntityStatsPanel.test.tsx` — feed `selectionStats` a
  stats packet with the WIRE id while the selection holds the MIRROR id; assert the hull bar reflects
  hp (fails today). E2E: extend `tests/e2e/entity-inspect.spec.ts` on `structure-scenario-test` —
  select the capital, assert non-zero hull bar + power/build stats visible.

### B3. Collision system misconfigured — capital fly-through is one symptom of a macro defect (Issue 4)

- **User's diagnosis (treat as the lead hypothesis)**: "the entire collision system, ships included,
  is not configured correctly. One macro issue is that it is not rotated correctly, the X or Y is
  wrong... clearest in the already existing E2E for the T-shape ship which doesn't work — they don't
  even spawn in right, let alone collide right. I think it's the exact same issue with the structures."
  This matches a known defect class: the game-space-Y-up vs Pixi/physics-Y-down seam (the
  `pixiY = -gameY` rule; the 2026-05-27 shield-test handoff found the Crossguard collider INSIDE the
  rendered silhouette — `docs/HANDOFF-collision-alignment-2026-05-27.md`). A sign/axis error in
  polygon-collider vertex transforms (or angle sign) sits invisible for circles (drones, asteroids)
  and catastrophic for polygons (T-ship, hulls, capital).
- **Approach (probe BEFORE fix, screenshot-grounded)**:
  1. Start from the failing `tests/e2e/t-ship-no-self-collision.spec.ts` + the `hull-collision-test` /
     `hull-collision-overlap-test` rooms. Use the T / upside-down-T designs with screenshot analysis
     (`?worker=0`): (a) does the rendered T spawn with the catalogue's orientation? (b) does the
     COLLIDER match the silhouette (drive a probe ship into each arm; record where contact actually
     occurs vs where it visually should)?
  2. Localise the transform error across the three sites — server worker collider construction
     (poly-decomp from `shipKinds` shapes), client predWorld collider construction, renderer
     (`buildShipGfxFromShape`, `pixiY=-gameY`, `sprite.rotation=-angle`). Expect ONE sign flip applied
     in some sites and not others.
  3. Structures case: failing E2E on `structure-scenario-test` — thrust at the capital ~2 s, assert
     BLOCKED (server `/dev/events` `collision_resolved`; `data-pred-stats.collisionEventsApplied`
     doesn't cover non-player-keyed bodies). Note both sides DO create bodies today (server
     `SwarmSpawner.spawnStructure` → `postSpawnObstacle`; client `structureClientLeaf.ts:22-32` →
     `spawnObstacle` + `lockBody`), so the defect is in geometry/config, not missing bodies. Also split
     player-placed vs seeded capital.
- **Fix**: correct the convention at ONE ownership site for the game→physics vertex/angle transform,
  unit-locked with ASYMMETRIC fixtures (a symmetric shape can't catch a mirror flip — the T exists for
  this). Re-run T-ship + structure E2Es as locks. **Do this FIRST among structure items** — collider
  geometry feeds connector line-of-sight (B1) and turret hit-tests (B4).

### B4. Turret lasers must use the SAME beam-weapon model as ships (Issue 5)

- **Decision (user)**: "laser turrets and all laser beam weapons should work the same everywhere —
  visually constant and damage constant, just like for players." Unify the mechanism; no special case.
- **Fix**: route structure-turret fire through the shared beam-weapon model instead of the bespoke
  600 ms `fireRateMs` pulse: bind the turret mount to a catalogue beam weapon (`WeaponCatalogue` def —
  same semantics ships use), fire on the standard beam cooldown (small damage per tick, continuous
  DPS) from `tickTurrets`, emit the same `laser_fired`/beam state the client already renders as a
  continuous beam. Retire `fireRateMs`-as-pulse for laser turrets; rebalance per-hit damage so total
  DPS ≈ today's unless asked otherwise. `TURRET_TICK_MS` (100 ms) stays as the targeting cadence.
- **Tests**: unit — turret fire path reads cadence + damage from the catalogue def; integration
  `structureTurret.test.ts` — drone takes N small hits over a window, not one 600 ms lump; E2E on
  `structure-scenario-test` — beam feedback present in ≥90 % of sampled frames while a hostile is in
  range.

## C. Respawn as existing ship → locked/broken (Issue 6)

**User's observed symptom (verbatim — it constrains the diagnosis)**: "the local player spawns in AS
the lingering hull on their computer, and can fire and try to accelerate... but nothing hits and the
ship doesn't move and snaps back. To another player it's just a static lingering hull — no clue
someone is trying to pilot it. So it's a server/client disconnect in behaviour, and server auth is
winning out." I.e. the client binds and predicts locally, but server-side the hull never becomes
ACTIVE — input lands nowhere, fire resolves against nothing, every snapshot reconciles the client
back to the static lingering pose.

- **Primary suspected bug — duplicate-bind / no-rebind to a lingering hull.** Resuming a roster ship
  whose hull is STILL LINGERING in the target sector takes the fresh-spawn shipId-restore path
  (`SectorRoom.ts` onJoin, ~3054-3109), which checks only `PlayerShipStore` — never "is this hull live
  in the room". It then `state.ships.set(B, …)` (~3233) clobbers the lingering ShipState under the
  same key while `lingeringSlots[B]`, the worker body `linger-B`, and the armed ownerless-evict timer
  all survive. Consequences (each reads as "locked and broken"): spawn inside a still-collidable
  orphan body (solver fight — pinned ship); the snapshot path can keep emitting an `isActive=false`
  record the client translator drops; the evict timer later DELETES the player's active ship.
  Reachable from any "resume a ship lingering in the target sector" (every alive-leave lingers 15
  min). Secondary candidates to cover in tests: rebind-path corpse (no `alive` guard ~2901),
  playerId-rotation race, stale 3 s roster poll. (Line numbers from pre-merge main — re-anchor on
  `ec69ce6` at implementation time; `SectorRoom.ts` gained ~345 lines in the wave-attacks merge.)
- **Tests FIRST (the user explicitly asked for a dedicated E2E)**:
  1. Integration `tests/integration/sectorRoom/resumeLingeringShipById.test.ts` (galaxy-keyed room,
     `harness.connectActive` — clients must send `client_ready`): fly B → displace to lingering via a
     new-ship join → rejoin with `shipId: B` → assert (fails today): `lingeringSlots` cleared of B; no
     armed evict timer; exactly one schema entry for B with `isActive===true`; no orphan `linger-B`
     worker body; **server-side pose changes under held input** (the user's symptom). Plus a
     died-first variant asserting `alive===true, health>0`.
  2. E2E `tests/e2e/linger/respawn-existing-ship.spec.ts` on the isolated `galaxy-test` room,
     docstring quoting the user's report: join → displace B to lingering (the `?newShip=1` dance from
     `spawn-swap-lingers.spec.ts`) → observer kills active ship (`initialHull:10, initialShield:0`) →
     death overlay → Respawn → pick B from the roster (add `data-testid="roster-spawn-<shipId>"`) →
     assert: `data-hull-pct > 0`; ship MOVES under held thrust; `data-pred-stats` healthy; observer
     sees exactly ONE hull for B.
- **Fix**: evict-then-restore in the onJoin shipId path — if the requested hull is live in the room
  (`ownerlessShips`/`lingeringSlots`/`state.ships.has`), synchronously run the existing
  `OwnerlessShipEvictor` teardown (despawns `linger-B`, cancels the timer, `markStored` with current
  pose), then fall through to the existing restore. Order: evict BEFORE `bindRosterEntry`/`markActive`.
  Plus: a tripwire guarding `state.ships.set` against duplicate keys (`logger.error` + serverLogEvent),
  the rebind-path corpse guard, and roster-panel refetch-on-mount (separate commit). Netgate not
  required (join path); 8 s server-boot check + integration suite are.

## D. Missiles (Issues 10 + 11)

### D1. Weak tracking

- **Cause**: `MissileSimulation.lockOnTarget` (`src/server/rooms/MissileSimulation.ts:476-520`) locks
  ONCE at launch via the shared `pickTarget` (previous-target-sticky, not closest-biased); lock loss →
  flies straight forever; `turnRate = 1.0 rad/s` (`WeaponCatalogue.ts:168`) = 400 u turn radius at
  400 u/s.
- **Fix**: (1) re-acquisition on lock death (re-run selection ~every 10 ticks, not per-tick);
  (2) closest-bias for missiles via per-weapon targeting options on the def (`targetBias: 'closest'`
  — distance-scored, no sticky hysteresis/health weighting) while turrets keep their profile;
  (3) modest `turnRate` 1.0 → 1.5 as a tunable (it was deliberately lowered for dodgeability — this
  is a gameplay-tuning knob, revisit after playtest).
- **Tests**: unit on `MissileSimulation` (pool tests exist): target dies mid-flight with a second
  hostile nearby → re-locks the closest; closest-bias picks near over far-previous. Integration
  `missileLifecycle.test.ts` extension. `pnpm e2e:netgate` (server tick path).

### D2. Client jitter (~20 Hz look)

- **Cause**: missiles ride the 20 Hz JSON snapshot with a 2-point prev/latest lerp
  (`src/client/combat/MissileMirror.ts`, `MISSILE_DISPLAY_DELAY_MS = 100`); no pose-ring buffer, so
  snapshot-cadence jitter shows through (drones solved this with `poseRing` + display-delay —
  `docs/architecture/drone-snapshot-interpolation.md`).
- **Fix (user-chosen)**: backport the drone pose-ring pattern into `MissileMirror` — per-missile ring
  (depth sized for 100 ms at the snapshot cadence; mind the ring-sizing lesson), fed in
  `applyMissileSnapshot`, read in `resolveMissileDisplayPose` at `now − 100 ms` with the teleport
  guard. Client-only, no wire change. Respect one-pose-per-frame.
- **Tests**: unit mirroring `tests/unit/swarmInterpolation.smoothness.test.ts` — jittered arrival
  times → resolved pose monotonic/smooth, no per-packet snap; ring-depth structural invariant.
  Netgate as cheap insurance.

## E. Drone spawning — never magically appear; enter at leaf sectors (Issue 12)

**⚠️ Re-anchor required**: the wave-attacks system shipped 2026-06-10 on `ec69ce6`
(`docs/features/wave-attacks.md`, `WaveDirector`/`SquadPool`/`SquadBehaviour`/`WavePattern` under
`src/server/livingworld/director/`, per-room `FactionLedger`, `WarpInWarningBanner`) and SUPERSEDES
the occupancy-driven hunter model this section's original design targeted. The playtest ran ON the
wave system. What the user's complaint decomposes to on the new architecture:

1. **Ambient per-sector drones are still boot-seeded fixtures** — spawned instantly in
   `SectorRoom.onCreate`, present in Sol from t=0, no warp-in. This is the "they're just there
   immediately" half.
2. **Wave squads spool ~5 min then warp in directly to the target sector** — they do NOT enter the
   galaxy at leaf sectors and traverse hops toward the player. Combined with (1), pressure feels like
   "a constant siege of endless drones" instead of phased, telegraphed attacks.

**Design (folds the original intent into the NEW director architecture — reuse, don't parallel-build):**

1. **Entry-sector metadata (pure)**: `GalaxySector.entrySector` flag (the 6 ring outers) +
   `getEntrySectors()` in `src/core/galaxy/galaxy.ts`; `pickEntrySector` in
   `src/server/livingworld/population.ts`. Unit tests.
2. **Hop-travel mechanism, default 0 (byte-equivalent)**: today the cross-room hop is instantaneous at
   spool end. Split depart/arrive (despawn source + stash carry → timer `hopTravelMs` → spawn at
   destination edge via the existing `LivingWorldBotHooks.spawnBot`, which already does sector-edge
   pose + `warp_in` + join-grace; arrival `hasFreeSlot` check with self-heal to respawn). Applies to
   BOTH squad warps and any remaining singleton-bot movement. Dispose clears timers.
3. **All drone entry routes through entry sectors**: squad spawns/respawns materialize ONLY at entry
   sectors, then traverse the galaxy graph hop-by-hop toward the target base sector (dwell + spool +
   travel per hop). Leaf→Sol ≈ user's ~5 min via 3 constants (`hopTravelMs` ~60 s, dwell ~180 s,
   spool — `EQX_BOT_SPOOL_MS` already exists as the squad-spool override). The
   `WarpInWarningBanner` countdown stays the in-sector telegraph for the FINAL hop.
4. **Retire ambient boot seeding**: galaxy rooms get explicit `droneCount: 0` (careful — the
   non-testMode room default is 30; omission regresses); ambient patrol presence (currently
   `AMBIENT_DRONE_FLOOR = 2`, neutral-until-shot) either folds into the director as an ambient pool
   (entry-spawned, slow random hops) or is dropped — decide with the user; engineering/test rooms keep
   local seeding (`dronePoses` etc.). `SectorPersistence` stops persisting `kind===1` rows; bump
   `CURRENT_SCHEMA_VERSION` 1→2 in `SectorSnapshot.ts` (clean reseed). Cold-boot empty interior is
   accepted per the user's intent.
5. **Invariant to lock**: in galaxy sectors, the ONLY drone-creation path is the director's
   edge-spawn-with-warp_in. Integration (via `bootLivingWorldTestServer` with tiny injected timings +
   seeded RNG): every `BOT_SPAWNED` sectorKey ∈ entry set; interior sectors reached only via
   despawn→(≥travelMs)→spawn pairs; galaxy rooms boot with zero drones; `EQX_DISABLE_LIVING_WORLD`
   still yields a fully peaceful galaxy. E2E: update `tests/e2e/wave-attack.spec.ts` for the
   entry-route; NEW invariant spec "drones never magically appear" — `/dev/events` `bot_spawn` rows
   all in entry sectors + client `warp_event` correlation. Fast timeline via `EQX_BOT_SPOOL_MS` + a
   sibling `EQX_BOT_HOP_MS`-style boot env for a dedicated Playwright project.
6. **Open questions for the implementing agent to confirm with the user**: does the ~5-min total
   apply per-wave after the first (or do later waves pre-stage closer)? Should ambient neutral
   patrols survive at all? One netgate run at the end (population churn brushes the swarm broadcast).

## F. Cross-cutting execution guidance

- **Invariant #13**: failing test BEFORE fix, committed together, every item.
- **Order**: A1, A2, A3 → **B3 first among structures** (collision macro defect — collider geometry
  feeds B1 line-of-sight and B4 hit-tests) → B2, B1, B4 → C → D1+D2 (one netgate run) → E (own PR
  series, re-anchored on the wave-attacks architecture).
- **Netgate required**: D1, D2, E (B3 only if the fix touches snapshot encoding). Per standing
  preference: local loop = typecheck + new tests + lint; full suite + netgate on PR CI.
- **Line numbers** in this doc were read on `6ec6e35`/`ec69ce6` — re-anchor with grep at
  implementation time; `SectorRoom.ts` moved substantially in the wave-attacks merge.
- **Docs**: B4, C, E warrant `docs/` updates; E updates `src/server/CLAUDE.md` +
  `docs/architecture/living-world.md`. CLAUDE.md currency rule applies per-PR.
- Out of scope (not in this bug list): the laser-detach fix still absent from main
  (`docs/HANDOFF-smoke-followups-2026-06-06.md`, Issue 1).
