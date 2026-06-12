# WS-4 — Mining-laser entity (DEEP sub-plan)

Equinox Round 2 roadmap, R2.27 (aimable colliding mining beam) + R2.16 (mining-range indicator). Gated on (and honoring) the accepted **asteroid-interaction-model ADR** (`docs/architecture/asteroid-interaction-model.md`): asteroids are SOLID, INDESTRUCTIBLE, MINEABLE rock; mining depletes a FINITE `resources` pool (never HP); the mining beam is a visible aimable beam + a thin player-damage ray (~1–2 HP/tick), NOT a physics collider.

Designed + adversarially hardened against current `main` (workflow `wf_fc867a4b-4e3`). The hardening corrected three first-draft errors: (a) the client already renders `remoteLasers` via `BeamSpritePool` so the beam draws for free once broadcast; (b) structure beams render from **wire endpoints**, so no drill-mount slew is needed (would add an Invariant-#12 ownership site for no render payoff); (c) `BeamSpritePool.renderedFromX` is shared with the turret beam and can't isolate the mining beam in a test → use a dedicated mining pool.

## Current state (file:line)
- `StructureGridSubsystem.processMining` (`StructureGridSubsystem.ts:304-318`) adds a flat `kind.miningRate` to `rec.minerals` (storage-capped), **no resource pool, no beam** ("effectively infinite, first cut").
- `rec.miningTargetEntityId` is set each pulse + rides the `structures[]` slice as `miningTargetId` (`SectorRoom.ts:2575`).
- Turret bespoke-fire template: `tickTurrets` (`:129-158`) → `applyDamage` + `broadcastBeam` → `broadcast('laser_fired', …)` (`SectorRoom.ts:1583`), on `TURRET_TICK_MS=100ms` via `structureTurretTick` (`:2458`). Turrets broadcast **straight `rec.x,y → target`** (no mount slew).
- Client: `ConnectorRenderer.ts:148-159` draws a faint static line miner→target; **separately**, `_remoteBeamPool` (`PixiRenderer.ts:1154-1294`) already renders every `remoteLasers` entry via `BeamSpritePool`. A structure shooter renders from **wire endpoints** (`PixiRenderer.ts:1261` else-branch).
- Asteroids have **no** `resources`/`mass` field. `polygonArea` (`asteroidShape.ts:125`) is exported for an area-scaled deriver. `EntityResolver` returns `null` for `kind===0` (combat is already a no-op — combat must never deplete resources).
- `findNearestAsteroid` returns `{entityId,x,y}` (drops the registry id) → the draw-down hook must resolve `entityId→record` via `swarmRegistry.getByEntityId`.
- `broadcastBeam` hook signature has **no `mountId`** today (`StructureGridSubsystem.ts:85`) — append an optional one.

## Phases (each green + committable; 🔴 = `pnpm e2e:netgate` on PR CI)

**Phase 1 — finite asteroid resources (server, no wire).** Add `resources?`/`resourcesMax?` to `SwarmEntityRecord`; seed in `SwarmSpawner.spawnOne` for `kind===0` from a pure `asteroidResources(vertices)` deriver (area-scaled, reuse `polygonArea`). New `drawAsteroidResources(entityId, amount): number` hook (resolves the record via `swarmRegistry.getByEntityId`, decrements, returns drawn). `processMining`: `yield = min(miningRate, drawn)`; clear `miningTargetEntityId` when exhausted (so it retargets + the beam stops). Per-session pool (no persistence — flag persistence as follow-up). **Failing-first (unit):** a powered miner draws down a 2×`miningRate` rock, yields 0 on the 3rd pulse, clears the target — RED today (flat-forever drain).

**Phase 2 🔴 — `tickMiners` broadcasts the mining beam.** New `tickMiners(nowMs)` mirroring `tickTurrets`: for each built+powered miner with a target, `broadcastBeam(rec.id, rec.x, rec.y, astX, astY, astId, 'drill')` on a `MINING_BEAM_CADENCE_MS` gate; called from `structureTurretTick`. Append optional `mountId` to `broadcastBeam` + the `laser_fired` payload (turret keeps omitting → 'forward'; miner passes 'drill'). **No mount slew.** **Failing-first (unit):** a built+powered miner with an in-range rock broadcasts a `drill` beam; unpowered/exhausted/targetless does not; cadence gate suppresses duplicates — RED (`tickMiners` doesn't exist; mining is silent).

**Phase 3 🔴 — light player-damage ray.** New pure `src/core/combat/miningBeamHazard.ts` (`distancePointToSegment` + `playerInMiningBeam(...)`, scalar/alloc-free). In `tickMiners`, scan `playerToSlot` SAB poses; `applyDamage(playerId, minerId, perHit)` where `perHit = DPS × cadenceSec` (resolveTurretBeam-style). Constants `MINING_BEAM_PLAYER_DPS` + `MINING_BEAM_HALF_WIDTH` in a **core constant file** (no catalogue bump). NO worker collider. **Failing-first:** unit (point-to-segment cases) + integration (`connectActive` player parked on the beam line in `structure-scenario-test` loses hull over ticks) — RED (no path exists).

**Phase 4 — client mining-beam render.** Route `mountId==='drill'` beams into a **dedicated amber `_miningBeamPool`** (batches via shared `Texture.WHITE`); keep the faint `ConnectorRenderer` line as an always-on link hint. **Failing-first (e2e):** assert `_miningBeamPool.liveCount > 0` (or `remoteLasers.has(minerShooterId)`) — NOT the shared `renderedFromX`.

**Phase 5 — mining-range ring (R2.16).** `buildMinerRangeRingGfx` (faint dashed circle at `miningRange=800`), built once per miner sprite (not per-frame). Always-faint-when-built. **Failing-first (unit):** ring radius === miningRange.

**Phase 6 🔴 — asteroid `mass`/`resources` on a slim `asteroids[]` slice (R2.23 enabler).** Append optional `asteroids?: Array<{id, mass?, resources?, resourcesMax?}>` to `snapshotMessages.ts`; emit pooled in `SnapshotBroadcaster` ONLY for in-interest, mined (`resources<max`) rocks (mirror the `drones[].hp` emit-when-changed pattern) → **no `SWARM_WIRE_VERSION` bump**. Client mirrors it for WS-9's inspector. **Failing-first (unit):** a mined asteroid emits resources; a full one omits it.

## Risks / boundaries
- ADR boundary: `drawAsteroidResources` reachable ONLY from `processMining`, never the damage path (combat = 0 to rock). Code-review item.
- Invariant #14: per-tick player scan + beam endpoint math reuse module scratch; pooled `_asteroidsScratch` in the broadcaster.
- Netgate (Phases 2/3/6): new ~10 Hz/miner `laser_fired` + player-damage scan + slice add brush the broadcast path — PR CI runs it.
- Persistence of remaining resources across restart is OUT of scope (per-session reset; follow-up).
