# Codebase anti-patterns review — guided by the bug-iteration docs (2026-07-16)

**What this is.** A diagnostic review of eqx-net driven by the two playtest-iteration Google Docs ("Equinox Tweaks / Improvements", 6 phases; "Equinox Bugs", 9 phases/rounds). Several issues in those docs recurred across **three or more failed fix attempts each** — that recurrence pattern is the review's signal. Part A grounds every recurring cluster in the current code (what's actually fixed, what isn't, and why the fixes kept missing). Part B names the systemic anti-patterns that *caused* the recurrences. Part C is a general sweep of each zone against the repo's own CLAUDE.md invariants. Part D is the prioritized work list.

**Method.** Three targeted exploration passes (weapons/scrap netcode, structures/UI, director/drones/galaxy) plus three per-zone invariant sweeps, with every load-bearing claim re-verified by direct read at head (`main` @ 0b0acdd). This review changes no code; each recommendation names its fix seam and the test level (per invariant #13) that would lock it.

---

## Part A — Recurring issues → grounded root causes

Legend: ✅ fixed at head (verified) · ⚠️ partially fixed / residual gap · ❌ open

### A1. Missiles: jitter, end-of-life freeze, pass-through ⚠️

**History:** 4+ iterations ("STILL jerky/jumpy/stuttery… multiple failed attempts… use a hostile agent, make no assumptions").

**Current state.** Missiles deliberately ride the 20 Hz JSON snapshot (`MissileSimulation.snapshotSlice`, `src/server/rooms/MissileSimulation.ts:509`), not the ~60 Hz binary swarm wire. The client now has a real interpolation path — `src/client/combat/MissileMirror.ts` implements a pose ring (depth 6, `src/core/contracts/IRenderer.ts:255`) + 100 ms display delay + curve dead-reckoning off a replicated `angvel` — mirroring the drone architecture. End-of-life freeze was addressed by broadcasting `missile_detonated` on lifetime expiry.

**Residual gaps.**
- `resolveMissileDisplayPose` pins to the oldest sample while `count === 1` (`MissileMirror.ts:244`) — every missile's first ~50-100 ms, and every re-entry into AOI, renders frozen-then-jumping. Drones never exhibit this because their cadence is 3× higher.
- `missile_detonated` is AOI-filtered independently of the pose slice — a viewer can hold a live mirror entry whose removal message was filtered out, reproducing the exact "stops moving, then fades" report via the extrapolation cap (`MissileMirror.ts:252`).
- Missile hit-testing is a **point sample** at the post-integration position (`MissileSimulation.ts:643-702`), unlike the projectile pipeline's swept-circle (`ProjectilePipeline.ts:185`). A fast missile steps past a radius-12 lingering hull between ticks — the "missiles pass through lingering ships" report is a real tunnelling hole. The lingering pass also skips silently while `lingeringPoseCache` has no entry (`MissileSimulation.ts:669`).

**Fix seams.** (a) Extrapolate forward from a single sample using its velocity instead of pinning; (b) route missile removal through the pose slice itself (absent-from-slice ⇒ despawn timer) rather than a separately-filtered event; (c) give `sweepCollision` the same swept-segment test the projectile pipeline uses. **Test level:** integration (`tests/integration/`) driving `MissileSimulation.advance` across a tick boundary with a small collider in the gap — the tunnelling assertion fails today by construction.

### A2. Scrap fly-through correction storms ⚠️ (architectural)

**History:** 2 reports, "top priority to identify and fix".

**Current state.** The Phase-5 desync fix landed: scrap is in predWorld, unlocked, byte-matched mass/damping/collider/collision-groups with the server (`src/client/net/entity/leaves/scrapClientLeaf.ts:45`, `src/core/geometry/scrapCollider.ts:27`), and `scrapClientLeaf.test.ts` locks "shove, don't bounce".

**Residual (architectural).** The client scrap body is a **kinematic follower snapped every frame to a ~100 ms-stale interpolated pose**, while the server's scrap is dynamic and accelerates away under ram impulse. On contact, the player's predicted deflection is computed against scrap that hasn't moved yet; the server computes it against scrap that yields. Every snapshot then reconciles that delta. This is tolerable for drones (players rarely ram them); scrap is *designed to be flown into*, so the same follower model guarantees correction spikes exactly during the cascade the user described. Also: `SCRAP_SPIN` (`src/core/geometry/scrapConstants.ts:32`) is a dead constant — zero usages; scrap never tumbles, and if someone wires server-side spin later without the client half it becomes a fresh desync source.

**Fix seam.** During local-player contact (contact event or proximity window), let the client scrap body run **dynamic** for N ticks (predicted impulse response) and blend back to the interpolated pose afterwards — or replicate scrap impulses in the input-ack stream so the reconciler accounts for them. This needs design, not a patch. **Test level:** `pnpm e2e:netgate` scrap-load scenario is the honest measure (its metrics are exactly `rollingCorrRate`/`maxDriftUnits`); a deterministic integration test can lock the contact-tick divergence bound.

### A3. Director / hostile drones ⚠️❌ (multiple distinct defects)

**History:** 6+ iterations; "you've assured me it's working multiple times".

Verified defects, each independent:

| Symptom (doc) | Root cause (code) | Status |
|---|---|---|
| "All attackers appear at the exact same spot NE of 0,0" | Combat **respawns** re-enter at `squadEdgePose` — a deterministic FNV hash of `squadKey:sectorKey` (`LivingWorldDirector.ts:1166`); only *live hops* carry the previous pose (`arrivalPoseFor`, `:1128`) | ❌ |
| "Squads of 8 but only 1-2 ever seen" | Members advance **independently** one graph hop per control tick (`advanceMembersTowardGoal`, `:943`); killed members respawn at galaxy edge and trickle back; no group-arrival primitive (the code's own comment admits "stragglers keep hopping in") | ❌ (unbuilt) |
| "Arrive but not hostile" | Hostile-at-spawn only marks when the arrival sector IS the wave target (`hostileSpecFor`, `:1102`); intermediate hops arrive neutral. Plus A4 below | ⚠️ |
| "None retreated / spread out weirdly" | `retreat` is a state flip + hostility purge only (`executeWaveStep`, `:900`) — no egress motion is commanded | ❌ (unbuilt) |
| "Barely move / brain dead / float sideways" | Combat thrust is per-kind `ai.thrust` decoupled from the player's `thrustImpulse` (`HostileDroneBehaviour.ts:538`); thrust applies along the *current* facing while the nose is still slewing (`:564`); roam leader throttled to 0.55 | ⚠️ (tuning + steering model) |
| "Never travel toward the player" | Waves target the **base sector** only — a player without a completed base is never hunted, and roam dwell is 6 min (`roamIntervalMs: 360_000`, `:239`). Partly by-design; diverges from the user's stated expectation | design gap |

**Fix seams.** Respawn should route through the same `arrivalPoseFor` carry-pose path as live hops; group arrival needs a rally/stage-then-breach step in `WaveDirector`; retreat needs an egress goal. **Test level:** integration on `LivingWorldDirector.tick` with a scripted squad (respawn pose ≠ constant; all members within R of target before attack phase), which is deterministic and cheap.

### A4. Hostility never reaches late viewers — event-only propagation ❌

**Verified.** Client hostility exists solely as an event-fed ledger: `bot_aggro` → `markHostile` (`ColyseusClient.ts:1997`) and `damage` → `markHostile` (`:2385`). **No snapshot carries a hostility bit** — not the binary swarm wire, not `SnapshotMessage.drones[]`. A player who joins mid-wave, or drops one packet, renders hostiles as neutral until the director's ~1.5 s re-pulse (matching the observed "sometimes flip to hostile on arrival"). This is the single highest-leverage netcode fix in the review: one bit on the slim drone slice ends a whole symptom family. **Fix seam:** add `hostileTo`/flag to `SnapshotMessage.drones[]` (slim-JSON discipline, no wire-version bump needed per the `level`/`mounts` precedent). **Test level:** integration — join a room with a pre-hostile drone (`startHostile`), assert first snapshot marks it.

### A5. Incoming-warp indicator ⚠️

**History:** 3 failed attempts ("ITS NOT F***ING WORKING!!!!").

**Current state.** The 4th architecture is correct in principle: every cross-sector departure registers in `IncomingRegistry` and broadcasts `warp_warning` to the destination room (`LivingWorldDirector.startSquadMemberTransit`, `:980`), with an always-visible banner (`WarpInWarningBanner.tsx`).

**Residual suspects (ranked).** (1) The broadcast only reaches rooms present in the director's `rooms` map — a room the director doesn't know about (created later, engineering/test rooms, `EQX_DISABLE_LIVING_WORLD`) receives nothing, silently. (2) `IncomingRegistry.register` returns **without broadcasting** when an identical entry exists (`IncomingRegistry.ts:79`) — one missed clear (`reconcileIncoming` sweeps at tick tail and can miss a squad object that's already gone) suppresses every subsequent identical warning. (3) The banner hides entirely under the load curtain. **Fix seam:** make the registry re-broadcast on re-register (idempotent client-side), and log a loud warning when a destination sector has no live room. **Test level:** integration across two rooms (the bug lives at the director↔room boundary — unit tests on the registry pass today and prove nothing, per invariant #13's "test where the bug lives").

### A6. Desktop placement drag / spectator placement origin ⚠️

**Current state.** The user's own diagnosis ("attach to the WINDOW mousemove, not the object") **is implemented** — window-level capture-phase pointermove on both render paths (`PixiRenderer.ts:1014`, `WorkerRendererClient.ts:264`), `pointerleave` a deliberate no-op. Third iteration.

**Residual (verified in code).** `commitChosenPlacement` falls back to `placeStructureAhead` → `computePlacementPose(mirror.ships.get(localId))` when no chosen point has round-tripped yet (`structurePlacementClient.ts:215,177`). In spectator mode `localPlayerId` still points at the dead ship (see A14), so a fast Confirm places the structure **at the tip of the previously-piloted ship** — precisely the Phase-5 doc report. **Fix seam:** `placeStructureAhead` must refuse (or use camera centre) when the local ship is not active. **Test level:** unit on the fallback decision + the existing `structure-placement-ghost.spec.ts` extended with a spectator case.

### A7. Structure vanish-then-reappear after placement ✅→⚠️

The dual-channel race (JSON `structures[]` count vs binary swarm pose arriving on independent cadences) is diagnosed *in the code itself* and gated correctly now (`pendingPlacementResolved` requires `allStructuresRenderable`, `structurePlacementClient.ts:101`). What remains is inherent: there is **no optimistic placement entity** — the dim ghost is cosmetic and the real structure waits a full server round-trip + two broadcast cadences. The doc's Phase-6 ask ("assume success, smooth it client-side") is the actual remaining work. **Test level:** E2E with a latency proxy asserting no frame gap between ghost-clear and sprite-draw.

### A8. Connector pulse / repair lines never idle ⚠️

Three documented iterations live in `connectorVisual.ts:296-302`. The current idle/active split works, but "active" is inferred from a **600 ms grace window after the last server flash** — not a real flow bit. Server-side, `processRepair` flashes on *every* 1 Hz pulse where `hp < max` and a funded route exists (`StructureGridSubsystem.ts:777`); a turret under sustained chip damage re-flashes forever — exactly "power lines STILL lit up constantly to defensive turrets". The landed `repairIdle.test.ts` only covers the hpGain ≤ 0 case, so the test guards the wrong boundary. **Fix seam:** flash only when `hpGain ≥ 1` (or a meaningful fraction), and/or carry an explicit `flowKind` so the client renders repair distinctly (the doc asked for green = healing). **Test level:** unit on `processRepair` with a perpetually-chipped structure.

### A9. Laser falloff / infinite beam ✅ (fragile)

Fixed on the 3rd iteration; the killer was `scale.x = worldLen` on a 256 px gradient texture (fade tail rendered 256× too long) — invisible to unit tests because headless falls back to a 1×1 `Texture.WHITE` (`BeamSpritePool.ts:90`). Now locked by `BeamSpritePool.solidTaper.test.ts` injecting a real 256 px texture. **Remaining fragility:** the client visual band (`VISUAL_BEAM_SOLID_FRAC`, `ColyseusClient.ts:182` + draw math `:4931`) and the server damage band (`falloff.maxRangeMul` in `WeaponCatalogue.ts`) are **two hand-synchronized constants with no shared source** — the next catalogue tuning desyncs them silently. **Fix seam:** derive the client draw band from the catalogue def (already imported client-side) instead of a parallel constant.

### A10. Collision damage / 0-damage pipeline ⚠️

Ramming tuning landed (`RAM_DAMAGE_MAX` 50→10, min-speed floor, mass-differential asymmetry, per-pair aggregation — `src/core/combat/Ramming.ts`), and the *server ram path* rounds-before-emit so 0-damage ram events never broadcast. **But the client has no guard**: `handleDamage` (`ColyseusClient.ts:2283`) unconditionally runs flash → damage number → health-bar hit → impact spark; a `DamageEvent` with `damage: 0` renders a "0" and sparks. Non-ram server sources don't round before broadcast (missile splash `MissileSimulation.ts:824`; mining chip `StructureGridSubsystem.ts:568`), so 0s still reach the wire. This is the doc's "the entire downstream damage pipeline fires even if its 0" — fixed on one side only (Part B, pattern 1). **Fix seam:** `if (evt.damage <= 0) return;` at the top of `handleDamage` AND a floor guard in the server's `applyDamage` broadcast. **Test level:** unit both sides (client handler with a 0 event; server splash resolving to <0.5).

### A11. Lingering ships ⚠️ (two confirmed server bugs)

- **Invisible shield — confirmed.** `tickShieldRegen` regenerates `ship.shield` gated only on `ship.alive` — `isActive` gates the collider swap and the broadcast but **not the regen** (`ShieldHullRouter.ts:232-252`). A lingering hull silently regenerates to full shield; hits land on a shield no one can see. One-line predicate fix.
- **Weapons never render — AMENDED during campaign 2.2 (2026-07-16): already fixed at head, by design.** Mount ticking does skip lingering hulls (they're in `lingeringSlots`, not `playerToSlot`) and no `mountAngles` are emitted — but that is CORRECT: a parked hull has no pilot and must not aim. The render half was fixed by R2.32: `PixiRenderer.updateLingeringShips` gives every parked hull its barrel cluster via `mountVisuals.ensureForShip`, frozen at baseAngle. The original review bullet over-claimed; no fix needed.
- Scrap-on-death for lingering hulls IS wired (`lingeringScrapOnDeath.test.ts`); the residual report likely hits the roster-row-deleted edge.
- Re-board position is live server-side (`lingeringPoseCache` updated per tick from SAB, `SabPoseMirror.ts:83`; `reclaimLingeringHull` re-anchors at it). If the stale-position symptom recurs it is client-side (camera glide target read from the throttled snapshot pose).

**Test level:** integration — damage a lingering hull, advance N ticks, assert `shield` unchanged; snapshot contains `mountAngles` for a lingering entry.

### A12. Structure rotation snap / upside-down colliders / moving pylon ✅

All three verified fixed at head: odd-sided render verts are the Y-flip of the collider hull (`spriteBuilders.test.ts` lock); server structures spawn as **locked bodies** (`staticBody = kind === 2`, `SwarmSpawner.ts:348`, the P3.10 fix — comment cites the pylon bug verbatim); client locks its predWorld twin (`structureClientLeaf.ts:37`). Any first-frame angle wobble is the interpolation buffer settling and would be eliminated by the A7 optimistic-placement work.

### A13. Stat-card pop-in ⚠️ (ships only now)

Structures are fixed (slice-first reads, 150 ms poll, spinner only when nothing is known — `EntityStatsPanel.tsx:282-359`). **Ships still round-trip**: hp/shield come only from the server `entity_stats` push (`:363`), with no client-resident fallback, so ship health genuinely pops in ~150-350 ms. **Fix seam:** read ship hull from already-replicated snapshot state, keep `entity_stats` as refinement — the same pattern the structure branch already uses.

### A14. Spectator mode still tied to the old ship — confirmed ❌

`killEntity` deletes the sprite/body and flips `pilotMode='spectator'` but **never clears `mirror.localPlayerId`** (`ColyseusClient.ts:2394-2436`). Every dependent — halo ring centre, the Pilot button's "knows which ship", placement origin (A6), dead-player "warp here" — resolves the stale id. Spectator is a flag over intact old-ship session state, not a mode. **Fix seam:** sever/null the local-entity reference at death (one ownership site, mirroring `resetPredictionState`'s philosophy) and make each dependent null-safe; the dependents that *should* use the camera (ring centre, placement) get the camera pose instead. This is a small refactor with a wide symptom footprint. **Test level:** unit on the death path (localPlayerId cleared) + E2E: die → ring icons follow camera, warp-here disabled.

### A15. Galaxy map static data ⚠️ (deliberate stubs, now the bottleneck)

Live counts/presence/roster are real. What the docs keep flagging as "static" is two deliberate stubs: `resolveSectorOwner` unconditionally returns `NEUTRAL_OWNER` while accepting-and-ignoring its live-state argument (`sectorOwnership.ts:40-45`), so the entire galaxy is one territory that "breathes together" (the "statically grouped" report); and owner colour is stamped from the baked region faction (`LivingWorldDirector.ts:578`). These are documented v1 stubs — but they're now the oldest recurring complaint. **Fix seam:** implement `resolveSectorOwner` off the live state that's already passed in.

### A16. Structures lost on server reset ✅ (loss paths remain by policy)

Persistence is fully wired (`SectorPersistence.ts:92-237`: structures serialize with position/progress/level, hydrate re-places via the placement seam). Remaining loss paths are policy, not bugs: 60 s save cadence + hard crash loses ≤60 s of placements (graceful `onDispose` saves); a `CURRENT_SCHEMA_VERSION` bump discards **all** persisted sectors by design; 24 h staleness discards; engineering rooms (`sectorKey === null`) never persist. If "my base vanished" recurs, check the deploy log for a schema bump before debugging. **Recommendation:** persist-on-place (event-driven save for structures specifically) removes the crash window cheaply.

### A17. Starfield ✅

Coverage cutoff genuinely fixed (tile half-range sized to the live viewport, `lodStarfield.ts:46`; the prior "zero change" fix had only raised layer *alpha* — the docstring records the failure). Zoom jerkiness is explicitly deferred pending an on-device capture (client CLAUDE.md) — pinch is deliberately un-eased; not a starfield bug.

---

## Part B — Systemic anti-patterns (why fixes failed 3× each)

**B1. One-sided fixes to two-sided contracts.** The single most damaging pattern in the history. Instances: server ram 0-guard without the client `handleDamage` guard (A10); client beam visual band vs server damage band as parallel constants (A9); server dynamic scrap vs client kinematic follower (A2); `SCRAP_SPIN` defined but wired on neither side. *Rule to adopt:* any fix touching a value that exists on both sides of the wire must either move the value to `src/shared-types`/core and import it on both sides, or land with a test that fails when the two sides disagree.

**B2. Event-only state with no snapshot backstop.** Hostility (`bot_aggro`) and warp warnings (`warp_warning`) exist only as discrete events; late joiners and dropped packets never converge (A4, A5). The codebase already knows the correct pattern — `level`, `mounts`, `shieldDown` all ride the snapshot with emit-when-non-default discipline. *Rule:* any client-visible state must be reconstructible from (snapshot ∪ join payload); events are accelerants, not the source of truth.

**B3. Inconsistent liveness predicates across a ship's subsystems.** `ship.alive`, `isActive`, `playerToSlot` membership, and `lingeringSlots` membership each gate different per-tick loops. Lingering hulls fall through some gates and not others: shield regen runs (`!alive`-gated only) while mount ticking doesn't (`playerToSlot`-gated) — producing A11's invisible shield + dead turrets simultaneously. *Rule:* enumerate the liveness states once (active / lingering / dead) and make every `state.ships` loop declare which states it covers; a helper predicate per state kills the divergence.

**B4. Cache/pool slot reuse without full-key invalidation.** The server recycles dense u16 entityIds; the client sprite cache invalidates on pose-core `kind` only (`swarmSpriteUpdater.ts:116` stores `kind` in `spriteKinds`), so a recycled **structure→structure subtype** flip (connector→turret) keeps the stale silhouette — the "drones/structures appear as the last thing destroyed" report. *Fix:* key the cache on `kind:shipKind`. The same audit applies to any client cache keyed by entityId (`_swarmBodyKeyCache`, AI ledger ids).

**B5. Unit tests structurally blind to the bug class.** The beam bug "passed four rounds of screenshots" because headless texture fallback is 1×1 (`BeamSpritePool.ts:90`); the missile/scrap issues only manifest under real cadence + contact; the incoming-warp registry unit-tests pass while the room-map hole eats the broadcast. Invariant #13 already names this ("test at the level where the bug LIVES") — the recurrence log shows it being violated *before* #13 was written. The locks that finally worked (`solidTaper` with a real texture, netgate scenarios) are the template.

**B6. Stale-reference modes.** Spectator = a flag over old-ship state (A14). The same class produced the pre-welcome guard bug (client CLAUDE.md) and the transit prediction-state poisoning (reset-on-handoff rules). *Rule:* a mode transition that conceptually removes an entity must actually sever the reference at one ownership site, not rely on every consumer checking a flag.

**B7. Degenerate determinism in gameplay code.** `squadEdgePose` hashes `squadKey:sectorKey` to a bearing — deterministic and collision-free from the engine's view, but *every* respawned attacker materializes at the same world point forever (A3). Determinism is right for tests, wrong for spawn variety; the pose-carry path that already exists (`arrivalPoseFor`) is the correct source.

**B8. Dead knobs and accepted-but-unused parameters.** `SCRAP_SPIN` (zero usages); `resolveSectorOwner(liveStateByKey)` ignores its argument. Both read as "implemented" in a grep and mislead the next fix attempt. *Rule:* a stub that ignores its input gets a `// STUB:` marker or a thrown-on-use guard, never a silent pass-through.

---

## Part C — General sweep (zones vs their own invariants)

Each zone was audited against the repo's own CLAUDE.md invariants. Findings are ranked within zone; **spot-checked** = re-verified by direct read at head.

### C-core. `src/core` + `src/shared-types`

The hardest invariants hold cleanly: fixed timestep everywhere (#4), time abstracted behind the injected clock, no error-swallowing around state mutation, and the pooling in `HostileDroneBehaviour`/`AiController`/snapshot scratch is real.

1. **HIGH — per-step allocation in the physics worker hot loop** (spot-checked): `src/core/physics/worker.ts:305` allocates `new Map<number, number>()` **every 60 Hz step**, and `:361` a fresh `transitions` array + per-transition literals. This is the canonical #14 hot loop. Fix: module-scope scratch + `.clear()`.
2. **MED — the `// TODO: alloc-debt` convention has decayed to zero** in core/shared-types (and server — see C-server). Repo-wide the tag exists only twice, in `ColyseusClient.ts`. Invariant #14's tolerated-vs-new accounting cannot function without the tags; the promised lint rule is the durable fix.
3. **MED — invariant #3 holes**: `WelcomeMessage` and `ShipRosterMessage` are inbound server→client messages with **no zod schema** (`snapshotMessages.ts`, `rosterMessages.ts`); `welcome` is consumed by a raw cast (`ColyseusClient.ts:1313`). The 20 Hz `snapshot` perf carve-out is defensible but undocumented.
4. **MED — `STRUCTURE_KIND_CATALOGUE_VERSION` is write-only** (`structureKinds.ts:410`): nothing validates it on decode or on `restoreStructuresFromSnapshot`, unlike `SHIP_KIND_CATALOGUE_VERSION` (read by the roster drift handling). A structure-catalogue reorder would silently mis-attribute persisted subtypes. Fix: gate at snapshot hydrate like `CURRENT_SCHEMA_VERSION`.
5. **MED — duplicated cross-zone magic numbers** (B1 fuel): the ship collision radius `12` is exported as `SHIP_COLLISION_RADIUS` but re-hardcoded in `MissileSimulation.ts:655` and `SectorRoom.ts:3307` — and the flat 12 already mismatches per-kind colliders (the `shipKinds.ts:142` comment records the heavy-hull bug). The muzzle clearance `20` exists independently as client `BARREL_LENGTH` and a bare server fire-path offset, synced only by a comment. Fix: shared constants/accessors in core.
6. **LOW — `contactDrain.ts:81,102`** allocates the contacts array + per-contact literals while carrying a comment asserting the surrounding code is "allocation-free (Invariant #14)". `AiController.drainFireRequests` docstring claims "returns the live array to avoid allocations" while the body does `.slice()`.
7. **LOW — acknowledged dead weight**: `SCRAP_SPIN` (orphaned), `formation.ts` (whole module unused post-boids), `RespawnHandler.ts:99` seeds a flat `SHIP_MAX_HEALTH = 500` on respawn regardless of kind — the same per-kind-max bug class already fixed once on the spawn path.

### C-server. `src/server`

1. **HIGH — no error boundary on the authoritative loop or room timers** (spot-checked): the `setImmediate` sim loop calls `this.update()` bare (`SectorRoom.ts:2383-2394`), and the director's 1.5 s `setInterval(() => this.tick())` plus the structure grid/turret/selection timers (`SectorRoom.ts:1740-1756`) are equally unguarded. On this single-process host, **one throw in any subsystem is a whole-galaxy outage**. The log-and-continue discipline already exists in `SectorPersistence` and the snapshot send — it's missing exactly at the top-level loops. This is the cheapest severity-weighted fix in the whole review.
2. **HIGH — liveness-predicate divergence** (the B3 pattern, with the full table): `tickShieldRegen` gates on `!ship.alive` only; `tickEnergy` on `isActive && alive`; mount ticking on `playerToSlot` membership; the AI view on `isActive`. Confirmed consequence beyond A11: a lingering hull's shield value regenerates while its collider-restore is `isActive`-gated, so the physics body stays hull-exposed while the snapshot reports the shield up — a live visual-vs-collider desync. Fix: one shared `isSimulatable(ship)`-style predicate family.
3. **MED — the validation contract is half-implemented**: every `onMessage` does zod-parse-and-drop (good), but the "per-connection error counter + **sampled** warn" half exists nowhere — 17 handlers emit unsampled `logger.warn` per malformed packet, while their docstrings claim sampling. A malformed-packet spray is a log-amplification DoS. One shared sampler wrapper fixes all sites.
4. **MED — untagged hot-path allocations**: `MissileSimulation.lockOnTarget` builds a fresh candidates array + one literal per player/drone per re-acquire (the exact pattern `WeaponMountTicker` pools); `fillStructureTargets` pushes literals per structure per AI tick. Zero `alloc-debt` tags exist in the zone.
5. **MED — interest filtering is partial**: per-recipient snapshot slices iterate ALL ships/projectiles/missiles per client (`SnapshotBroadcaster.ts:629,697,718`) — O(clients × N) — while drones/asteroids use the 9-cell interest scratch. Fine at current scale; a known cliff for a busy sector.
6. **MED — wall-clock timers vs `testTimeScale`**: the turret tick (`TURRET_TICK_MS`) has no test override (documented) — accelerated tests under-represent turret DPS 10×; combines with finding 1 since these timers are also unguarded.
7. **LOW — director lifecycle latency**: `LivingWorldDirector` captures the room map + sector keys once at construction with no add/remove path; safe today only because galaxy rooms are eager-created and permanent (`autoDispose=false`). Also feeds A5 (a room the director doesn't know about never receives `warp_warning`).
8. **MED — more event-only state (B2)**: beyond hostility/warp warnings, the faction `underWave` state drives drone targeting but has no snapshot carrier — a late joiner has no authoritative "your base is under attack" signal beyond the one-shot toast.

### C-client. `src/client`

Confirmed healthy: no bus-subscriptions for positions in `render/`; the placement-drag window-capture fix landed on BOTH render paths with matching cleanup; `WarpInWarningBanner` renders an empty state rather than unmounting.

1. **HIGH — `localPlayerId` dangles after local death** (`ColyseusClient.ts:2394-2436`; the code-level root of A14). Currently masked by defensive `mirror.ships.has()` checks — a trap for every future reader.
2. **MED — sprite recycle invalidation is coarser than the cache key** (extends B4): `swarmSpriteUpdater.ts:116` compares pose-core `kind` only, but sprites are built from `(kind, shipKind, componentIndex)` — so drone→drone kind flips (fighter→heavy), structure subtype flips, AND scrap component flips on a recycled entityId all keep the stale silhouette. Fix: composite signature (the `mountSig` pattern).
3. **MED — Zustand spatial lint under-matches**: `devData.serverX/serverY/beforeX/...` and `arrivalTargetX/Y` live in the store under suffixed names the lint (exact-key match) can't see (`store.ts:141,176`). Runtime-safe today (gated, low-cadence) but the lint's false assurance is the risk. Fix: pattern-match `*X/*Y` suffixes in the rule.
4. **MED — ungated per-frame diagnostic allocations** in `updateMirror` (`ColyseusClient.ts:3766-3820`): the swarm near-enter/exit probes iterate all swarm entries every frame and build nested literals on transitions, with no `isDiagEnabled` gate and no alloc-debt tag.
5. **MED — `EntityStatsPanel` polls `setInterval(150 ms)` and re-renders unconditionally** (fresh object from `readData` every tick, no diff; docstring claims "~1 Hz" while the constant is 150 ms), with a per-poll inline `sx` on the hull bar (`:478`) against the sx-hoist rule. Fix: shallow-diff before `setData` + hoist the static sx.
6. **LOW — pooled scratch defeated by spread** (`_recPositionsScratch` spread into `logEvent` literals, `:3033,3061`); `MobileControls` joystick-zone sx not hoisted while its siblings are; worker-path placement pointermove allocates a spread per move.

### Cross-zone synthesis

- The repo's **strongest** discipline is exactly where its CLAUDE.md files are most specific (boundary imports, fixed timestep, one-pose-per-frame, bespoke test triggers). Its **weakest** points are contracts that require ongoing bookkeeping with no mechanical enforcement: the alloc-debt tag (decayed to 2 uses repo-wide), the sampled-warn contract (claimed in docstrings, implemented nowhere), and the write-only structure catalogue version. **Where an invariant has a lint/CI check it holds; where it relies on convention it has drifted.** The follow-up already promised in invariant #14 — the lint rule — is the pattern to generalize.
- One docs drift: the root CLAUDE.md tech matrix still lists `better-sqlite3`; the server zone migrated to `node:sqlite` (per `src/server/CLAUDE.md`).

---

## Part D — Prioritized recommendations

Ranked by user pain × recurrence × confidence. Each row is one PR-sized unit; per invariant #13, the failing test lands **before** the fix.

| # | Fix | Seam | Lock test | Effort |
|---|---|---|---|---|
| 1 | Hostility bit on the drone snapshot slice (kills A3-neutral + A4 outright) | `SnapshotBroadcaster` drones slice + `snapshotRemoteSync` | integration: join with `startHostile`, first snapshot marks hostile | S |
| 2 | Clear `localPlayerId` at spectator entry; null-safe dependents (A14, fixes A6 fallback too) | `ColyseusClient.killEntity` + camera-pose fallbacks | unit death-path + E2E ring/warp-here | M |
| 3 | 0-damage guard, both sides (A10) | `handleDamage` top + server `applyDamage` broadcast floor | unit ×2 | XS |
| 4 | Sprite cache keyed `kind:shipKind` (B4) | `swarmSpriteUpdater.ts:116` | unit: recycled id with subtype flip rebuilds | XS |
| 5 | Lingering-hull liveness audit: shield regen `isActive` gate + lingering `mountAngles` emit (A11, B3) | `ShieldHullRouter.tickShieldRegen`, `WeaponMountTicker`, `SnapshotBroadcaster` | integration ×2 | S |
| 6 | Wave respawn carries pose (A3 same-spot) + rally-before-breach step | `LivingWorldDirector.respawnStep` → `arrivalPoseFor`; `WaveDirector` stage | integration on director tick | M |
| 7 | Missile swept-segment collision + single-sample extrapolation + slice-driven removal (A1) | `MissileSimulation.sweepCollision`, `MissileMirror` | integration tunnelling test (fails today) | M |
| 8 | Repair flash only on meaningful hpGain; `flowKind` on the wire (A8) | `StructureGridSubsystem.processRepair` | unit: perpetually-chipped turret goes idle | S |
| 9 | Incoming-warp: re-broadcast on re-register + loud no-room warning (A5) | `IncomingRegistry.register`, director room map | two-room integration | S |
| 10 | Derive client beam band from the weapon catalogue def (A9 fragility, B1) | `ColyseusClient` beam draw math | unit: catalogue change moves both bands | XS |
| 11 | Ship hull in stats panel from replicated state (A13) | `EntityStatsPanel` ship branch | component test | XS |
| 12 | Scrap contact-window dynamic prediction (A2) — needs design | `scrapClientLeaf` / reconciler | netgate scrap-load + integration bound | L |
| 13 | `resolveSectorOwner` off live state (A15) | `sectorOwnership.ts` | unit + galaxy E2E | S |
| 14 | Persist-on-place for structures (A16 crash window) | `SectorPersistence` | integration: place → crash-sim → hydrate | S |
| 15 | Error boundaries on the sim loop + all room/director timers (C-server 1) — cheapest outage-prevention in the review | `SectorRoom` loop, `LivingWorldDirector.tick`, grid/turret timers | unit: injected throwing subsystem doesn't kill the loop | XS |
| 16 | Shared sampled-warn + per-connection error counter for all onMessage handlers (C-server 3) | one wrapper in `rooms/` | unit: N malformed packets → ≤ sampled warns | S |
| 17 | Physics-worker per-step scratch (C-core 1) | `worker.ts:305,361` | existing bench + allocation probe | XS |
| 18 | `WelcomeSchema` + `ShipRosterSchema`; document the snapshot carve-out (C-core 3) | `shared-types/messages/` | unit schema tests | S |
| 19 | Validate `STRUCTURE_KIND_CATALOGUE_VERSION` at snapshot hydrate (C-core 4) | `SectorPersistence.hydrate` | unit: mismatched version ⇒ fresh-spawn | XS |
| 20 | Shared `SHIP_COLLISION_RADIUS`/muzzle-clearance constants; per-kind radius at hit-test sites (C-core 5) | core combat constants + 3 call sites | unit: catalogue change moves all sites | S |
| 21 | Zustand lint: match `*X`/`*Y` coordinate suffixes (C-client 3) | `eslint.config.js` | lint fixture | XS |

Process recommendations (no code): adopt B1's two-sided-contract rule and B3's liveness-predicate enumeration as CLAUDE.md invariants; when a bug report survives a fix attempt, the *second* attempt must start by writing the failing test at a **different level** than the first attempt's tests (the missile/beam/incoming histories all show repeated same-level testing).

---

## Campaign ledger (2026-07-16 fix campaign, waves 0–6)

Updated as each PR merges. Wave assignment per the approved campaign plan; PRs run serially, stability first.

| Part D # | Wave/PR | Status |
|---|---|---|
| process rules → invariants #15-17 + #13 amendment | 0 | ✅ merged (#147) |
| 15 error boundaries | 1.1 | ✅ landed (#148) |
| 3 zero-damage guard (both sides) | 1.2 | ✅ landed (#149) |
| 16 sampled-warn wrapper | 1.3 | ✅ landed (#150) |
| 17 physics-worker scratch | 1.4 | ✅ landed (#152) |
| 1 hostility bit on snapshot | 2.1 | ✅ landed (#153) |
| 5 lingering liveness audit | 2.2 | ✅ landed (#154; A11 mountAngles half amended — see below) |
| 9 incoming-warp reliability | 2.3 | ✅ landed (#155) |
| 2 spectator severs dead-ship ref | 3.1 | ⚠️ partial — server slice (3.1a dead-warp gate) landed (#156); client `localPlayerId` sever still open (see below) |
| 4 sprite-cache composite key | 3.2 | ✅ landed (#157) |
| 11 stats-panel ship hull | 3.3 | ✅ landed (#158; re-scoped — see amendment) |
| 21 Zustand lint suffixes | 3.4 | ✅ landed (#159) |
| 6 respawn carries pose | 4.1 | ✅ landed (#160; epoch rotation, not carry — see amendment) |
| 6 rally-before-breach | 4.2 | ✅ landed (#161) |
| 8 repair-flash idle | 4.3 | ✅ landed (#162; flowKind half pre-landed — see amendment) |
| 13 resolveSectorOwner live | 4.4 | ✅ landed (#163) |
| 7 missile robustness | 5.1 | ✅ landed (#164) |
| 10 beam band from catalogue | 5.2 | 🔄 CI (auto-merge armed, #165; derivation pre-landed — see amendment) |
| 20 shared radius/muzzle constants | 5.3 | ✅ landed (#166) |
| 18 Welcome/Roster schemas | 6.1 | ✅ landed (#167) |
| 19 structure catalogue version gate | 6.2 | 🔄 CI (auto-merge armed, #168) |
| 14 persist-on-place | 6.3 | 🔄 CI (auto-merge armed, #169) |
| 12 scrap prediction redesign | — | **deferred** (user decision 2026-07-16; future design-first effort) |

### Campaign amendments (discoveries made while fixing — review corrections, per campaign principle 7)

- **#2 / 3.1 (spectator dead-ship ref) — split; client half open.** The severe, server-authoritative symptom ("I'm dead and it let me warp!") landed as 3.1a: `TransitOrchestrator` refuses a dead player's `engage_transit` via the `hasLiveHull` seam (#156, incl. the follow-up that relaxed the gate to alive-only — the first cut's `isActive` requirement broke PENDING pre-`client_ready` hulls, caught by a netgate-surviving CI failure). The review's client-side ask — clear/generation-stamp `mirror.localPlayerId` in `killEntity` — remains OPEN: it stays masked by the defensive `mirror.ships.has()` checks, still a trap for future readers. It needs its own pass over every `localPlayerId` consumer (camera pose, ring centre, pilot button, placement origin) and is the one Part D row the campaign leaves genuinely unfinished.
- **#11 / 3.3 (stats-panel ship hull) — re-scoped.** "Read ship hull from replicated state" is not implementable as written: `ShipRenderState` (the mirror the panel reads) carries no hull field for ships — hull % flows via `DamageEvent` → Zustand `hullPct` for the LOCAL ship only; there is no per-remote-ship replicated hull on the client. The panel's actual defects were re-render churn + per-render sx allocation: #158 landed diff-before-setState (`panelDataEqual`), hoisted sx, and an honest poll-cadence docstring.
- **#6 / 4.1 (respawn carries pose) — mechanism corrected.** The review proposed routing respawns through the live-hop `arrivalPoseFor` carry path, but respawns have no `BotCarry` (the bot died; entry-only-ingress means a fresh edge spawn, not a traversal arrival). The actual fix: `squadEdgePose` gains a time-epoch (`SQUAD_RESPAWN_EPOCH_MS` = 60 s) that rotates the squad's anchor bearing per epoch — the farmable fixed spawn point moves each minute while intra-epoch squad clustering is preserved (#160).
- **#8 / 4.3 (repair flash) — half pre-landed.** The `flowKind` green-repair-tint wire field had already landed with WS-D; the remaining defect was sub-1-HP repair slivers strobing the flash forever. #162 shipped `REPAIR_MIN_HP_QUANTUM` (repairs land in ≥1 HP quanta; below-quantum links go idle) and rewrote the WS-D "sliver always heals" lock to quantum semantics — a deliberate behaviour change.
- **#10 / 5.2 (beam band from catalogue) — derivation pre-landed.** `updateLiveBeam` already read `wdef.range` + `wdef.falloff.maxRangeMul` off the catalogue since P3.13; the real gap was that the derivation lived inline where no unit test could lock it. #165 extracts the `beamBands.ts` seam + the lock so a parallel constant can't silently return.
- **#5 / 2.2 (A11 lingering mountAngles) — half found already fixed.** R2.32 already gives parked hulls barrel clusters frozen at baseAngle (`updateLingeringShips` → `mountVisuals.ensureForShip`), and no `mountAngles` for a parked hull is CORRECT (no pilot ⇒ no aiming). #154 fixes the real A11 defect — invisible shield regen on lingering hulls — and amends A11 rather than re-fixing the render half.
