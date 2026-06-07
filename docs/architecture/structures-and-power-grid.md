# Structures & the power grid (system internals)

*Player-facing guide: [../features/building.md](../features/building.md). Roadmap:
[../plans/speed-dial-resource-structures.md](../plans/speed-dial-resource-structures.md).
This doc grows per phase; it currently covers Phases 1–2 (shipped) and outlines 3–5.*

Structures are **server-authoritative** placeable world objects that ride the
**Generic Entity Pipeline** (`src/core/entity/`): a structure is the existing
pose-core **kind byte 2** (`StructureEntity` leaf + the kind-2 registry
descriptor). The whole base-building layer reuses that machinery — the only
structure-specific server line on the hot path is seeding `swarmHealth`.

## Catalogue (`src/shared-types/structureKinds.ts`)

The single source of truth for structure types, the analogue of
[`shipKinds.ts`](../../src/shared-types/shipKinds.ts). **Append-only** (invariant
#11): `STRUCTURE_KINDS_LIST` order is the wire subtype-byte index — adding a kind
appends a record + bumps `STRUCTURE_KIND_CATALOGUE_VERSION`; never reorder/remove.

Five kinds — `capital`, `connector`, `solar`, `miner`, `turret` — each carrying
`radius`, `maxHealth`, `maxConnections`, `isHub`, `powerOutput`,
`powerConsumption`, `storageCapacity`, `constructionCost`, `color`, and the
type-specific optional fields (`miningRate`/`miningRange`,
`weaponRange`/`fireRateMs`/`weaponDamage`, `mounts`). Helpers mirror shipKinds:
`getStructureKind`, `isStructureKindId`, `structureKindToIndex`,
`structureKindFromIndex` (all forgiving — unknown ids fall back to the Capital).

**Hub model (eqx-peri verbatim):** at least one endpoint of every connection
must be a hub (Capital `maxConnections:4` / Connector `:6`); leaves cap at 1 and
attach only to a hub. The grid that enforces this lands in Phase 3.

## Wire (the shared `shipKind` byte)

A structure's subtype rides the **same `shipKind` u8** that drones use in the
binary swarm wire (`swarmWireFormat.ts`) — demuxed on the pose-core `kind` byte:

- **Encoder** (`BinarySwarmBroadcast`): `kind===1` → `shipKindToIndex(rec.shipKind)`;
  `kind===2` → `structureKindToIndex(rec.shipKind)`; asteroids write 0.
- **Decoder** (`BinarySwarmDecoder`): `kind===1` → `shipKindFromIndex`;
  `kind===2` → `structureKindFromIndex`; asteroids ignore the byte.

**No stride / `SWARM_WIRE_VERSION` bump** — the byte already existed. The
`EntityKindRegistry` structure descriptor's `preservedFields` is
`['kind','shipKind']` so the subtype survives the client's per-frame mirror
rebuild and drives the silhouette.

## Placement (server, Phase 2)

`place_structure` / `remove_structure` are zod-validated client messages
(`src/shared-types/messages/clientMessages.ts`, `.strict()`). `SectorRoom`'s
handlers resolve the owner (`sessionToPlayer`) and delegate to
[`StructurePlacementSubsystem`](../../src/server/structures/StructurePlacementSubsystem.ts)
(decision logic over injected hooks — spawn / health-seed / despawn / clamp / id —
so it unit-tests like `TransitOrchestrator`):

- Validate kind, clamp to `SECTOR_PLAYABLE_HALF_EXTENT`, reject footprint overlap.
- **Blueprint model:** every structure lands at `SCAFFOLDING_HP_FRACTION` (10 %)
  HP, `isConstructed:false`, non-operational. The **Capital** is the exception
  (`constructionCost===0` ⇒ pre-built, full HP) so the first builds have a bank
  to draw from. Placement does NOT pre-charge minerals — the cost is drained
  *during* construction (Phase 3), so a blueprint can be placed with an empty
  bank and waits.
- Spawn the kind=2 swarm entity (`SwarmSpawner.spawnStructure` now carries the
  subtype id onto `rec.shipKind`), seed `swarmHealth` (presence = damageable
  through the unchanged `DamageRouter` 'swarm' strategy) + `swarmShield=0`.
- Record ownership + construction state in
  [`StructureRegistry`](../../src/server/structures/StructureRegistry.ts).
  `remove` is owner-gated (anti-grief).

`SectorRoom._internals` exposes `structureRegistry` + the swarm record's
`shipKind` for the integration test.

## Client render + UI (Phase 2)

- **Silhouette:** `render/pixi/swarmSpriteUpdater.ts` branches `kind===2` to
  `buildStructureGfx(entry.shipKind, radius)` — a regular polygon tinted from the
  catalogue `color`, sided per subtype.
- **Mount visuals (barrel / drill):** the same `kind===2` branch routes
  mount-carrying structures (TURRET `barrel`, MINER `drill`) through
  `MountVisualManager.ensureForMounts(spriteKey, sk.id, sk.mounts, sk.color,
  sprite)` — the SAME barrel + aim-line cluster the drone/player turret mounts
  use, but taking the mounts + flat `StructureKind.color` directly (structures
  have no `shape.color`). **Structures carry no `mountAngles` on any wire** (the
  slice ships only `turretTargetId` / `miningTargetId`), so the barrel angle is
  **derived client-side** from the target entity's resolved mirror pose via the
  canonical aim convention (`atan2(-dx, dy)` → arc-local `wrapPi(bearing −
  bodyAngle − baseAngle)` → `clampToArc`), then handed to `applyMountAngles`
  (single Pixi Y-flip, identical to the player/drone path — a sign error points
  the barrel 180° away). It SNAPS per frame (no client-side per-tick mount state
  for structures). Before this landed, structures were gated out of the mount
  branch (`kind===1`-only), so a turret rendered as a bare triangle with no
  barrel and a miner as a bare polygon — the 2026-06-07 smoke report.
- **Build UI:** the speed-dial **Build ▸** sub-menu sets Zustand `placementKind`;
  `StructurePlacementBanner` confirms/cancels. Confirm →
  `structurePlacementClient.placeStructureAhead(kind)` sends `place_structure` at
  a fixed clearance ahead of the local ship's mirror pose (the Phase-2 fallback
  coordinate model; the pure `computePlacementPose` is unit-locked). The full
  tap-to-position world ghost is a planned follow-up.

## The power grid (Phase 3 — shipped)

**Zone-pure core** (`src/core/structures/`):
- `Connection.ts` — an undirected intra-sector link (`getOtherNode`, flash
  window, `connectionLength`).
- `Grid.ts` — `canConnect` (the hub model: hub-required / per-kind
  `maxConnections` cap / edge-to-edge `CONNECTION_MAX_RANGE` / no-self/dup /
  line-of-sight), BFS connected components (**built-only — the dead-end rule:
  you can't relay THROUGH an unbuilt node**), power aggregation (`powered`
  requires a Capital in the component AND net ≥ 0), and A* routing + a route
  cache dropped on every rebuild.
- `structureGridConstants.ts` — `CONNECTION_MAX_RANGE`, `TRANSFER_PULSE_MS`,
  `CONSTRUCTION_PULSE_AMOUNT`, `REPAIR_*`, `DECONSTRUCTION_RATE_KG`,
  `CAPITAL_STARTING_MINERALS`, `FLASH_DURATION_MS`.

**Server** (`src/server/structures/`):
- `StructureRegistry` carries the connection adjacency (+ flat conn map),
  `topologyDirty`, and per-structure `minerals`; `remove()` severs (no leaks).
- `structureGridView.ts` projects each record → a `GridNode` (the
  `isConstructed` power gate lives here) and `autoConnectStructure` (nearest
  in-range hub, per-owner) runs on every place.
- `StructureGridSubsystem` — the 1 Hz `pulse()` (directly callable for
  deterministic tests; off the 60 Hz tick, `unref`'d): rebuild topology if
  dirty → **construction flow** (each blueprint drains up to
  `CONSTRUCTION_PULSE_AMOUNT` from a routable Capital; completion flips
  `isConstructed` + resets HP + dirties topology; dry source ⇒ pauses, no flag)
  → repair → deconstruction → connection flashes. `SectorRoom` runs the timer,
  rebuilds the `structures[]` slice, broadcasts `grid_pulse`, and severs on
  structure death via `evictSwarmEntity`.

**Wire** — `SnapshotMessage.structures[]` (slim, low-cadence, same array ref per
recipient, entityId-keyed → joins the swarm mirror for pose) +
`grid_pulse { flashed: [entityId,entityId][], material }` (discrete ≤ 1 Hz
flash event). **Netgate territory** (invariant #8) — these touch the
snapshot/broadcast path.

**Client** — `ColyseusClient.syncStructures` mirrors the slice into
`mirror.structures` + dispatches `gridNetPower` to Zustand; the `grid_pulse`
handler records `mirror.gridFlashes` (numeric pair key, alloc-free).
`render/pixi/ConnectorRenderer` draws the web (idle vs flowing alpha/width
pulse + glow, `connectorVisual.ts` pure params) + scaffolding/deconstruct bars;
`swarmSpriteUpdater` dims unbuilt blueprints; `GridPowerReadout` is the HUD chip.

## Mining (Phase 4 — shipped)

`StructureGridSubsystem.pulse()` gained two steps before construction: **mining**
(each built + **powered** Miner extracts `miningRate` from the nearest in-range
asteroid — `findNearestAsteroid` hook scans swarm kind=0 via the SAB pose — into
a local buffer capped by `storageCapacity`; mining never damages the asteroid,
effectively infinite first cut) and **transfer** (haul buffered minerals to a
Capital with free space along the A* route, capped by `CONNECTION_THROUGHPUT`).
Power-gated: an unpowered grid (e.g. Capital 50 − Miner 60 < 0) mines nothing.
The miner's `miningTargetId` (asteroid entityId) rides the `structures[]` slice;
the client draws the beam (`ConnectorRenderer`) and shows the bank in the HUD
(`gridMinerals` → the ⛏ chip). **Bespoke E2E trigger:** `structureGridPulseMs`
(testMode) overrides the wall-clock pulse interval so construction/mining
fast-forward — `testTimeScale` can't (it's physics-tick-only).

## Turrets (Phase 5 — shipped)

`StructureGridSubsystem.tickTurrets(nowMs)` runs on a faster `TURRET_TICK_MS`
(100 ms) timer than the 1 Hz pulse (SectorRoom owns it): each built + **powered**
turret targets the nearest drone in `weaponRange` (`findNearestDrone` hook →
`findNearestSwarmOfKind` over swarm kind=1 via SAB pose), aims (`turretTargetId`
on the slice → client aim line), and fires on its per-kind `fireRateMs` cooldown
(`applyDamage` + a `laser_fired` beam). It's a **bespoke fire path**, not
`AiFireResolver` (which targets players — turrets target drones). Power-gated: an
overdrawn grid (`powered === false`) fires nothing.

## Test scenario trigger (the bespoke E2E primitive)

The place-ahead UI stacks multiple placements at the same spot (overlap →
rejected), and construction takes seconds — both hostile to a deterministic E2E.
The fix is a **pre-built scenario trigger** (testMode room opts, seeded in
`onCreate` via `seedStructureScenario`): `prebuiltStructures` (placed through the
real subsystem, then forced `isConstructed` + full HP + auto-connected, owner
`scenario`), `scenarioDrones`, `scenarioAsteroids`. The `structure-scenario-test`
engineering room bakes a full powered grid (Capital + 2 Solar + Miner@asteroid +
Turret@drone) so the client E2E observes end states directly (power/minerals HUD,
drone death) with no UI-placement fragility or construction wait. `_internals`
adds `spawnTestAsteroid` / `spawnTestDrone` / `tickStructureTurrets` /
`pulseStructureGrid` seams for the integration suite.

**The structures plan is feature-complete (Phases 1–5).** Future polish (noted):
the tap-to-position world ghost, per-asteroid mineral depletion, manual
connect/disconnect UI, persistence of placed structures.

## Tests

- `tests/unit/structureKinds.test.ts` — catalogue golden + wire-index round-trip.
- Swarm wire round-trip locks in `BinarySwarm{Broadcast,Decoder}.test.ts`.
- `src/server/structures/StructurePlacementSubsystem.test.ts` — placement rules.
- `tests/integration/sectorRoom/structureEntity.test.ts` — full path: seed +
  player-driven `place_structure` (Capital pre-built / Connector blueprint→destroy).
- `src/client/structures/structurePlacementClient.test.ts` — placement geometry.
- `tests/e2e/structure-build-placement.spec.ts` — UI → wire → mirror.
- `tests/e2e/speed-dial.spec.ts` — the consolidated dial.
- `src/core/structures/Connection.test.ts` + `Grid.test.ts` — connection +
  the full `canConnect` rule matrix, components, dead-end, routing, route-cache.
- `src/server/structures/StructureGridSubsystem.test.ts` — auto-connect,
  construction build-up/pause/resume/dead-end, repair, deconstruction, power.
- `tests/integration/sectorRoom/structureGrid.test.ts` +
  `structureConstruction.test.ts` — the grid web + flow economy through the room.
- `src/client/render/pixi/connectorVisual.test.ts` — connector visual params.
- `tests/e2e/structure-grid-web.spec.ts` — slice + power HUD reach the client.
- `tests/integration/sectorRoom/structureMining.test.ts` — powered miner grows
  the bank / unpowered miner mines nothing.
- `tests/integration/sectorRoom/structureTurret.test.ts` — powered turret damages
  a drone / unpowered turret holds fire.
- `tests/integration/sectorRoom/structureScenario.test.ts` — the scenario trigger
  seeds a powered grid that mines + fires.
- `tests/e2e/structure-scenario.spec.ts` — grid power / mining bank climb / turret
  kills drone reach the client (via the pre-built scenario room).
