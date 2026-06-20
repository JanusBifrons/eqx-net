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
  **Structures spawn as LOCKED bodies (immovable, P3.10):** `spawnOne` flags
  kind-2 `staticBody`, threaded through `SPAWN_OBSTACLE` so the worker
  `lockBody`s it — the authoritative body had been dynamic + damping-0, so a ram
  drifted it forever ("I hit a pylon and it MOVED"). The client predWorld already
  locked structures (`structureClientLeaf` = `spawnObstacle` + `lockBody`); the
  server now matches. A locked body still blocks ships and keeps its mass (the
  ram-damage model is unchanged); it just can't be translated.
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
  `isConstructed` power gate lives here) and `autoConnectStructure` runs on every
  place, per-owner. **WS-5 R2.10 legality:** `canConnect` enforces
  capital-only-connectors (the Capital links ONLY to a Connector — keyed on
  `GridNode.isConnector`, so Shield Pylons do NOT count). **P3.2 — connection
  range is now UNIFORM** (`CONNECTION_MAX_RANGE = 600` for every kind; the R2.10
  Capital short-reach `CAPITAL_CONNECTION_RANGE` was removed — "everything has
  the same range connectors"). `GridNode.connectionRange` stays an optional
  per-kind override seam (`canConnect` still takes the `min` of the two
  endpoints) but no kind sets it today. **WS-5 R2.17
  multi-connect:** a placed structure links to EVERY in-range legal hub (not just
  the nearest) in `(edgeDistance, id)` order, capped by its own `maxConnections`
  AND the global `PLACEMENT_MAX_CONNECTIONS = 6` (re-checking `canConnect` each
  iteration against the live adjacency). A leaf (cap 1) still grabs only the
  nearest; wide hubs (Connector, cap 6) fan out. The client preview
  (`ConnectorRenderer.drawPlacementPreview`) mirrors this: GREEN would-connect
  lines capped at 6, the rest drawn RED **overflow** (`placementPreviewConnection
  Count` / `placementPreviewOverflowCount`). Multi-connect grows the
  `structures[].connTo` slice length → netgate applies (invariant #8).
- `StructureGridSubsystem` — the 1 Hz `pulse()` (directly callable for
  deterministic tests; off the 60 Hz tick, `unref`'d): rebuild topology if
  dirty → **construction flow** (each blueprint drains up to
  `CONSTRUCTION_PULSE_AMOUNT` from a routable Capital; completion flips
  `isConstructed` + resets HP + dirties topology; dry source ⇒ pauses, no flag)
  → repair → deconstruction → connection flashes. `SectorRoom` runs the timer,
  rebuilds the `structures[]` slice, broadcasts `grid_pulse`, and severs on
  structure death via `evictSwarmEntity`.
  - **WS-D (#12) — per-edge flow MATERIAL.** Each flow step now tags its flashed
    edges with a `FlowMaterial` (`Connection.ts`, append-only: `minerals`
    haul/reclaim, `repair` healing, `construction` building, `power` reserved).
    `pulse()` returns `flashed: [aId, bId, FlowMaterial][]` (per-edge, so a repair
    route + a haul route can light in the SAME pulse) plus a dominant `material`
    for the back-compat single field. **Repair routes already drop to idle** — a
    full-HP (`hp >= max`), unrouted, or dry-bank (`findStorageRoute` only returns
    a capital with `minerals > 0`, plus the `spend <= 0` skip) repair `continue`s
    before `flashRoute`, so `processRepair` only ever flashes when it genuinely
    heals (`hpGain` is the min of two strictly-positive values). _(An earlier
    `hpGain <= 0` guard was added here as a belt-and-braces lock but proved
    UNREACHABLE given those upstream guards — removed as dead code; the material
    tagging is the real deliverable.)_

**Wire** — `SnapshotMessage.structures[]` (slim, low-cadence, same array ref per
recipient, entityId-keyed → joins the swarm mirror for pose) +
`grid_pulse { flashed: [aId, bId, GridFlowMaterial][], material }` (discrete
≤ 1 Hz flash event; the per-edge 3-tuple is WS-D #12 — a legacy 2-tuple is
tolerated and defaults to the top-level `material`). **Netgate territory**
(invariant #8) — these touch the snapshot/broadcast path.

**Client** — `ColyseusClient.syncStructures` mirrors the slice into
`mirror.structures` + dispatches `gridNetPower` to Zustand; the `grid_pulse`
handler records `mirror.gridFlashes` (numeric pair key, alloc-free), the flow
direction (`gridFlowSrc`), AND the per-edge material code (`gridFlowMaterial`,
numeric via `flowMaterialToCode` — cheap clone across the worker boundary).
`render/pixi/ConnectorRenderer` draws the web (idle muted-blue vs flowing
alpha/width pulse + glow, tinted per-edge by material: **green = repair,
orange = minerals, cyan = construction** — `connectorVisual.ts`
`connectorVisualInto(..., material)` pure params) + scaffolding/deconstruct
bars; `swarmSpriteUpdater` dims unbuilt blueprints; `GridPowerReadout` is the
HUD chip.

**Defensive range circles (WS-D #21) — always-on for built turrets.** A weapon
turret's `weaponRange` (catalogue) was drawn only during the placement ghost.
`ConnectorRenderer.update` now draws a PERSISTENT faint range circle around every
BUILT structure whose kind has a `weaponRange` (turret / laser_bolt_turret /
missile_turret — NOT a Miner's `miningRange`, NOT a Capital/Solar), so the player
sees coverage at a glance. The radius is the catalogue `weaponRange` (known
client-side via `getStructureKind(a.shipKind)` — no wire); out-of-interest
structures are absent from the mirror, so they're omitted by construction;
unbuilt blueprints (no coverage yet) draw nothing. A distinct warm-red tint
(`BUILT_RANGE_CIRCLE_COLOR`, fainter than the cool-cyan placement ring) reads as
a "threat zone". Test hooks: `builtTurretRangeCount` / `lastBuiltTurretRangeRadius`
(+ the main-thread DEV hook `__eqxBuiltTurretRangeCount` for E2E on `?worker=0`).
The ring stroke params are written into a reused `_builtRangeVisual` scratch via
`builtRangeCircleVisualInto(out, scale)` (invariant #14 — called once per built
turret per frame inside the per-structure loop, so it must not allocate; the
allocating `builtRangeCircleVisualParams` wrapper is test-only, mirroring the
`connectorVisualInto` / `shieldWallVisualParams` pattern).

**Placement preview (WS-D #6) — solid vs dotted.** `ConnectorRenderer.drawPlacement-
Preview` draws **SOLID green** (`'selected'`) to the hub(s) the blueprint WILL
connect to on confirm (capped at the kind's `maxConnections` AND the global
`PLACEMENT_MAX_CONNECTIONS`) and **DOTTED green** (`'deferred'`) to in-range,
legal hubs that lost the multi-connect cap race (could-but-won't). RED stays for
hubs that CAN'T connect (LOS / range / capacity). Pixi v8 has no native dash, so
a `'deferred'` line is emitted as short segments from a scale-aware
`ConnectorVisual.dash {on, off}` pattern (`connectorVisual.ts`). Replaces the old
"green chosen + RED overflow" (the over-cap RED read as errors). Test hooks:
`placementPreviewSelectedCount` / `placementPreviewDeferredCount`
(`placementPreviewConnectionCount` / `placementPreviewOverflowCount` kept as the
back-compat aliases).

## Batteries — stored-power buffer (batteries plan — shipped)

The `battery` kind is a **leaf that stores power**. It produces and consumes
nothing itself; it banks a powered grid's surplus and gives it back during a
deficit, so a base survives a generation dip instead of browning out the instant
demand exceeds supply. Modelled on eqx-peri's `Battery`, adapted to eqx-net's
instantaneous (no-stored-power-until-now) grid.

**Catalogue** — `battery` carries `powerStorageCapacity` (the only kind with it;
absent ⇒ a kind can't store power). Like every leaf: `maxConnections 1`,
`isHub:false`, `powerOutput/Consumption: 0`.

**Runtime + pure math** — `StructureRecord.storedPower` (0..capacity) is the live
charge. The arithmetic is zone-pure in `src/core/structures/batteryPower.ts`
(`chargeStep` / `dischargeStep` / `drainPower` — the last is for the shield-wall
drain, a later feature). `Grid` gains `componentMembers(id)` + `forEachComponent`
(iterate a whole connected component once) — the primitive the battery pass needs
and the one the pure `Grid` lacked.

**The pulse step** — `StructureGridSubsystem.processBatteryPower()` runs each
pulse, BEFORE the power-gated steps so this pulse's mining/turret gating sees the
result. Per capital-connected component: a **surplus** (`netPower > 0`) charges
its batteries (even split across the not-yet-full, capped); a **deficit**
(`netPower < 0`) discharges them to cover the per-pulse shortfall — but only when
their combined charge can meet it in **full**, in which case the whole component
is marked battery-backed; otherwise it browns out and the batteries hold their
charge. Power units are per-pulse (same scale as construction/mining amounts).

**Effective power** — the subsystem's `powerSummaryFor` now returns the raw
generation `netPower` (can be negative while batteries carry the load) but a
**battery-backed `powered`**: true while stored charge covers a deficit. The
turret + miner gates and the snapshot slice read it, so the whole grid keeps
running off stored charge through a dip and goes dark when the batteries empty.
The pure `Grid.powerSummaryFor` stays instantaneous/raw (its golden tests hold);
the battery layer is entirely server-side.

**Wire + UI** — `SnapshotMessage.structures[]` carries `storedPower` /
`storedPowerMax` for batteries (no `SWARM_WIRE_VERSION` bump — JSON slice). The
client mirrors them into `StructureRenderState`; the click-to-inspect
`EntityStatsPanel` shows a **CHRG** bar (`data-charge-pct`). The build speed-dial
auto-lists the kind; the sprite is a boxy amber polygon.

## Shield Fence (shield-fence plan — shipped)

A `shield_pylon` is a HUB (so two pylons connect directly under the hub rule) that
projects a blocking **shield wall** in the span to a paired pylon. Ported from
eqx-peri's `ShieldWall`, built on the battery buffer above.

**The wall is a DERIVED collider, not a catalogue kind / not a swarm entity.** Its
geometry is computed on BOTH sides from the two pylon poses
(`core/structures/ShieldWall.ts` `wallGeometry` — the single source of truth), so
the server collider, the client predWorld collider, and the rendered span all
agree without shipping a variable-length entity. Pure pieces in `ShieldWall.ts`:
geometry, `resolveWallHit` (grid-power model), `isWallActive`, `wallPairKey`,
`rayCrossesSegment` (beam-vs-wall).

**Server — `ShieldWallManager`** (`src/server/structures/`): forms a wall when two
same-owner, **built**, connected pylons appear; tears it down when the pair breaks
(hooked into the grid pulse + the faster turret tick + `evictSwarmEntity`).
`update()` refreshes each wall's ACTIVE state (`powered && !stunned`) onto its
collider. **Damage (grid-power/stun):** a hit's `damage` is soaked by the grid
SURPLUS (free), then by component BATTERY charge (`drainComponentBatteries`);
overwhelming both **stuns** the wall for `SHIELD_WALL_STUN_MS` (collider disabled →
passable). (Deviation from eqx-peri: no transient power-SPIKE that browns out other
consumers — the surplus + batteries ARE the buffer.)

**Collider** — a new core `PhysicsWorld.spawnWall/setWallActive/removeWall` (a
static cuboid between the two poses) + worker `SPAWN_WALL`/`SET_WALL_ACTIVE`/
`REMOVE_WALL` commands. **Wall bodies live in a dedicated `wallBodies` map, NOT
`this.bodies`** — otherwise the worker's per-tick `getAllShipStates` SAB-write
iterates the slot-less wall. The same `spawnWall` runs in the client predWorld
(`ColyseusClient.syncPredWalls`) so the LOCAL player is predicted-blocked.

**Blocking** — ships are blocked free (the static body). Weapons are absorbed on
the MAIN thread (no live server Rapier world): the player + AI hitscan resolvers
gain `blockBeamAtWall`, and `ProjectilePipeline` checks `wallBlocksProjectile` —
both route to `ShieldWallManager.blockShot`/`blockProjectile` (a `rayCrossesSegment`
test over active walls) which absorbs the shot + applies the grid-power hit.

**Pylon undamageable while the wall is up (R2.18, WS-6)** — the two paths above
absorb a shot that geometrically CROSSES the span, but a shot (or ram) aimed at
the pylon BODY from an angle that misses the span used to hit the pylon directly.
Now the single choke point `SectorRoom.applyDamage` routes a hit on a
`shield_pylon` into an active wall via `ShieldWallManager.absorbForPylon` (which
delegates to the same `onWallHit` grid-power model, so body-directed and
span-crossing absorption drain the SAME component buffer and can both stun the
wall). The pylon takes 0 while protected; once the wall is stunned/unpowered it
is damageable normally. `absorbForPylon` checks ALL of the pylon's walls (a
3-connection pylon stays protected if any one is up) — distinct from
`wallStateFor`, which surfaces only the first wall for the snapshot slice. All
damage sources funnel through `applyDamage`, so ramming is covered too.

**AI** — drones target the solid **pylons** (`structurePriority('shield_pylon') = 2`)
via the existing faction/wave gate; the wall in the line of fire absorbs the shots.

**Wire + render** — two JSON `structures[]` fields on each pylon: `shieldWallTo`
(the paired pylon's entityId) + `wallActive`. The `ConnectorRenderer` draws the
span (active = 3 layered blue strokes; down = a dim flickering red line).

**Fixed alongside (root cause):** the swarm shield-REGEN pass borrowed a FIGHTER
shield for any DAMAGED structure (`getDroneShieldMax`/`getShipKind` fall back to a
ship) and posted `SET_HULL_EXPOSED`, corrupting the collider — the unified-entity-
hull "fly into a capital" bug. Pylons are the first structures the AI actively
shoots, which surfaced it; regen is now gated on `rec.kind === 1` (drones only).

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
