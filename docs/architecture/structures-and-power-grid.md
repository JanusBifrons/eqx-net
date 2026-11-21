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

- Validate kind, clamp to `SECTOR_PLAYABLE_HALF_EXTENT`, reject footprint overlap
  with a structure or an asteroid (`placementRejection`, obstacles from the
  `getObstacles(near)` hook; in a cut field `near` adds the rocks with no body,
  see [macro-terrain](macro-terrain.md) C5). An asteroid is tested by its
  bounding circle (broad phase), then by its real shape when the obstacle
  carries convex `parts` (collider parts or outline at the live pose; C5b):
  a footprint inside the circle but clear of the outline is legal.
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
- **Kind rules** (`placementRefusal` hook, player placements only): a kind may
  carry its own rule; the refusal text is kept on `lastRefusal` and the room
  sends it as a `notice`. Today only the **Territory Lock** has one
  (`structures/territoryLockRules.ts`): the builder's side must hold the sector
  on the control meter, and one per sector. See
  [robot-territory](../features/robot-territory.md).

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
- `Grid.ts` — `canConnect` (the hub model: connector-required: every link has a Connector
  end, except shield emitter↔emitter fence links, which the `pylon-rule` governs;
  big buildings such as the shipyard are NOT relays / per-kind
  `maxConnections` cap / edge-to-edge `CONNECTION_MAX_RANGE` / no-self/dup /
  line-of-sight: the centre-to-centre line must miss every other structure's
  footprint box and every obstacle; an asteroid's box is the broad phase and,
  when it carries convex `parts`, the line is blocked only if it crosses a
  part (`segmentHitsObstacle`; macro terrain C5c), so a cable may pass a big
  irregular rock inside its circle but clear of its outline. The server's
  obstacles include rocks with no body (an unloaded cut-field chunk): every
  auto-connect (placement, reconnect sweep, player reconnect) asks
  `getObstacles(near)` with `linkReachBox`, the box its links may run in
  (macro terrain C5g). Both sides build
  a rock's `parts` with the one `rockObstacleParts` (a field rock's collider
  parts, else its outline's convex hull; an ordinary asteroid's seeded
  outline) at its live angle: the server in `SectorObstacles.rocks` and
  `CutFieldSubsystem.dormantObstacles`, the client link preview through
  `RockObstacleShapes` (`client/structures/mirrorToGridNode.ts`: an awake field
  rock's body from `CutFieldLayer.rockBody`, the packed chunk the cutter
  sends with its outlines; cached per rock key), so the preview's green/red
  matches the link the server makes. A field rock whose chunk the client has
  not loaded stays its box (red, never a false green); lock:
  `rockLineOfSight.test.ts`), BFS connected components (**built-only — the dead-end rule:
  you can't relay THROUGH an unbuilt node; an unbuilt node is still a transfer
  destination, and this is load-bearing for the construction flow's outward
  expansion**), power aggregation (`powered`
  requires a Capital in the component AND net ≥ 0), and A* routing + a route
  cache dropped on every rebuild. A node with `rootsPower` stands in for the
  Capital (see "A base that loses its last Capital" below).
- **A base that loses its last Capital** (capture plan 4E). When a built
  Capital leaves the world (destroyed, packed or taken down; every path ends in
  `StructureRegistry.remove`, which calls `orphanBaseOnCapitalLoss` in
  `ownerlessBase.ts` before it cuts the links), each grid piece it held that
  has no other built Capital gets the owner `none:<lostCapitalId>`. Owner rule:
  the base keeps working exactly as before (power, batteries, shields,
  production); it simply has no faction (`relationOf` makes it neutral to
  everyone). The grid view sets `GridNode.rootsPower` on every ownerless node,
  so its component stays powered on its own generation. A grid with another
  built Capital stays owned. NPC bases flip the same way (S5, below). The
  owner reaches clients through the normal structures slice (`ownerIdx` is
  re-interned on change). Lock: `StructureGridSubsystem.ownerless.test.ts`.
- **Capturing an ownerless base** (capture plan 4E S4, finders keepers). A
  player's structure may link to an ownerless one (`gridLinkAllowed` in
  `relations.ts`, used by auto-connect on placement, the reconnect sweep and
  button, `linkReachBox` and `connectExplicit`); two players, two different
  ownerless bases, or an NPC and anyone else never link. When a player's built
  Capital ends up on one grid piece with ownerless pieces (a Capital placed in
  range, or a Connector or cable bridge once built: a blueprint is never
  crossed), every `none:` structure in that piece takes the player's owner. No
  standing change, no hostile act. The ONE seam is the pulse's topology rebuild
  (`captureOwnerlessGrids` in `ownerlessBase.ts`, run just before
  `grid.rebuild`): every link, finished build and removal dirties topology, so
  every path passes it, and the rebuilt grid and the structures slice after the
  pulse carry the new owner. `onCaptured` makes the room `persistSoon`. NPC
  Capitals capture nothing (S5). A player structure linked to an ownerless grid
  without a Capital of its own leaves it ownerless; if two players' Capitals
  ever share a piece, the first in registry order takes it. The client build
  preview still draws same-owner links only (follow-up).
- **An NPC base whose Capital dies falls the same way** (capture plan 4E S5;
  owner: "Finders keepers"). No second mechanism: the same
  `orphanBaseOnCapitalLoss` flip turns its grid pieces `none:<lostCapitalId>`,
  still powered. Because its pieces are no longer `npc:`-owned, its faction
  lets go for free: `npcBaseTrade` lists no trade entry for it (no convoy
  anchor), it no longer counts for the faction on the control meter
  (`sectorLiveCounts`) or in `FactionLedger`, and hits on it move no standing
  (`hitStanding.ts`). Nobody's standing changes when it falls. Its garrison
  stands down: `PatrolSubsystem.watchBaseFalls` (subscribed by
  `addGarrisonPatrol`) hears the Capital's removal and, once the owner has no
  built Capital left in the room, drops that patrol (no respawn, no roaming);
  surviving ships carry on as attached ships until they are gone. A piece not
  linked to the lost Capital keeps its `npc:` owner (the same per-grid rule as
  a player base). Lock: `bases/npcBaseFall.test.ts`.
- **A fallen NPC base never regrows** (capture plan 4E S6; owner: "never
  regrows, even after a restart, until captured"; once captured the site is
  taken, so not then either). The seeder stamps every piece it places with
  `originBase` (its seed owner, `npc:<faction>:<baseId>`); the field stays when
  the base falls (`none:`) or is captured, and `SectorPersistence` saves it with
  the piece (optional `structures[].originBase`, no schema bump; restore keeps
  only an `npc:` value). The sector also remembers the fall itself: when a
  seeded base's last built Capital leaves the world (`StructureRegistry.remove`
  → `noteBaseFall`), its origin joins `StructureRegistry.fallenBases`, saved as
  the sector's `fallenBases` list, so the base stays fallen even once every
  piece of it is destroyed. `seedGalaxyBase` and `seedNpcBases` skip every base
  in `fallenBaseOrigins` (`ownerlessBase.ts`: the recorded falls plus origins
  of pieces no longer owned by their origin). Seeding runs only at room boot,
  after restore; nothing regrows a base in a running room. An old save (no
  `originBase`, no `fallenBases`) loads and regrows as before. Lock:
  `bases/npcBaseNoRegrow.test.ts`.
- **An ownerless base's Territory Lock claims nothing** (owner 2026-11-21,
  "Stops claiming"). A lock owned by `none:` (built or still a blueprint)
  feeds no side to the control meter (`isLiveTerritoryLock`), never holds
  (`isHoldingTerritoryLock`), and does not take the sector's one lock slot:
  `territoryLockRefusal` (`territoryLockRules.ts`) skips it, so another side
  that holds the sector may build its own lock under the normal rules. Once the
  base is captured (above) the lock carries the captor's owner and claims and
  blocks again. Lock: `territoryLockRules.test.ts`.
- `structureGridConstants.ts` — `CONNECTION_MAX_RANGE`, `TRANSFER_PULSE_MS`,
  `CONSTRUCTION_PULSE_AMOUNT`, `REPAIR_*`, `DECONSTRUCTION_RATE_KG`,
  `CAPITAL_STARTING_MINERALS`, `FLASH_DURATION_MS`.
- **Minimum cable length** (owner rule "keep buildings apart"):
  `MIN_CABLE_LENGTH = 56` u, stud to stud. 56 = a 1× cable's two collars
  (6 u each) plus the short-run span (44 u, `connectorLineLooks.ts` draws
  collars only below it), so the shortest cable still shows a lashing and
  some bundle; the cable look reads the same constant. `pickCableSocketPair`
  skips a pair under it and takes the next longer free facing pair; with none,
  `canConnect` refuses `'too-short'` and writes the refused pair to the pick
  (a connector end still uses a face turned toward the partner, so the cable
  never runs back across its own hub). Fence links (post to post,
  `CABLE_NO_SOCKET`) are exempt. The build preview draws a too-short link red,
  stud to stud, and when it is the only link the ghost would make shows
  "Can't connect: too close" (`RendererFeedback.placementPreviewTooShortCount`
  → `placementHints.ts`, `PlacementLinkHint`). The base generator stands each
  leaf its `linkGap` off its connector (the smallest gap the real rule
  links, `growBuilder.ts`); the stress lattice uses the full 56 u.
  Locks: `minCableLength.test.ts`,
  `ConnectorRenderer.tooShortPreview.test.ts`, `placementHints.test.tsx`,
  `growBase.test.ts` (minimum cable length).
- **Cables never cross (owner rule).** `pickCableSocketPair`, given the adjacency (`canConnect` passes it), skips a socket pair whose curve crosses any stored cable (`cableCrossesExisting`, `cableCurve.ts`) and refuses `'crosses-cable'` when none is left ("Can't link: crosses another cable"; the build preview draws it red along the refused pair). Every owner's cables count, as every owner's buildings block a cable. Links sharing an end with the new one (a fan-out) and shield-fence links (emitter post to post: walls, not cables; a new fence link is not checked either) are skipped; touching through a vertex counts, collinear overlap does not. Each stored link is box-tested (both ends padded by `CABLE_TAIL_MAX`) before it is flattened; no cache (`CABLE_CROSS_STATS` counts links flattened and segment tests). Auto-connect simply moves on to the next candidate. Existing crossings on old saves stay. Generated bases had none (output unchanged). Locks: `cableCrossing.test.ts`, `structureGridView.test.ts`, `ConnectorRenderer.placementPreview.test.ts`.

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

**On/Off switch.** The owner can switch any structure that draws power Off (`set_structure_power { entityId, on }`, owner-only, `structureSettingMessages.ts`). Off sets `rec.switchedOff`: `structureDraw` returns 0 for it, `setActive` can never make it active, and `StructureGridSubsystem.powerSummaryFor` reads it unpowered, so every subsystem that gates on power stops (turrets hold fire, a shield wall drops if either post is Off, production, labs, drills and mine layers pause). On restores the idle draw. Generators, power stores and connectors draw nothing and have no Off. The state persists and rides the wire as `STRUCTURE_FLAG_OFF` (bit 512 of the uint16 `flags`, no new schema field); the client grid preview reads it through the same `structureDraw`. Logic: `structurePowerSwitch.ts`.

**Power throttle.** The same switchable kinds take a throttle of 0..100% in steps of 10% (`set_structure_power { entityId, on, throttle? }`, `throttle` in tenths 0..10, owner-only). It is stored as `rec.throttle` (tenths 0..9; absent = 100%, the default, so existing structures are unchanged) and scales `structureDraw`'s result, full or idle: 50% draws half. The change is the same O(1) grid adjustment as the switch. It persists and rides bits 10-13 of the uint16 `flags` as the tenths below full (`encodeStructureThrottleFlags`; an unthrottled row sends no bits), decoding to `StructureRenderState.throttle`. It also scales WORK SPEED through the one shared helper `structureWorkRate(rec)` (`shared-types/structurePower.ts`: 1 at the default, the tenths when throttled, 0 when Off): each producer multiplies its one per-pulse step by it. Processors incl. the Refinery and Shipyard (`ProductionSubsystem` `advanceProgress`, so `prodProgress` can be fractional), drills (`processMining` per-pulse rate), Gas Collectors (`processGas` haul) and Research Labs (`LabBoard.advance` step; the lab view floors `done`). 50% takes twice as long; 0% does no work while the structure still reads powered. Turrets ignore the throttle: they have On/Off only.

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

Plan soft-leaping-truffle v2, phase V; solid doors: `docs/plans/door-power.md`.
Player guide: [shield-gates.md](../features/shield-gates.md).

**Kinds.** `shield_gate` (320 × 72) and `shield_airlock` (320 × 260), appended
to the structure catalogue (no version bump: appending leaves saved rows valid,
and a bump would reset saved structures).

**Geometry** lives in one zone-pure module, `src/core/structures/gateGeometry.ts`,
read by both sides (#15):
- **Collider parts:** a gate's fixed body is its posts/towers (and an airlock's
  side walls) as separate convex parts (`gateColliderPolygons`, passed to
  `World.spawnObstacle(..., parts)`), on the server worker and the client
  prediction world, so the gap between them is open until a door closes it.
- **Anchors:** a fence wall ends on the gate post nearest its far end
  (`emitterAnchor`).
- **Door constants:** `DOOR_TRAVEL_S` (3 s at full power), `DOOR_POWER_LEVELS`
  (15), `DOOR_POS_MAX` (= 180 ticks × 15 = 2700), `DOOR_RESEGMENT_MIN_MS`.

There is NO shield span across a gate's gap any more (`gateSpans`,
`gateSpanWorld`, `GATE_SPANS` are deleted). The gap is closed by SOLID door
leaves.

**Doors are rig leaves.** Each gate kind has a rig (`src/core/articulation/rigs/fences.ts`):
`gate-doors` (2 physical leaves that slide apart into the towers) and
`airlock-doors` (4 leaves, two per end; clip `door-a` / `door-b` names the
moving end). The leaves are `physical` rig parts, so they are KINEMATIC
colliders in the physics worker and in client prediction: a shut door blocks a
ship, a half-open door leaves a real half gap, and a closing door shoves a ship
out of the gap (there is no "never close on a ship" hold).

**One door clock.** A door's motion is a segment `{p0, t0, dir, level}`
(`src/core/structures/doorMotion.ts`). Position is always
`doorPosAt(seg, tick)` = clamp(p0 + dir × level × (tick − t0), 0, DOOR_POS_MAX)
— server, worker and prediction all read it; nobody integrates position.
`driveDoor` starts a new segment on a new target at once, and on a power-level
change only while travelling and at most once per `DOOR_RESEGMENT_MIN_MS`.
The rig is driven by a SCRUBBED clip (`PlayingClip.from`/`rate`): from =
`doorClipTime(p0)`, rate = dir × level / 15.

**Power-scaled travel.** Level L = `doorLevelFromSupply(supplyFrac)` =
round(supplyFrac × 15), from the grid's supply fraction
(`PowerSummary.supplyFrac`: 1 when net ≥ 0 or a battery rescues the grid,
supply/demand in deficit, 0 with no Capital). Full power crosses in 3 s, half
power in 6 s, and at 0 power a door FREEZES wherever it is (open stays open,
shut stays shut, partial stays partial). A moving door draws full power through
the general grid rule (`setActive`); a still one only its trickle.

**Open/close decisions** (`src/core/structures/gateLogic.ts`, server-only): the
decision is each door's TARGET. Occupancy is built from ship positions in the
gate's local frame. A gate targets open while an admitted ship is within
`GATE_APPROACH_DEPTH` (300 u) of the gap, and targets shut
`GATE_CLOSE_HOLD_MS` after the zone empties; hold timers count from the door's
ARRIVAL fully open. An airlock is one `phase` field (closed / open A / open B)
and an end starts opening only when the other end is at position 0, so both
doors are never open at once. Locked by a fast-check property test.

**Server.** `GateController` steps every built gate on the 10 Hz structure tick
from the ACTIVE player ships (#17) and the gate's access setting
(`shared-types/gateAccess.ts`: owner + allies / owner only / anyone not
hostile), and posts each changed segment to the gate's rig as a clip
(`startStructureRigClip`). **Gunfire:** the server tests weapons with
main-thread boxes, not the worker's bodies, so `doorLeafBoxes.ts` appends one
box per physical leaf to the gate record's `boxes` and re-poses them from the
door positions each structure tick: a shut leaf takes the hit (damage to the
gate through the normal structure path), an open leaf sits in its tower pocket
and the gap lets shots through. **Shields:** gates are still fence EMITTERS —
`ShieldWallManager` forms fence walls between any two connected built emitters
(pylons and gates); stun hits those fence walls only. A gate itself is broken
by destroying it (HP), not by stunning it.

**Wire.** Existing room-state fields, no new field
(`src/server/rooms/doorMotionRow.ts` → `encodeDoorMotion` in
`shared-types/structureStateWire.ts`): `rigClip` = which door clip, `rigStart`
= t0, `rigHold` = p0, `gateOpen` = bit 7 target open + bits 0–3 level. Assigned
only on change, so a still door costs nothing and a late joiner rebuilds the
door from the row (#16). `gateAccess` + the owner-gated `set_gate_access`
message carry the access setting.

**Client.** `net/doorMotionDecode.ts` decodes the row into
`StructureRenderState.doorA` / `doorB` (the truth) plus the scrubbed `rigClip`
that poses the drawn leaves and the prediction colliders on `mirror.rigTick`.
The deck light (`structureStyleC.fences.gate.ts` `deckLightCode`) is per end:
GREEN only when fully open, RED when shut or moving, DARK with no power or
stalled mid-travel at level 0. `structures/derivedWalls.ts` derives fence walls
(and teleporter irises) only — no gate spans.

**Persistence.** The sector snapshot saves an optional `doorPos` / `doorClip`
per gate (`savedDoorOf`); a restored door starts still at that position with
its target shut; missing = shut. Access persists too.

**Tests.** `doorMotion.test`, `gateLogic.test` (state machines + property),
`GateController.test`, `doorLeafBoxes.test`, `derivedWalls.test`,
`structureStyleC.fences.gate.deckLight.test`, `World.gate.test`, integration `sectorRoom/gates.test`, E2E
`gate-fly-through.spec` (`gate-test` room: the admitting gate opens fully, then
the ship flies through; the locked gate's shut leaves stop it).

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
`onCreate` via `seedStructureScenario` in `rooms/scenarioLayouts.ts`): `prebuiltStructures` (placed through the
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

- **Grid render (structures plan, Phase 3).** `ColyseusClient.syncStructures` mirrors the `SnapshotMessage.structures[]` slice into `mirror.structures` (entityId-keyed → joins the swarm mirror for pose) + dispatches the discrete `gridNetPower` to Zustand on change; the `grid_pulse` handler records `mirror.gridFlashes` (numeric pair key `min*65536+max` — NO per-frame string-key alloc, #14). [`render/pixi/ConnectorRenderer.ts`](../../src/client/render/pixi/ConnectorRenderer.ts) draws the web (one `Graphics`, each edge once from the lower entityId; idle muted-blue vs flowing alpha/width pulse + glow — pure params in [`connectorVisual.ts`](../../src/client/render/pixi/connectorVisual.ts)) + the scaffolding/deconstruct fill-bars, wired BEHIND sprites in `PixiRenderer.update`; `swarmSpriteUpdater` draws an unbuilt blueprint as a cyan HOLOGRAM ([`structureHologram.ts`](../../src/client/render/pixi/structureHologram.ts)): dark glass + translucent cyan panels, wireframe edges and scan lines over the real art, masked to the part AHEAD of a cyan print line that sweeps the footprint (local x) with `buildPct` (bank paid / cost, ramped like the bar); behind the line the solid art shows. Art is a shared `GraphicsContext` per kind/style; per frame only the mask and line move; the overlay is dropped once built. Lock: `structureHologram.test.ts`. Endpoint positions are re-read from the resolved `mirror.swarm` `entry.x/y` (structures are static — never re-interpolate). `GridPowerReadout` (top-left HUD chip) shows `gridNetPower`. **Placement preview (Item C + WS-5 R2.17):** while `mirror.pendingPlacementPreview` is set, `ConnectorRenderer.drawPlacementPreview` runs the SAME obstacle-aware `canConnect` the server's `autoConnectStructure` uses and classes each hub `ok`/`blocked`/`overflow`/`skip`. It sorts the `ok` hubs by edge-distance (in-place insertion sort over reused scratch — #14, the preview runs every frame during build mode) and caps the GREEN (counted) lines at `PLACEMENT_MAX_CONNECTIONS = 6`, drawing the rest as RED **overflow** (the would-connect-but-over-cap lines — pure params in `connectorVisual.ts` `previewLineVisualParams('overflow', …)`). Test hooks: `placementPreviewConnectionCount` (green ≤ 6, threaded to `RendererFeedback` → `data-placement-preview-conn-count`) + `placementPreviewOverflowCount` (renderer-field only, NOT a feedback field — avoids growing the per-frame worker payload). Locks: `connectorVisual.test.ts`, `ConnectorRenderer.placementPreview.test.ts`, `tests/e2e/structure-grid-web.spec.ts`. **WS-10 (R2.3) — connection-range ring.** `drawPlacementPreview` also draws a faint cyan ring around the ghost at `min(kind.connectionRange, CONNECTION_MAX_RANGE) + ghostRadius` (pure `rangeCircleVisualParams`; radius test hook `lastRangeCircleRadius`), so the player sees the reach before committing (the Capital's 300 u reads tighter than a leaf's 600 u). **WS-10 (R2.4) — hover outline.** A desktop pointer-move resolves the entity under the cursor via the SAME `pickEntityAt` the tap uses (`PixiRenderer.handleGameplayHover`, gated `!galaxyTapSuppressed() && !_placementActive`), drawn by a lighter sibling [`HoverBracket`](../../src/client/render/HoverBracket.ts) (renderer-owned `_hoveredId`, NEVER Zustand — move cadence, #2; published `data-hover-pick-id`; suppressed on the already-selected entity). DEV hook `__eqxHoverAtWorld` (peer of `__eqxSelectAtWorld`). Locks: `HoverBracket.test.ts` + `tests/e2e/hover-outline.spec.ts`. **Phase-4 C4 — collapse the candidate web on commit.** `drawPlacementPreview` early-returns when `preview.pending === true` (the dim post-Confirm ghost, Issue-7 bridge), so ALL candidate green/red/overflow lines + the range ring vanish the instant the player clicks to place ("remove all but the green"); the real green edge then re-appears via the normal placed-structure `connTo` web once the server echoes it (no connection-model change). Lock: the pending-collapse case in `ConnectorRenderer.placementPreview.test.ts`. **Phase-4 C4/C5 — `EntityStatsPanel` inspector readouts** (the per-structure floating panel): a CONNECTOR-only `CONN N / 6` count (`connTo.length` / `getStructureKind('connector').maxConnections`, gated on the swarm subtype byte — NOT shown for other kinds), and a PER-BUILDING power line `PWR +X/-Y` = the kind's own `powerOutput − powerConsumption` (`data-self-power`) — NOT the grid aggregate every component member shares (`GridPowerReadout` now prefixes `GRID ⚡` for the whole-grid total). All client-resident catalogue lookups → instant, no wire/netgate. Locks: `EntityStatsPanel.test.tsx` + `GridPowerReadout.test.tsx`. **Owner readout + cross-owner line filter (2026-06-14).** The `structures[]` slice now carries `owner` (the placing player's id) → `StructureRenderState.owner`. The inspector shows an `OWNER` line (`data-testid="entity-stats-owner"` / `data-structure-owner`): **"you"** for the local player's base (`owner === mirror.localPlayerId`), else the owner's server-resolved **display name** (`structures[].ownerName`, resolved online via the session + offline via the persistent roster's `playerId→userId→user`). There are no anonymous players — an owner that doesn't map to a DB user is an ORPHANED structure (server-logged via `structure_owner_unresolved`) and shows **"Unknown"**, NEVER a raw playerId. Other players' structures are a core part of the game, not a bug, so they're LABELLED, not hidden. AND `ConnectorRenderer.drawPlacementPreview` SKIPS any structure whose `owner ≠ mirror.localPlayerId` — no green would-connect line, no red overflow, no line of any kind to another player's base (the grid is per-owner server-side, so you genuinely can't connect to it). The LIVE grid web needs no client filter — the server's `connTo` adjacency is already same-owner-only (`autoConnectStructure` skips cross-owner). Slim JSON slice field, no `SWARM_WIRE_VERSION` bump. Locks: the owner cases in `EntityStatsPanel.test.tsx` + the cross-owner skip in `ConnectorRenderer.placementPreview.test.ts` + the owner-overlay E2E in `tests/e2e/structure-scenario.spec.ts`.

### Structure footprints + rotation (plan soft-leaping-truffle v2, phase V)

- **Drawing.** `buildStructureGfx` draws the architectural draw plan (`render/pixi/structureVisuals.ts`, the same plan as the design sheet) at the catalogue footprint. The sprite's rotation carries the structure's quarter turn. Lock: `spriteBuilders.test.ts` checks that every kind's plan stays inside its collider box.
- **Placement rotation.** It is module state in `structures/structurePlacementClient.ts` (`cyclePlacementRotation`, the R key, main-thread in `App.tsx`), NOT Zustand: `rotation` is a lint-blocked spatial key and this is a discrete selection the renderer reads through the preview's `angle`. It rides `place_structure.rot`. The mirror choice sits beside it (`togglePlacementMirror`): the touch banner's Mirror button (`placement-mirror`, next to Rotate) and the F key (`handlePlacementKey`, which also owns R) flip it; it rides `place_structure.mirror`. Neither resets when placement ends.
- **Client rules use the box too.** The grid view (`mirrorToGridNode`: `halfW/halfH` from the swarm angle) and picking (`pickEntity.ts`) use the footprint box, matching the server.
- **Build mirror (base loop 4A).** `place_structure.mirror` places a building left-right flipped: x → −x in its LOCAL frame, applied BEFORE the rotation. It is stored on `StructureRecord.mirror`, saved in the sector snapshot (`structures[].mirror`, additive, no schema bump) and sent as `STRUCTURE_FLAG_MIRROR` (bit 15 of `StructureState.flags`; the client decodes `mirror`). Every shape rule maps local points through the one transform `structureLocalToWorld` (`structureKinds/geometry.ts`): sockets (`structureSocketToWorld(..., mirror)`), keep-clear pads (`keepClearBox(..., mirror)`), placement (`placementRejection(..., mirror)`), and grid nodes carry `GridNode.mirror` into `cableCurve`. The footprint box needs no flip (it is symmetric). Not yet mirrored: the collision outline body, gate posts, shield-wall anchors, turret mounts, crane bay / rig and the new-hull origin; the control (4D). Locks: `tests/unit/buildMirror.test.ts`, `structureMirror.test.ts` (integration).
- **Build mirror: drawing and the ghost (4B, 4C).** A mirrored structure's sprite gets a negative x scale (`render/pixi/structureMirrorFlip.ts`): Pixi scales before it rotates, which is `structureLocalToWorld`. The body art, build-up hologram, socket nubs and rig plane flip with it; the rig's over/under groups copy the sign (`followHost`). A crane clip's target arrives in the server's host frame with the mirror undone (`worldToRigHost`); the client maps it to the world with `structureLocalToWorld(..., mirror)` and back into the flipped draw frame, so the drawn grip lands on the real ship (no double flip). Sun-facing parts aim at π − φ in a mirrored host, so they still face the sun. Text readouts and the gun cluster are counter-flipped (readable text; barrels keep the server's true world aim); inside the cluster each gun's x offset is negated once, so a gun sits at the server's mirrored mount position (`StructureMountTicker`). The placement choice is module state beside the rotation (`setPlacementMirror` in `structurePlacementClient.ts`, never Zustand); it rides the preview's `mirror` (ghost flip, `ghostToGridNode` for the cable preview, the red/green verdict) and `place_structure.mirror`. Locks: `swarmSpriteUpdater.structureMirror.test.ts`, `structureRigs.mirror.test.ts`, `structurePlacementClient.test.ts` ("placement mirror (4B)").

### Structures at base scale — client cost rules (plan soft-leaping-truffle v2, A3)

- **The connector web has two layers.** `ConnectorRenderer.staticGfx` (behind) holds everything steady: idle edges, turret range rings, up-wall rails, open-iris guides. It rebuilds only when `staticSignature` changes or the zoom moves > 3 %. `gfx` (front) is cleared every frame and holds only what animates. New steady visuals go on the static layer; anything driven by `nowMs` goes on `gfx`, and anything the static layer draws must feed `staticSignature`.
- **Socket cables wear the cable line look ("bundle on the curve").** With `socketCables` on, each link draws the same bundled cable as the straight `cable` look (strands, cradles, lashings, end collars, flow glow) along its stud-to-stud curve: the look walks a polyline by arc length ([`connectorCablePath.ts`](../../src/client/render/pixi/connectorCablePath.ts)), a straight edge being a 2-point path drawn byte-identically to before. Cradles sit at even arc-length stations, square to the smoothed local tangent; the end collars sit just in from each stud (`cableStudInset`), square to the stud normal, and a run too short for cradles still gets both collars. A fence link (no sockets) keeps its collars outside the posts. Locks: `connectorLineLooks.path.test.ts`.
- **Socket cable flow (structure-restyle 0d slice 9, `?fx=new`).** With `socketCables` on, a flowing link draws, on `gfx` only, along its cached cable ([`connectorCables.ts`](../../src/client/render/pixi/connectorCables.ts)): the cable look's bleed and lit core (between the frames), then a train of comets that leaves the source socket when the run of flow starts and travels by arc length at a per-material pace in game time (`fxNow`): world units per second minerals 220, repair 280, construction 320, power 440; spacing 170 / 200 / 210 / 170 u, widened so at most `MAX_CABLE_COMETS` (4) ride a cable. Throughput is not on the wire, so the material sets the pace (#16). Comets passing a cradle throw clamp sparks. Each comet reaching the receiving socket flashes its end collar for `COLLAR_FLASH_MS` (240 game ms). When the run started is noted on the cached `LinkCable` (`flowSince`); a link not drawn flowing for `FLOW_RESTART_GAP_MS` (1000 game ms) starts a new run. Per-frame work per link is bounded by count: at most 6 strokes (bleed, core, all comets in one, all sparks in one, two for the flash). Locks: `connectorCables.flow.test.ts`, the slice 9 cases in `ConnectorRenderer.lineLooks.test.ts`.
- **Socket cables meet each socket flush.** `flattenCableCurve` (core, shared with the server's `canConnect`) lays a straight stub of `CABLE_SOCKET_STUB` (24; at most half a connector's short tail) along each socket normal, then the Bezier from stub end to stub end, so the first and last segments run exactly along the normals. The client cable cache passes each end's build mirror (`GridNode.mirror`) so a mirrored building's cable leaves its mirrored socket; a mirror change re-lays the cable and the static signature.
- **Socket cable flow runs source → receiver for the whole run.** `leadCometArc` returns the lead comet still on the cable, which only moves forward (by speed·dt, or one spacing back when a comet leaves at the receiver); the collar flash fires at the receiving end.
- **A flowing cable wears the colour of what it carries.** Glow and core use the material palette (`flowMaterialColor`, `connectorPalette.ts`), comets, sparks and the collar flash that colour lightened (`flowPulseColor`); an idle link (no flow) keeps the idle colour. Power is never flashed by the server today, so power links stay idle.
- **The prediction world streams structures and walls by distance** (`structures/predStructureStreaming.ts`, `PREDWORLD_STRUCTURE_RADIUS`). Don't add every structure to predWorld: each server correction replays the whole world (a citadel made that ~6× dearer). No local ship ⇒ no streaming (everything kept).
- **Structure sprites off screen are hidden** (`isSpriteInView` with the camera rect).

### Shield walls are DERIVED, not read per pylon (gates, plan soft-leaping-truffle v2)

- `structures/derivedWalls.ts` `visitDerivedWalls` is the ONE place the client works out shield walls: fence walls between any two connected built emitters (pylons + gates, anchored on the nearest gate post), blocking per `wallActive`, plus teleporter irises. Gates have no shield span: their gap is closed by solid rig door leaves (see [Gates](#gates)).
- Both `ConnectorRenderer` (draws) and `ColyseusClient.syncPredWalls` (prediction colliders: spawned once, toggled as they block, swept by generation stamp) use it. Don't read `shieldWallTo` for walls again: it only names a pylon's FIRST wall.
- Gate door leaves are drawn by the rig from the scrubbed door clip; the deck lights are live (`deckLightCode`: green fully open, red shut/moving, dark unpowered). The inspector shows **OPENS FOR** and owners cycle it (`sendSetGateAccess`).

### Structure state from ROOM STATE (plan soft-leaping-truffle v2, A2)

- **Where structures come from.** `mirror.structures` is filled from Colyseus room state (`room.state.structures`, join payload + delta patches) by `ColyseusClient.syncStructures`. It decodes each row IN PLACE via `net/structureStateDecode.ts` `decodeStructureState`, applying `STRUCTURE_DEFAULTS` for unset fields and resolving the owner through the interned owner tables.
- **What the snapshot carries:** only `structureTargets` (turret / mining targets). There is no per-snapshot structures slice anymore.
- **Shape unchanged.** The mirror row shape is the same, so the renderer, inspector and E2E hooks are untouched.
- **Cable sockets (`connSock`, structure-restyle 0d).** Parallel to `connTo`, one uint16 per link packing this end's socket (low byte) and the other end's (high byte), 255 = no socket (fence link); written with `connTo` in `writeConnToRow`'s one change check, packed/unpacked only by `encodeConnSock` / `decodeConnSockSelf` / `decodeConnSockOther` (`shared-types/structureStateWire.ts`), decoded onto `StructureRenderState.connSockSelf` / `connSockOther` (-1 = none). uint16, not uint8: kinds reach 24 sockets.
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
can be placed with an empty bank and waits. **Hologram pass-through (base
loop 3F):** an unbuilt blueprint's body spawns in `BLUEPRINT_COLLISION_GROUPS`
(collides with nothing; its rig's solid parts wait too), so ships fly through it;
its space stays reserved because placement checks the registry. On completion
([`blueprintBody.ts`](../../src/server/structures/blueprintBody.ts)) it turns
solid (`SET_COLLISION_GROUPS` → default, `SwarmSpawner.solidifyStructure`) only
when no hull (`SectorObstacles.hullCircles`) overlaps its footprint; otherwise it
waits, fully paid, and finishes the pulse the space is clear. While it waits
the client says so, derived from the row alone (`buildPct >= 1 && !built`,
[`buildAwaitingClear.ts`](../../src/client/structures/buildAwaitingClear.ts)):
"WAITING FOR SHIPS TO CLEAR" above the blueprint and "FINISHED — WAITING FOR
SHIPS TO CLEAR" on the inspector card. Records built
outside the pulse (restore, seeded bases) settle on the next pulse. **One rule
everywhere (3F2):** `isStructureBodySolid` (`core/structures/structureBody.ts`,
reads `ghostBody`; `isConstructed` alone is not it: a finished blueprint waits
as a ghost, and a structure mid-upgrade is unbuilt but solid). The room-state
row carries it as `STRUCTURE_FLAG_GHOST_BODY` (16384) → `ghostBody`, and the
client's `StructureClientLeaf` builds and swaps the predWorld body by it (ghost
→ solid: default groups then the rig, like `solidifyStructure`; a body spawned
solid before its row arrived is rebuilt as a ghost), re-checked on every swarm
sync. Navigation (`RoomNav`) adds no obstacle for a ghost; `settleBlueprintBody`
calls `StructureRegistry.bodyChanged`, which re-adds it once solid. The structure subtype rides the
**shared `shipKind` byte** (kind=2 path; `SwarmSpawner.spawnStructure` sets
`rec.shipKind`) — no stride/`SWARM_WIRE_VERSION` bump. `remove` is owner-gated.
**Phase-4 C2 — placement is OBSTACLE-aware.** `place()` rejected overlap against
PLACED STRUCTURES only, so a Capital dropped on a rock LANDED ("places on an
asteroid"). It now routes BOTH the structure AND the asteroid check through the
shared pure [`canPlaceStructureAt`/`placementRejection`](../../src/core/structures/placementRules.ts)
(sum-of-radii circle, the same `getObstacles` → `SectorObstacles.rocks` hook
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
`scenarioAsteroids` → `scenarioLayouts.seedStructureScenario`, the `structure-scenario-test`
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
  - `GateController` (`structures/GateController.ts`) steps every built gate on the 10 Hz structure tick, BEFORE `ShieldWallManager.update`. Only ACTIVE player ships open gates (#17). Doors are solid rig leaves driven by a scrubbed clip; position is only ever `doorPosAt(seg, tick)` (one door clock); travel scales with the grid `supplyFrac` and freezes at 0 power; `doorLeafBoxes.ts` adds the leaves to the gate's hit boxes so shut doors block gunfire.
  - `ShieldWallManager` forms walls between ANY two connected emitters (`isShieldEmitterKind`: pylons + gates); no gate spans. `wallsUpFor(id)` is the per-emitter WALL_ACTIVE flag.
  - Room state door motion (`gateOpen` bit 7 target + level, `rigClip`/`rigStart`/`rigHold`; `doorMotionRow.ts`) / `gateAccess`; `set_gate_access` is owner-gated; saves carry optional `doorPos`/`doorClip`. Test room `gate-test` (open gate + owner-only gate).
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

- **Placement checks structures AND asteroids** through the shared `canPlaceStructureAt` / `placementRejection`; `remove` is owner-gated. The placement ghost runs the same predicate before the click (`PlacementGhostVerdict`, over the mirror structures and the build preview's rocks): red with the server's notice under it (`RendererFeedback.placementPreviewRejection` → `PlacementLinkHint`), cyan where it can go. The ghost is the blueprint hologram art (`StructureHologram`, `ghost` look: drawn once in white with bright panels and thick edges, tinted cyan `HOLOGRAM_COLOR` or red `PREVIEW_BLOCKED_COLOR` per frame, so a valid/blocked switch never rebuilds art); a scanner line sweeps it and it pulses gently on `fxNow()`; the sent (pending) ghost is a dim, still cyan. The verdict also gates the commit: `gameRafLoop` copies it into `placementChosen.rejection` each frame (`writePlacementChosen`), `commitChosenPlacement` sends nothing while it is set (touch Confirm and desktop click alike), and the touch Confirm tick is disabled (it subscribes via `useSyncExternalStore`), so a red ghost is never sent for the server to refuse. Wreck pieces are not on the client list yet. Locks: `placementRules.test.ts`, `StructurePlacementSubsystem.test.ts`, `structurePlacementValidation.test.ts`, `placementGhostParity.test.ts`, `placementGhostUpdater.test.ts`.
- **Grid changes touch the snapshot path** (`structures[]`, `grid_pulse`): `pnpm e2e:netgate` required. `StructureGridSubsystem.pulse()` is the directly-callable 1 Hz heartbeat, off the 60 Hz tick.
- **Shield-wall bodies live in `PhysicsWorld.wallBodies`**, never `this.bodies`. A pylon with any active wall takes no damage (`applyDamage` → `absorbForPylon`). Swarm shield regen covers `rec.kind === 1` only.
- Detail: [structures-and-power-grid.md](../../docs/architecture/structures-and-power-grid.md#server-implementation-notes).

## History

- **Every link goes through a Connector.** `canConnect` used to need only ONE end to be `isHub`, so a solar could plug straight into a shipyard, deep-core rig, ore processing complex or assembly plant. Now one end must be a Connector (`connector-required`); shield emitter↔emitter links are unchanged. Generated bases already linked every leaf to a Connector (output unchanged).
- **Structure rotation reaches the physics body.** `SwarmSpawner` forwards the spawn angle for structures (kind 2) as well as scrap, and primes the SAB angle. (It used to forward it for scrap only, so rotated structures collided and drew at 0° — locked by `structureRotation.test.ts`.)
