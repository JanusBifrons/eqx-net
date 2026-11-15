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

**Zone-pure core** (`src/core/structures/`; it works over an abstract `GridNode`
view, never the server `StructureRegistry`):
- `Connection.ts` — an undirected intra-sector link (`getOtherNode`, flash
  window, `connectionLength`).
- `Grid.ts` — `canConnect` (the hub model: hub-required / per-kind
  `maxConnections` cap / edge-to-edge `CONNECTION_MAX_RANGE` / no-self/dup /
  line-of-sight), BFS connected components (**built-only — the dead-end rule:
  you can't relay THROUGH an unbuilt node; an unbuilt node is still a transfer
  destination, and this is load-bearing for the construction flow's outward
  expansion**), power aggregation (`powered`
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

**Active power (2026-11-01).** A structure draws its full `powerConsumption` only while it is working (a processor running, a drill on a rock, a turret with a target, a lab with a job) and 20 % of it when idle. The server flips `rec.drawFull` through `StructureGridSubsystem.setActive`, which adjusts the component's net power in O(1) (`Grid.adjustDraw`). Full story: [production-chains.md](production-chains.md#active-power-full-draw-only-while-working).

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

## Gates

Plan soft-leaping-truffle v2, phase V. Player guide:
[shield-gates.md](../features/shield-gates.md).

**Kinds.** `shield_gate` (320 × 72) and `shield_airlock` (320 × 260), appended
to the structure catalogue (no version bump: appending leaves saved rows valid,
and a bump would reset saved structures).

**Geometry** lives in one zone-pure module, `src/core/structures/gateGeometry.ts`,
read by both sides (#15):
- **Collider parts:** a gate's physics body is its posts (and an airlock's side
  walls) as separate convex parts (`gateColliderPolygons`, passed to
  `World.spawnObstacle(..., parts)`), on the server worker
  and the client prediction world, so the gap between them is open. Weapon hits
  test the same parts (`SwarmEntityRecord.boxes`, `rayHitsBox(..., boxes)`).
- **Spans:** the shield across a gap (`gateSpans`; gate: one, airlock: A at
  local +y, B at −y).
- **Anchors:** a fence wall ends on the gate post nearest its far end
  (`emitterAnchor`).

**Open/close** (`src/core/structures/gateLogic.ts`, server-only): occupancy is
built from ship positions in the gate's local frame. A gate opens while an
admitted ship is within `GATE_APPROACH_DEPTH` (300 u) of the span and closes
`GATE_CLOSE_HOLD_MS` after the zone empties. An airlock is one `phase` field
(closed / open A / open B), so both ends can never be open; it never closes an
end while a ship overlaps it. Locked by a fast-check property test.

**Server.** `GateController` steps every built gate on the 10 Hz structure tick
from the ACTIVE player ships (#17) and the gate's access setting
(`shared-types/gateAccess.ts`: owner + allies / owner only / anyone not
hostile; relations go through the B1 seam once it lands).
`ShieldWallManager` forms walls between ANY two connected built emitters
(pylons and gates) plus each gate's own spans; a span stops blocking while its
end is open. `wallsUpFor(id)` feeds `STRUCTURE_FLAG_WALL_ACTIVE`.

**Wire.** Room state `StructureState.gateOpen` (open bits) and `gateAccess`;
`set_gate_access` message (owner-gated). Access persists in the sector snapshot.

**Client.** `src/client/structures/derivedWalls.ts` derives every wall (fence
walls + spans) from the mirror with the server's rules; the renderer draws from
it and the prediction world collides with it. This replaced the per-pylon
`shieldWallTo` read, which only knew a pylon's FIRST wall — a pylon's second
wall was neither drawn nor predicted.

**Tests.** `gateLogic.test` (geometry + state machines + property),
`World.gate.test` (fly through the gap / stopped by a post / span blocks),
`GateController.test`, `derivedWalls.test`, integration `gates.test`, E2E
`gate-fly-through.spec` (`gate-test` room).

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

## Structure leveling (Equinox Phase 4 WS-B4 — paid Upgrade + visible build phase)

Structures level via a PAID Upgrade that runs a **visible build phase** — the
same `constructionProgress` pulse machinery the initial build uses (D14). It's
the structure analogue of ship XP, but **player-economy-driven, not kill-driven**:
there is no structure XP, only a per-level resource cost.

`StructureGridSubsystem.upgradeStructure(id)` (owner-gated by the caller, like
`reconnect`/`clearConnections`) validates BUILT + not-deconstructing + below-cap
(`STRUCTURE_LEVEL_CAP = 5`) + not-already-upgrading, then **reuses the
construction machinery**: flips `isConstructed=false`, resets
`constructionProgress=0`, sets `constructionCost` to the upgrade cost, and stashes
`upgradeTargetLevel = level+1`. The cost is drained DURING the build by the grid
pulse (`processConstruction`) — exactly like a fresh blueprint — so an upgrade
against an empty bank simply waits for minerals. On completion `processConstruction`
increments `level`, clears the target, restores `constructionCost` to the kind
base, and seeds HP to the leveled effective max. The leveled stats — `maxHealth`
(universal), `weaponDamage` (`fireMount`; reach stays the gun's at every
level), `powerOutput`
(`structureToGridNode`) — read the level factor at their catalogue read-sites via
the pure `structureLevelFactor(level)` curve. `level` rides the `StructureRecord`,
persists in the sector snapshot (`SectorSnapshotStructure.level`, schema v6), and
rides the live `SnapshotMessage.structures[].level` wire slice (emit-when `> 1`,
no `SWARM_WIRE_VERSION` bump). The UI is the `EntityStatsPanel` `LVL n` line +
4th **Upgrade** action button (`upgrade_structure { entityId }`).

The pure curve (`src/core/leveling/structureLevel.ts`), the message/wire/UI
detail, and the regression locks are documented canonically in
[leveling-and-upgrades.md](leveling-and-upgrades.md) ("WS-B4 — structure
leveling").

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

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Structure building (structures plan, Phase 2; category tier WS-13/R2.6)** lives off the same dial. The **"Build ▸"** action (`speed-dial-build`) drills a 3-level nav — **Build ▸ category ▸ kind** — via the local `view` discriminated union in [`buildCategories.tsx`](../../src/client/components/buildCategories.tsx) (categories `build-cat-<id>` = Core/Economy/Defence, kinds `build-<id>`; MUI SpeedDial doesn't nest, so each level is a local `view` swap). A dedicated **`speed-dial-back`** action pops one level; the FAB icon reflects the drilled category at the kinds level; every action carries an **always-visible label** (`tooltipOpen` — the touch affordance, since hover-only tooltips were invisible on phones; this puts the action into MUI's static-tooltip branch where direct props spread onto the label span, so **all `data-testid`/`aria-pressed`/handlers route through `FabProps`** to stay on the Fab button — the `fab()` helper). **Picking a kind KEEPS the dial open** — only a deliberate FAB toggle / Escape closes it (resetting to root); `onClose` IGNORES `blur`/`mouseLeave` and `onOpen` IGNORES `mouseEnter`/`focus` (a hover-open made the following FAB click toggle the dial SHUT; `speed-dial.spec.ts` "hovering the FAB first"), so clicking the canvas to position the ghost or tapping Confirm doesn't dismiss the menu — so several structures place in a row without re-navigating. Picking sets the Zustand `placementKind` (discrete UI selection — purity-clean, it's a kind id) and raises [`StructurePlacementBanner`](../../src/client/components/StructurePlacementBanner.tsx). The category taxonomy is **client-only** (no wire/catalogue field, no version bump, no netgate); `buildCategories.test.ts` fails closed if a new structure kind is appended uncategorised. Lock: `tests/e2e/speed-dial.spec.ts` (re-added to the FEATURE tier). **Confirm** sends `place_structure` via [`structures/structurePlacementClient.ts`](../../src/client/structures/structurePlacementClient.ts) `placeStructureAhead(kind)` — drop a fixed clearance AHEAD of the local ship's mirror pose (pure `computePlacementPose` is unit-locked). **Cancel** clears `placementKind`. **World ghost + world-anchored confirm (smoke handoff 2026-06-06, Issue 5 — the follow-up is now BUILT).** While `placementKind` is set, `ColyseusClient.updateMirror` writes the ahead-of-ship preview pose into **`RenderMirror.pendingPlacementPreview`** (spatial → render mirror, NOT Zustand, invariant #2; only the discrete `placementKind` id stays in Zustand) via the same `computePlacementPose` (no preview/commit drift; pure `computePlacementPreview` is unit-locked). `PixiRenderer.update` draws a translucent `buildStructureGfx` silhouette at that pose (world space, `pixiY=-gameY`, rebuilt on kind change) AND projects it via `camera.toScreen(x,-y)` into **`RendererFeedback.placementScreenX/Y`** (the main-thread `Camera` is the worker `Camera` class, so `toScreen` already exists — no new getter). `gameRafLoop` publishes `data-placement-screen-x/y` and moves the (now `position:fixed`, `z 1450`) `StructurePlacementBanner` to that on-screen point via a direct-DOM write (no per-frame React re-render). The banner is **rendered OUTSIDE the Slot system** — the old `bottom-center`/`Z.hud` (10) slot sat UNDER the `Z.mobileControls` (15) thumb cluster on a phone, so Confirm was un-tappable (the user's "it's under the UI"). Both render paths carry it: `pendingPlacementPreview` rides the structured-cloned `RenderMirror`; `placementScreenX/Y` rides the worker FEEDBACK message. Structures render per-subtype in the swarm bucket: [`render/pixi/swarmSpriteUpdater.ts`](../../src/client/render/pixi/swarmSpriteUpdater.ts) branches `kind===2` to `buildStructureGfx(entry.shipKind, radius)` — a regular polygon tinted from the catalogue `color`, sided per subtype (the structure subtype rides the shared `shipKind` byte; see the wire note in the root + the catalogue at `src/shared-types/structureKinds.ts`). **`buildStructureGfx` draws `structureRenderVerts` — the `pixiY=-gameY` flip of the game-space collider hull `structureHullPoints` — NOT the raw points (R2.13/WS-7).** A regular polygon is Y-flip-invariant ONLY for an EVEN side-count, so the ODD-sided structures (turret 3, miner 5, shield_pylon 7) rendered MIRRORED vs their colliders when drawn raw — the "collision box is right but the turret appears upside down" bug. Every entity obeys `pixiY=-gameY`; structures used to be the exception. Lock: `spriteBuilders.test.ts` (`structureRenderVerts` is the collider hull's Y-flip; the turret/miner apex flips sign). **Tap/drag-to-position (2026-06-07 — the deferred follow-up the placement comment promised).** The blueprint no longer drops only ahead-of-ship: while placement is active, canvas pointer events POSITION the ghost instead of panning. The RENDERER owns the follow because it holds the `Camera` (`screenToWorld`) and sees pointer events on BOTH paths — `PixiRenderer.routePlacementPointer` (called from `installCanvasEventListeners` main-thread AND `forwardPointerEvent` worker) sets `_placementChosenX/Y` (game-space): `_placementFollowing` starts true so the ghost tracks the pointer (desktop hover / mobile drag), pointer-up parks it. The ghost draws at the chosen point (falls back to the ahead-of-ship preview before the player interacts) and publishes **`RendererFeedback.placementChosenWorldX/Y`** (+ `placementStuck`); `gameRafLoop` writes `data-placement-world-x/y` and the banner's **Confirm sends `placeStructureAt(kind, x, y)`** at that point (`placeStructureAhead` is now a thin wrapper that computes the ahead pose then calls `placeStructureAt`). The banner stays visible the whole time (Confirm + Cancel both available, positioned over the ghost). **Do NOT move the pointer→world conversion to the main thread** — it needs the renderer's camera, which is worker-side on the desktop default path; the feedback channel is the boundary-legal way back. Lock: `structure-placement-ghost.spec.ts` (C) "ghost FOLLOWS the tap". Locks: `tests/e2e/structure-build-placement.spec.ts` (UI→wire→mirror), `tests/e2e/structure-placement-ghost.spec.ts` (ghost projection + mobile-viewport confirm hit-test + tap-to-position follow), `src/client/structures/structurePlacementClient.test.ts` (geometry + `computePlacementPreview`). **WS-10 (R2.5) — desktop one-click place + cancel.** On DESKTOP the ghost follows the pointer on HOVER and a LEFT-CLICK commits at the cursor immediately: `routePlacementPointer` bumps a monotonic `RendererFeedback.placementConfirmSeq` on a mouse left-up (`pointerType==='mouse'`, `button===0`), which `gameRafLoop` edge-detects → `commitChosenPlacement(kind)` (the SINGLE commit path shared with the touch Confirm banner — same `structure_place_confirm` log + send + pending-ghost) → clears `placementKind`. TOUCH is unchanged (a touch up only parks → Confirm banner). **Cancel** is right-click (window `contextmenu`, `preventDefault` while placing) OR Escape (window keydown) → `setPlacementKind(null)`, both main-thread in `App.tsx` — the canvas DOM events live on the main thread on BOTH render paths, so no worker round-trip. **P6.2 (Equinox Phase 6) — a touch long-press must NOT cancel.** Android Chrome fires `contextmenu` on a touch LONG-PRESS too, so the unconditional cancel meant holding a finger during placement cancelled it (+ the OS long-press haptic — "vibrates then doesn't place"). `App.tsx` now tracks the last `pointerdown`'s `pointerType` (window capture listener) and routes through the pure `decideContextMenuPlacement(hasPlacementKind, lastPointerType)` (`structures/contextMenuPlacement.ts`): `preventDefault` whenever placing (suppress the native menu on both), but CANCEL only when `lastPointerType==='mouse'`. Per-gesture, not `isTouchDevice()` — a mouse on a hybrid touchscreen still right-click-cancels. Paired with `index.html` `user-select:none` / `-webkit-user-select:none` (suppress the long-press text-selection + its haptic). Locks: `contextMenuPlacement.test.ts` + `structure-placement-ghost.spec.ts` (M) "a long-press contextmenu does NOT cancel placement". Locks: `structure-placement-ghost.spec.ts` (hover-follow / left-click-places / right-click + Escape cancel) + `structurePlacementClient.test.ts` `commitChosenPlacement`. **P6.1 (Equinox Phase 6) — TOUCH ghost seeds at screen-centre.** On a touch device the ahead-of-ship preview lands the ghost off-screen / hidden under the bottom-right speed-dial until the first tap (the "appears hidden under the speeddial, then jumps" report). The renderer now seeds `_placementChosenX/Y` from `camera.center` on placement-start AND parks it (`_placementFollowing=false`) so the blueprint is visible at screen-centre + the Confirm banner is ready immediately; a tap/drag then repositions it (or the player just Confirms at centre). DESKTOP is gated out (`PixiRenderer` ctor `isTouch`, threaded from `selectRenderer` main-thread + the worker `BOOT` msg — `isTouchDevice()` is unreliable in a worker) so hover-follow + ahead-of-ship is unchanged. Pure decision `shouldCentreGhostOnActivate(isTouch, hasChosenPoint, isPending)` in `placementPointerDecision.ts` (unit-locked). Lock: `structure-placement-ghost.spec.ts` (L) "TOUCH: picking a kind centres the ghost on select" — `data-placement-stuck==='1'` on select with no tap + ghost projected near the viewport centre.

- **Grid render (structures plan, Phase 3).** `ColyseusClient.syncStructures` mirrors the `SnapshotMessage.structures[]` slice into `mirror.structures` (entityId-keyed → joins the swarm mirror for pose) + dispatches the discrete `gridNetPower` to Zustand on change; the `grid_pulse` handler records `mirror.gridFlashes` (numeric pair key `min*65536+max` — NO per-frame string-key alloc, #14). [`render/pixi/ConnectorRenderer.ts`](../../src/client/render/pixi/ConnectorRenderer.ts) draws the web (one `Graphics`, each edge once from the lower entityId; idle muted-blue vs flowing alpha/width pulse + glow — pure params in [`connectorVisual.ts`](../../src/client/render/pixi/connectorVisual.ts)) + the scaffolding/deconstruct fill-bars, wired BEHIND sprites in `PixiRenderer.update`; `swarmSpriteUpdater` dims unbuilt blueprints (`alpha 0.45`). Endpoint positions are re-read from the resolved `mirror.swarm` `entry.x/y` (structures are static — never re-interpolate). `GridPowerReadout` (top-left HUD chip) shows `gridNetPower`. **Placement preview (Item C + WS-5 R2.17):** while `mirror.pendingPlacementPreview` is set, `ConnectorRenderer.drawPlacementPreview` runs the SAME obstacle-aware `canConnect` the server's `autoConnectStructure` uses and classes each hub `ok`/`blocked`/`overflow`/`skip`. It sorts the `ok` hubs by edge-distance (in-place insertion sort over reused scratch — #14, the preview runs every frame during build mode) and caps the GREEN (counted) lines at `PLACEMENT_MAX_CONNECTIONS = 6`, drawing the rest as RED **overflow** (the would-connect-but-over-cap lines — pure params in `connectorVisual.ts` `previewLineVisualParams('overflow', …)`). Test hooks: `placementPreviewConnectionCount` (green ≤ 6, threaded to `RendererFeedback` → `data-placement-preview-conn-count`) + `placementPreviewOverflowCount` (renderer-field only, NOT a feedback field — avoids growing the per-frame worker payload). Locks: `connectorVisual.test.ts`, `ConnectorRenderer.placementPreview.test.ts`, `tests/e2e/structure-grid-web.spec.ts`. **WS-10 (R2.3) — connection-range ring.** `drawPlacementPreview` also draws a faint cyan ring around the ghost at `min(kind.connectionRange, CONNECTION_MAX_RANGE) + ghostRadius` (pure `rangeCircleVisualParams`; radius test hook `lastRangeCircleRadius`), so the player sees the reach before committing (the Capital's 300 u reads tighter than a leaf's 600 u). **WS-10 (R2.4) — hover outline.** A desktop pointer-move resolves the entity under the cursor via the SAME `pickEntityAt` the tap uses (`PixiRenderer.handleGameplayHover`, gated `!galaxyTapSuppressed() && !_placementActive`), drawn by a lighter sibling [`HoverBracket`](../../src/client/render/HoverBracket.ts) (renderer-owned `_hoveredId`, NEVER Zustand — move cadence, #2; published `data-hover-pick-id`; suppressed on the already-selected entity). DEV hook `__eqxHoverAtWorld` (peer of `__eqxSelectAtWorld`). Locks: `HoverBracket.test.ts` + `tests/e2e/hover-outline.spec.ts`. **Phase-4 C4 — collapse the candidate web on commit.** `drawPlacementPreview` early-returns when `preview.pending === true` (the dim post-Confirm ghost, Issue-7 bridge), so ALL candidate green/red/overflow lines + the range ring vanish the instant the player clicks to place ("remove all but the green"); the real green edge then re-appears via the normal placed-structure `connTo` web once the server echoes it (no connection-model change). Lock: the pending-collapse case in `ConnectorRenderer.placementPreview.test.ts`. **Phase-4 C4/C5 — `EntityStatsPanel` inspector readouts** (the per-structure floating panel): a CONNECTOR-only `CONN N / 6` count (`connTo.length` / `getStructureKind('connector').maxConnections`, gated on the swarm subtype byte — NOT shown for other kinds), and a PER-BUILDING power line `PWR +X/-Y` = the kind's own `powerOutput − powerConsumption` (`data-self-power`) — NOT the grid aggregate every component member shares (`GridPowerReadout` now prefixes `GRID ⚡` for the whole-grid total). All client-resident catalogue lookups → instant, no wire/netgate. Locks: `EntityStatsPanel.test.tsx` + `GridPowerReadout.test.tsx`. **Owner readout + cross-owner line filter (2026-06-14).** The `structures[]` slice now carries `owner` (the placing player's id) → `StructureRenderState.owner`. The inspector shows an `OWNER` line (`data-testid="entity-stats-owner"` / `data-structure-owner`): **"you"** for the local player's base (`owner === mirror.localPlayerId`), else the owner's server-resolved **display name** (`structures[].ownerName`, resolved online via the session + offline via the persistent roster's `playerId→userId→user`). There are no anonymous players — an owner that doesn't map to a DB user is an ORPHANED structure (server-logged via `structure_owner_unresolved`) and shows **"Unknown"**, NEVER a raw playerId. Other players' structures are a core part of the game, not a bug, so they're LABELLED, not hidden. AND `ConnectorRenderer.drawPlacementPreview` SKIPS any structure whose `owner ≠ mirror.localPlayerId` — no green would-connect line, no red overflow, no line of any kind to another player's base (the grid is per-owner server-side, so you genuinely can't connect to it). The LIVE grid web needs no client filter — the server's `connTo` adjacency is already same-owner-only (`autoConnectStructure` skips cross-owner). Slim JSON slice field, no `SWARM_WIRE_VERSION` bump. Locks: the owner cases in `EntityStatsPanel.test.tsx` + the cross-owner skip in `ConnectorRenderer.placementPreview.test.ts` + the owner-overlay E2E in `tests/e2e/structure-scenario.spec.ts`.

### Structure footprints + rotation (plan soft-leaping-truffle v2, phase V)

- **Drawing.** `buildStructureGfx` draws the architectural draw plan (`render/pixi/structureVisuals.ts`, the same plan as the design sheet) at the catalogue footprint. The sprite's rotation carries the structure's quarter turn. Lock: `spriteBuilders.test.ts` checks that every kind's plan stays inside its collider box.
- **Placement rotation.** It is module state in `structures/structurePlacementClient.ts` (`cyclePlacementRotation`, the R key, main-thread in `App.tsx`), NOT Zustand: `rotation` is a lint-blocked spatial key and this is a discrete selection the renderer reads through the preview's `angle`. It rides `place_structure.rot`.
- **Client rules use the box too.** The grid view (`mirrorToGridNode`: `halfW/halfH` from the swarm angle) and picking (`pickEntity.ts`) use the footprint box, matching the server.

### Structures at base scale — client cost rules (plan soft-leaping-truffle v2, A3)

- **The connector web has two layers.** `ConnectorRenderer.staticGfx` (behind) holds everything steady: idle edges, turret range rings, up-wall rails, open-gate guides. It rebuilds only when `staticSignature` changes or the zoom moves > 3 %. `gfx` (front) is cleared every frame and holds only what animates. New steady visuals go on the static layer; anything driven by `nowMs` goes on `gfx`, and anything the static layer draws must feed `staticSignature`.
- **The prediction world streams structures and walls by distance** (`structures/predStructureStreaming.ts`, `PREDWORLD_STRUCTURE_RADIUS`). Don't add every structure to predWorld: each server correction replays the whole world (a citadel made that ~6× dearer). No local ship ⇒ no streaming (everything kept).
- **Structure sprites off screen are hidden** (`isSpriteInView` with the camera rect).

### Shield walls are DERIVED, not read per pylon (gates, plan soft-leaping-truffle v2)

- `structures/derivedWalls.ts` `visitDerivedWalls` is the ONE place the client works out shield walls: fence walls between any two connected built emitters (pylons + gates, anchored on the nearest gate post) and each gate's spans, blocking per `wallActive` and the `gateOpen` bits.
- Both `ConnectorRenderer` (draws) and `ColyseusClient.syncPredWalls` (prediction colliders: spawned once, toggled as they block, swept by generation stamp) use it. Don't read `shieldWallTo` for walls again: it only names a pylon's FIRST wall.
- Gate sprites draw posts and walls only (`omitSpans`); spans are drawn live. The inspector shows **OPENS FOR** and owners cycle it (`sendSetGateAccess`).

### Structure state from ROOM STATE (plan soft-leaping-truffle v2, A2)

- **Where structures come from.** `mirror.structures` is filled from Colyseus room state (`room.state.structures`, join payload + delta patches) by `ColyseusClient.syncStructures`. It decodes each row IN PLACE via `net/structureStateDecode.ts` `decodeStructureState`, applying `STRUCTURE_DEFAULTS` for unset fields and resolving the owner through the interned owner tables.
- **What the snapshot carries:** only `structureTargets` (turret / mining targets). There is no per-snapshot structures slice anymore.
- **Shape unchanged.** The mirror row shape is the same, so the renderer, inspector and E2E hooks are untouched.
- **Lifetime.** The binary full refresh NO LONGER deletes structures (`BinarySwarmDecoder` skips kind 2). The room-state row owns their lifetime: when a row goes, `syncStructures` drops both the mirror row and the swarm pose entry.
- **Locks:** `tests/integration/wire/structureStateWire.test.ts` (#15) and `BinarySwarmDecoder.test.ts`.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

**Player-driven structure placement (structures plan, Phase 2).** Beyond the
testMode `structurePoses` seed, players place structures over the wire:
`place_structure` / `remove_structure` (zod `.strict()`,
`src/shared-types/messages/clientMessages.ts`) → `SectorRoom` handlers (resolve
owner via `sessionToPlayer`) → [StructurePlacementSubsystem](../../src/server/structures/StructurePlacementSubsystem.ts)
(decision logic over injected hooks — spawn / health-seed / despawn / clamp / id —
unit-tested like `TransitOrchestrator`) + [StructureRegistry](../../src/server/structures/StructureRegistry.ts)
(ownership + construction state). Placement model: every structure lands a
**blueprint** at `SCAFFOLDING_HP_FRACTION` (10 %) HP, `isConstructed:false`,
non-operational; the **Capital** is the exception (`constructionCost===0` ⇒
pre-built, full HP, the mineral bank). Placement does NOT pre-charge minerals —
the cost is drained DURING construction by the Phase-3 grid pulse, so a blueprint
can be placed with an empty bank and waits. The structure subtype rides the
**shared `shipKind` byte** (kind=2 path; `SwarmSpawner.spawnStructure` sets
`rec.shipKind`) — no stride/`SWARM_WIRE_VERSION` bump. `remove` is owner-gated.
**Phase-4 C2 — placement is OBSTACLE-aware.** `place()` rejected overlap against
PLACED STRUCTURES only, so a Capital dropped on a rock LANDED ("places on an
asteroid"). It now routes BOTH the structure AND the asteroid check through the
shared pure [`canPlaceStructureAt`/`placementRejection`](../../src/core/structures/placementRules.ts)
(sum-of-radii circle, the same `getObstacles` → `gatherStructureObstacles` hook
the auto-connect LOS already used). Low-frequency message path — no wire change,
NO netgate. The client ghost can call the SAME predicate for a red-invalid tint
(deferred). Locks: `placementRules.test.ts` (pure), `StructurePlacementSubsystem.test.ts`
(obstacle reject), `tests/integration/sectorRoom/structurePlacementValidation.test.ts`
(the real `getObstacles` wiring, capital-on-asteroid rejected end-to-end).
`SectorRoom._internals` exposes `structureRegistry` + the swarm record `shipKind`
for the integration test.

**Power grid (structures plan, Phase 3).** `StructureRegistry` carries the
connection adjacency (+ `topologyDirty` + per-structure `minerals`; `remove()`
severs). `structureGridView.autoConnectStructure` runs on every place, per-owner.
**WS-5 R2.17 — it MULTI-connects:** it links the placed structure to EVERY
in-range legal hub (not just the nearest) in deterministic `(edgeDistance, id)`
order, until the structure's own `maxConnections` OR the global
`PLACEMENT_MAX_CONNECTIONS = 6` cap is hit (re-checking `canConnect` each
iteration against the live adjacency, so a hub filling mid-loop is respected). A
leaf (cap 1) therefore still grabs only the nearest hub — only wide hubs
(Connector, cap 6) fan out. It returns the NEAREST connected id (back-compatible
single-id return). Legality is WS-5 R2.10's `canConnect`: capital-only-connectors
(the Capital links ONLY to a Connector — keyed on `GridNode.isConnector`, NOT
pylons) + per-kind `connectionRange` (the Capital's is `CAPITAL_CONNECTION_RANGE
= 300`; `canConnect` takes the `min` of the two endpoints' ranges). The same
`autoConnectStructure` drives the 1 Hz reconnect sweep (`StructureGridSubsystem`
retries stranded leaves) and the `structure-scenario-test` seed. The client
PLACEMENT PREVIEW mirrors this: `ConnectorRenderer.drawPlacementPreview` caps the
GREEN would-connect lines at `PLACEMENT_MAX_CONNECTIONS` and draws the rest as
RED **overflow** (`placementPreviewConnectionCount` = green ≤ 6,
`placementPreviewOverflowCount` = the over-cap remainder). **Multi-connect grows
the `structures[].connTo` JSON slice length → netgate (invariant #8) applies to
R2.17.** `StructureGridSubsystem.pulse()` is the **1 Hz
heartbeat** — directly callable so integration tests drive it deterministically
(no wall-clock wait), `unref`'d + OFF the 60 Hz tick: rebuild-if-dirty →
construction flow (drain a routable Capital; complete ⇒ build + reset HP + dirty;
dry ⇒ pause) → repair → deconstruction → flashes. `SectorRoom` owns the timer,
rebuilds the `structures[]` slice (entityId-keyed; same array ref per recipient,
absent when none), broadcasts `grid_pulse`, severs on structure death via
`evictSwarmEntity`. `_internals.pulseStructureGrid` + `getStructuresSlice` are
the test seams. **Netgate (invariant #8): the `structures[]` slice + `grid_pulse`
touch the snapshot/broadcast path, so `pnpm e2e:netgate` is required for grid
changes.** **Phase-4 C3 — the slice carries `hpPct` (0-100 INTEGER percent, the
`drones[].hp` convention) for EVERY structure**, sourced in `rebuildStructuresSlice`
from `swarmHealth` ÷ `getStructureKind(kind).maxHealth`. The client decodes it to
`StructureRenderState.hpPct` (0..1) so the inspector renders the hull bar on the
FIRST polled frame after selection — killing the "hull pops in" round-trip lag
(the `entity_stats` packet now only refines it). 🔴 netgate (slice byte change;
PASS confirmed). Lock: `entity-inspect.spec.ts` first-frame no-spinner assertion. Phase 4 adds the mining + transfer pulse steps (`findNearestAsteroid`
hook; power-gated extraction → local buffer → haul to Capital). Phase 5 adds
`tickTurrets` on a faster `TURRET_TICK_MS` timer — built+powered turrets target
the nearest drone (`findNearestDrone`) and fire (`applyDamage` + `laser_fired`);
a **bespoke fire path**, NOT `AiFireResolver` (which targets players). **WS-8
(R2.15) generalised `tickTurrets`** from the hard-coded `'turret'` kind to a
data-driven predicate (a structure with a `weaponRange` + a weaponised mount —
auto-includes the new `laser_bolt_turret`/`missile_turret`, EXCLUDES the Miner)
and dispatches on the bound weapon's `mode`: `hitscan` → the continuous beam
(unchanged); `projectile` → a dodgeable bolt via `spawnServerProjectile`;
`missile` → a homing missile via `spawnServerMissile`. The new kinds use the
SHOT model — one shot per the KIND's `fireRateMs` (NOT the weapon's rapid player
cooldown, which would firehose) — damage landing on impact via the
projectile/missile sim (rendered off `projectiles[]`/`missiles[]`). Two guards:
the projectile swarm-pass skips the firing owner (`rec.id === proj.ownerId`) so
a bolt can't detonate on its own turret; and `isMissileTargetHostile` gives a
`pstruct-` owner a **drones-only** (swarm kind 1) homing predicate — without it
a structure missile falls through to the player-shooter branch and targets other
players + friendly structures. Missile SPLASH is unchanged (CAN hit the owner's
base — realistic, by user choice). 🔴 netgate (new projectile/missile
spawn+broadcast). The testMode **scenario trigger** (`prebuiltStructures`/`scenarioDrones`/
`scenarioAsteroids` → `seedStructureScenario`, the `structure-scenario-test`
room) seeds a pre-built powered grid for E2E (the place-ahead UI overlaps stacked
placements; this seeds the end state). **Batteries (batteries plan)** add a full
stored-power buffer: `processBatteryPower()` runs each pulse (before the
power-gated steps) — a component SURPLUS charges its batteries (`storedPower` on
`StructureRecord`, capped at the catalogue `powerStorageCapacity`); a DEFICIT
discharges them to keep the component `powered` IF their combined charge covers
the per-pulse shortfall, else it browns out. The subsystem's `powerSummaryFor`
is now **battery-backed** (raw `netPower`, but `powered` stays true while charge
covers a deficit) — the turret/miner gates AND the `structures[]` snapshot slice
read it. The slice carries `storedPower`/`storedPowerMax` for batteries
(inspector CHRG readout); no `SWARM_WIRE_VERSION` bump (JSON slice). The pure
`Grid` stays instantaneous (its golden tests hold); the battery layer is
server-side, over `Grid.forEachComponent`/`componentMembers`. See [docs/architecture/structures-and-power-grid.md](../../docs/architecture/structures-and-power-grid.md).

**Shield fence (shield-fence plan).** `shield_pylon` is a HUB; two built+connected
same-owner pylons project a blocking **shield wall** in their span. The wall is a
DERIVED collider (geometry from the two pylon poses via the pure
`core/structures/ShieldWall.ts`), NOT a swarm/wire entity. `ShieldWallManager`
(`src/server/structures/`) forms/teardowns walls + drives the collider (worker
`SPAWN_WALL`/`SET_WALL_ACTIVE`/`REMOVE_WALL`; **wall bodies live in `PhysicsWorld`'s
`wallBodies` map, NOT `this.bodies`**, or the per-tick `getAllShipStates` SAB-write
hits a slot-less body). Damage = grid SURPLUS soaks → component BATTERIES drain →
overwhelm both = STUN (collider disabled). Ships block free (static body); weapons
absorb main-thread (`blockBeamAtWall` in the fire resolvers, `wallBlocksProjectile`
in `ProjectilePipeline` → `ShieldWallManager.blockShot`/`blockProjectile`). Two
JSON `structures[]` fields (`shieldWallTo`/`wallActive`) drive the client span +
predWorld collider (`syncPredWalls`). AI targets pylons (`structurePriority`).
**R2.18 (WS-6) — a pylon is UNDAMAGEABLE while ANY of its walls is up.** The
single damage choke point `SectorRoom.applyDamage` guards: if the target is a
`shield_pylon` and `ShieldWallManager.absorbForPylon` finds an ACTIVE wall, the
hit is routed into that wall (via the SAME `onWallHit` grid-power model
span-crossing shots use → surplus soak → battery drain → stun) and the pylon
takes 0 (no damage event). Covers EVERY source — beams/turrets/projectiles AND
ramming all funnel through `applyDamage`. `absorbForPylon` iterates ALL walls on
the pylon and absorbs at the first ACTIVE one (NOT `wallStateFor`, which returns
only the first wall's state — a 3-wall pylon must stay protected if any single
wall is up). So a pylon-with-active-wall takes TWO lethal hits to kill: the
first stuns the wall, the second (now wall-down) lands. Wall stun timing is
wall-clock (`Date.now`), matching every other `shieldWalls` call site.
**Root-cause fix shipped alongside:** the swarm shield-regen pass borrowed a
fighter shield for damaged structures + posted `SET_HULL_EXPOSED` (collider
corruption); now gated on `rec.kind === 1`. See [docs/architecture/structures-and-power-grid.md](../../docs/architecture/structures-and-power-grid.md) + [docs/features/shield-fence.md](../../docs/features/shield-fence.md).

### Structure network at base scale

- **Generated structures use the real rules.** `StructurePlacementSubsystem.place(…, { skipAutoConnect: true })` + `structureGridView.connectExplicit` (re-checks `canConnect` against the live adjacency) let a generated base supply its INTENDED graph — greedy auto-connect would e.g. link gate pylons and close a gate. Players never pass `skipAutoConnect`.
- **Phase V (large footprints):**
  - **Structure rotation.** `place_structure` carries an optional `rot`, which the server snaps to 0/90/180/270. It is stored on `StructureRecord.rot` and the cached `halfW/halfH`, persisted in the sector snapshot, and becomes the body angle at spawn.
  - **Weapon paths.** They use the swarm record's `halfW/halfH` box for kind 2.
  - **Test and scenario layouts** live in ONE place: `rooms/scenarioLayouts.ts` (`SCENARIO`, `STRUCTURE_SCENARIO_PREBUILT`), shared by `index.ts`, `showcaseRooms.ts` and the integration tests. Footprints are 3–6× the old radii, so a hand-placed layout must be re-derived against the real boxes, not guessed.
- **Gates:**
  - `GateController` (`structures/GateController.ts`) steps every built gate on the 10 Hz structure tick, BEFORE `ShieldWallManager.update`. Only ACTIVE player ships open gates (#17).
  - `ShieldWallManager` forms walls between ANY two connected emitters (`isShieldEmitterKind`: pylons + gates) plus each gate's spans; `wallsUpFor(id)` is the per-emitter WALL_ACTIVE flag.
  - Room state `gateOpen` / `gateAccess`; `set_gate_access` is owner-gated. Test room `gate-test` (open gate + owner-only gate).
- **A2 (structure state → ROOM STATE):** structure grid state is `SectorState.structures` (MapSchema keyed by the decimal entityId; `StructureState` in `schema/SectorState.ts`), synced by `SectorRoom.rebuildStructuresSlice` (name kept; same 1 Hz pulse / 10 Hz turret tick / placement call sites). **Rules:**
  - **Assign only on change, and only away from the default.** Fields have NO initialisers: Colyseus schema v3 encodes every ASSIGNED field on join, and initialisers count as assignments. Unset means `STRUCTURE_DEFAULTS` (`shared-types/structureStateWire.ts`); compare `(st.f ?? DEFAULT) !== value` before writing.
  - **Owners are interned** (`structureOwners` / `structureOwnerNames` + `ownerIdx`).
  - **The snapshot carries only `structureTargets`** (flat triples).
  - **Binary channel:** a sleeping out-of-interest structure rides only every `STRUCTURE_OUT_OF_INTEREST_FULL_EVERY` (5th) full refresh. Room state owns structure lifetime on the client.
  - **Test view:** `_internals.getStructuresSlice()` is the pre-A2 row shape rebuilt from room state.

### Server rules in full (moved from src/server/CLAUDE.md)

The zone `CLAUDE.md` keeps a condensed form of these rules; this is the full wording with its lock tests.

#### Structure network at base scale

- **Generated structures use the real rules:** a generated base places with `place(…, { skipAutoConnect: true, rot })` and links with `connectExplicit` (re-checks `canConnect`); never auto-connect one (it would close gates). Players never pass `skipAutoConnect`.
- **Structure room state (A2 rules):** a `StructureState` field has no initialiser and is assigned only on change and only away from `STRUCTURE_DEFAULTS` (compare `(st.f ?? DEFAULT) !== value`). Production and teleporter fields follow the same rule.
- **Budgets and layouts:** structure-heavy content stays inside `src/shared-types/structureBudgets.ts`. Test layouts live only in `rooms/scenarioLayouts.ts`; re-derive hand-placed ones against the real footprint boxes. Only ACTIVE player ships open gates (#17). Lock: `structureRotation.test.ts`.
- Detail: [structures guide](../../docs/architecture/structures-and-power-grid.md#structure-network-at-base-scale), [scale ledger](../../docs/architecture/structure-network-scale.md).

#### Structures: placement, power grid, shield fence

- **Placement checks structures AND asteroids** through the shared `canPlaceStructureAt` / `placementRejection`; `remove` is owner-gated. Locks: `placementRules.test.ts`, `StructurePlacementSubsystem.test.ts`, `structurePlacementValidation.test.ts`.
- **Grid changes touch the snapshot path** (`structures[]`, `grid_pulse`): `pnpm e2e:netgate` required. `StructureGridSubsystem.pulse()` is the directly-callable 1 Hz heartbeat, off the 60 Hz tick.
- **Shield-wall bodies live in `PhysicsWorld.wallBodies`**, never `this.bodies`. A pylon with any active wall takes no damage (`applyDamage` → `absorbForPylon`). Swarm shield regen covers `rec.kind === 1` only.
- Detail: [structures-and-power-grid.md](../../docs/architecture/structures-and-power-grid.md#server-implementation-notes).

## History

- **Structure rotation reaches the physics body.** `SwarmSpawner` forwards the spawn angle for structures (kind 2) as well as scrap, and primes the SAB angle. (It used to forward it for scrap only, so rotated structures collided and drew at 0° — locked by `structureRotation.test.ts`.)
