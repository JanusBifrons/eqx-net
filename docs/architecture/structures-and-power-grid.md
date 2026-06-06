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
- **Build UI:** the speed-dial **Build ▸** sub-menu sets Zustand `placementKind`;
  `StructurePlacementBanner` confirms/cancels. Confirm →
  `structurePlacementClient.placeStructureAhead(kind)` sends `place_structure` at
  a fixed clearance ahead of the local ship's mirror pose (the Phase-2 fallback
  coordinate model; the pure `computePlacementPose` is unit-locked). The full
  tap-to-position world ghost is a planned follow-up.

## Phases 3–5 (planned)

- **3** — `Connection` + `Grid` (zone-pure, BFS components + A* routing) + the
  `StructureGridSubsystem` 1 Hz pulse: power aggregation, the **construction flow
  economy** (blueprints build by draining connected storage; dead-end rule for
  unbuilt nodes), repair, deconstruction, and the `structures[]` snapshot slice +
  `grid_pulse` discrete event for the connector web + scaffolding fill-bar.
- **4** — mining towers extract minerals from asteroids in range, hauled to the
  Capital over the pulse.
- **5** — defensive turrets aim + fire at hostile drones (power-gated).

## Tests

- `tests/unit/structureKinds.test.ts` — catalogue golden + wire-index round-trip.
- Swarm wire round-trip locks in `BinarySwarm{Broadcast,Decoder}.test.ts`.
- `src/server/structures/StructurePlacementSubsystem.test.ts` — placement rules.
- `tests/integration/sectorRoom/structureEntity.test.ts` — full path: seed +
  player-driven `place_structure` (Capital pre-built / Connector blueprint→destroy).
- `src/client/structures/structurePlacementClient.test.ts` — placement geometry.
- `tests/e2e/structure-build-placement.spec.ts` — UI → wire → mirror.
- `tests/e2e/speed-dial.spec.ts` — the consolidated dial.
