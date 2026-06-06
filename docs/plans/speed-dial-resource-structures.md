# Speed Dial UI + Placeable Power-Grid Structures

## Context

EQX Peri has a freshly-landed **Generic Entity Pipeline** (`src/core/entity/`) in
which a new world-object type is "a leaf + a registry descriptor." It already ships
a working but unused **`structure`** entity (pose-core kind byte 2,
`SwarmSpawner.spawnStructure`, `StructureEntity` leaf, `STRUCTURE_DEFAULT_*`
constants, testMode `structurePoses` room option). The user wants to take advantage
of this framework to introduce a base-building layer modelled on the flash game
**"The Space Game"** and the user's other repo **eqx-peri** (`src/game/structures/`,
researched live): structures placed by the player, **connected by lines**, transferring
**power and resources on a 1 Hz pulse**.

Two deliverables:

1. **UI → Speed Dial.** Consolidate the current *discrete menu options* (open
   menu/drawer, MAP toggle, weapon-slot selector) into a single MUI **SpeedDial**
   FAB in the `bottom-right` anchor, and host the **new structure-placement actions**
   there too. The continuous-input controls (joystick, hold-to-FIRE, hold-to-BOOST)
   stay as dedicated controls — a tap-to-expand FAB is wrong for held inputs
   (confirmed with user).

2. **Structures** (confirmed scope: **power + a single "minerals" resource**, the
   simplified Space-Game model, *not* the full eqx-peri ore→refinery→materials chain):
   - **Capital** (the "Core") — pre-/player-placed **root hub**; baseline power output + the
     big mineral store. A hub node (links to several others).
   - **Connector** (the "Relay") — a small, cheap, low-HP **pure hub node** with no power or
     storage of its own. **This is the linking mechanism**: every non-hub structure attaches
     to a Connector (or the Capital), and Connectors attach to each other / the Capital, so
     the base forms a **web/grid of hubs with leaf structures hanging off them** — exactly
     The Space Game's relays ("tiny structures that allow buildings to connect so power and
     minerals flow freely… connect with up to 6 structures").
   - **Solar panel** (the "dollar labels" → "solar panels" clarification) — power generator (a leaf node).
   - **Mining tower** — turret(s) that target asteroids with a **mining laser**, extracting minerals (a leaf node).
   - **Defensive turret** — targets hostile drones, power-gated firing (a leaf node).

   **Connection model (corrected per user):** structures do **NOT** connect to each other
   directly. Every leaf structure (solar / miner / turret) connects to exactly **one** hub
   (Connector or Capital); hubs (Connector ×6, Capital ×4) are what form the web. This is the
   eqx-peri rule verbatim — "all other structures connect exclusively to Connectors."

   Structures are **server-authoritative** (eqx-net is netcode-heavy multiplayer;
   unlike eqx-peri which runs the grid client-side). The power/resource **grid +
   pulse** logic runs server-side as a low-frequency subsystem.

### Logistics mechanics reference (researched live: eqx-peri `GameTypes.ts`/`GridManager.ts` + The Space Game)

Source-of-truth numbers to mirror (tune for eqx-net world scale during build):

| Constant | Value | Meaning |
|---|---|---|
| `CONNECTION_MAX_RANGE` | **600** | Max **edge-to-edge AABB** distance between two endpoints (returns 0 when bounding boxes overlap/touch — NOT centre-to-centre). |
| `CONNECTION_THROUGHPUT` | **100000** | Max resource units per connection per pulse — so high it's effectively *unbounded* in practice (transfer is not throughput-gated in the first cut; the field exists for future bottlenecks). |
| `TRANSFER_PULSE_MS` | **1000** | Pulse interval — power aggregates instantly, **resources/minerals move once per second**. |
| `FLASH_DURATION_MS` | **300** | Connection flash duration on a transfer pulse. |
| `CONSTRUCTION_PULSE_AMOUNT` | **5** | Minerals delivered to each blueprint **per pulse** — blueprints build *gradually*, draining the grid; pause when storage is dry, resume when refilled. |
| `REPAIR_PULSE_AMOUNT` / `REPAIR_COST_PER_HP` | **3** / **0.1** | Minerals/pulse to damaged *built* structures; 0.1 minerals per HP restored. |
| `DECONSTRUCTION_RATE_KG` | **100** | Minerals returned per pulse when reclaiming a structure (red bar empties). |
| `SCAFFOLDING_HP_FRACTION` | **0.1** | A just-placed blueprint spawns at 10% HP and is **non-operational** (power/storage/mining/fire all gated behind `isConstructed`) until fully built. |

Per-type stats (eqx-peri `STRUCTURE_DEFINITIONS`; the 5 kinds we ship + their model rows):

| Kind | maxConnections | powerOutput | powerConsumption | storageCapacity | maxHealth | range |
|---|---|---|---|---|---|---|
| **Capital** (Core) | **4** | 50 | 0 | 2,000,000 | 5,000 | — |
| **Connector** (Relay) | **6** | 0 | 0 | 0 | 200 | — |
| **Solar** | **1** | 30 | 0 | 0 | 300 | — |
| **Miner** (MiningPlatform) | **1** | 0 | 60 | 200,000 | 2,000 | miningRange **800** |
| **Turret** (Small/Med/Large) | **1** | 0 | 15 / 25 / 35 | 0 | 600 / 1k / 1.5k | weaponRange 500–700, fireRateMs 400–800, dmg 10–25 |

The Space Game origin (mechanics we're faithfully reproducing): **Solar Stations** are the
only energy source; **Relays** (≤6 links) connect everything so power+minerals flow;
**Miners** drill asteroids for minerals (≈80/min L1) which build everything; **Lasers** are
short-range defense vs swarms. Power gates operation — unpowered structures stop working.

### Reuse map (do not re-build these)
| Need | Reuse |
|---|---|
| Static damageable structure entity | `SwarmSpawner.spawnStructure` + `StructureEntity` leaf + kind-2 descriptor (`src/core/entity/EntityKindRegistry.ts:87`) — already wired |
| Turret aim (pick target + slew) | `src/core/ai/WeaponMountController.ts` (`pickTarget`/`rotateMountToward`) |
| Server mount tick state | `src/server/rooms/MountAimSubsystem.ts` pattern |
| Turret firing | `src/server/rooms/CombatSubsystem.ts` + `AiFireResolver` (data-driven `WeaponCatalogue`) |
| Power math | `src/core/combat/Energy.ts` scalar helpers (or mirror the pattern) |
| Beam rendering (mining + turret) | `src/client/render/BeamSpritePool.ts`, `src/client/combat/LocalBeam.ts`, `effects/perEffect/LaserGlow.ts` |
| Dynamic per-entity slim slice on snapshot | `SnapshotMessage.drones[]` pattern → new `structures[]` slice |
| Subtype byte on binary wire | the existing `shipKind` u8 (+32) — currently drone-only — repurposed for kind-2 records (no stride/version bump) |
| Low-frequency control loop | `src/server/livingworld/LivingWorldDirector.ts` (unref'd ~1.5 s loop) pattern for the grid pulse |
| Catalogue (append-only + version) | `src/shared-types/shipKinds.ts` pattern → new `structureKinds.ts` |
| E2E placement trigger | existing testMode `structurePoses` room option (`src/server/rooms/SectorRoom.ts`) |
| UI slots / sx-hoist | `src/client/layout/Slot.tsx` + `anchors.ts`; hoist static `sx` to module consts |

---

## Phase 1 — Speed Dial UI refactor (self-contained, ships first)

Migrate discrete menu options into a single SpeedDial; no gameplay change.

- **New** `src/client/components/SpeedDialMenu.tsx`: MUI `SpeedDial` + `SpeedDialAction`,
  mounted via `<Slot anchor="bottom-right">` (z-tier `mobileControls`). Hoist all
  static `sx` to module-level consts (perf rule). Actions for Phase 1:
  - **Menu** → `useUIStore.setState({ isDrawerOpen: true })` (settings/profile/debug/roster live in the existing `AdvancedDrawer`).
  - **Map** → toggle `isGalaxyMapOpen` (logic currently in `GalaxyMapToggleButton.tsx`).
  - **Weapon slot** → cycle/select `activeSlotId` (logic currently in `SlotSelector.tsx`).
- **Retire from their own anchors** (move their *actions* into the dial, keep the
  *state* in `store.ts`): `DrawerToggle` mount, `GalaxyMapToggleButton`, `SlotSelector`.
  Keep `MobileControls` (joystick + FIRE + BOOST) and `FireCooldownRing` untouched.
- `store.ts`: add `isSpeedDialOpen?: boolean` if needed (UI flag — allowed; no spatial fields).
- Desktop vs mobile: SpeedDial shows on touch/compact; preserve existing keyboard shortcuts (input is driven by `Keyboard.ts`, the dial is presentation only).
- **Files:** `src/client/App.tsx` (slot mounts), `src/client/components/SpeedDialMenu.tsx` (new), `src/client/layout/Drawer/DrawerToggle.tsx`, `src/client/components/GalaxyMapToggleButton.tsx`, `src/client/components/SlotSelector.tsx`, `src/client/state/store.ts`.
- **Test:** `tests/e2e/speed-dial.spec.ts` — dial opens, each action fires (drawer opens, map overlay toggles, active slot changes). `data-testid` on the FAB + actions.

---

## Phase 2 — Structure catalogue + placement plumbing (structures appear as blueprints & take damage)

> Placed structures land as **blueprints/scaffolding** (10% HP, non-operational). They
> *render* and *take damage* this phase; **construction-to-completion + the flow economy
> that feeds them lands in Phase 3** (the Capital is the one pre-built anchor here).

- **New** `src/shared-types/structureKinds.ts` — append-only catalogue mirroring
  `shipKinds.ts`. `STRUCTURE_KINDS_LIST` order = wire subtype-byte index (invariant #11).
  **Five kinds:** `id` (`'capital'|'connector'|'solar'|'miner'|'turret'`) — note **connector**
  is included (the relay/hub; see corrected connection model above). Per-kind fields +
  reference values from the mechanics table: `displayName`, `radius`, `maxHealth`,
  `maxConnections` (capital 4 / connector 6 / others 1), `isHub` (capital, connector),
  `powerOutput`, `powerConsumption`, `storageCapacity`, `miningRate`/`miningRange`,
  `constructionCost` (total **minerals** to fully build — eqx-peri's `constructionCost`;
  **Capital = 0 → pre-built**), `mounts?` (turret/miner — reuse `WeaponMount` shape from
  `shipKinds/types.ts`), `weaponRange`/`fireRateMs`, `color`.
  `STRUCTURE_KIND_CATALOGUE_VERSION` const.
- **Wire subtype:** extend the kind-2 path so `SwarmEntityRecord.shipKind` carries the
  structure subtype index for structures; encoder already writes the `shipKind` byte —
  no stride/version bump. Extend the structure render descriptor `preservedFields`
  `['kind']` → `['kind','shipKind']` (`EntityKindRegistry.ts` — a field refinement,
  not a reorder/removal).
- **Placement message:** `PlaceStructureSchema` (zod, `.strict()`) in
  `src/shared-types/messages.ts`: `{ kind, x, y }`. Validation contract (invariant #3).
  Plus `RemoveStructureSchema { id }`.
- **Server handler** (`SectorRoom.onMessage('place_structure')` → new
  `src/server/structures/StructurePlacementSubsystem.ts`): validate (sector bounds via
  `clampToSectorBounds`, no-overlap, owner roster). Then **place as a blueprint /
  scaffolding, NOT operational** (eqx-peri model): `spawnStructure({ id, x, y, radius })`,
  seed `swarmHealth.set(id, floor(kind.maxHealth * SCAFFOLDING_HP_FRACTION))` (**10% HP** —
  fragile scaffolding), and record `{ id, owner, kind, subtypeIndex, isConstructed:false,
  constructionProgress:0, constructionCost }` in a server-side `StructureRegistry`; set
  `rec.shipKind = subtypeIndex`. **Capital is the exception** — `constructionCost:0` →
  `markPreBuilt()` (full HP, `isConstructed:true`) and seeded with starting mineral
  storage so the first builds have something to draw from. Note: placement does **not**
  pre-charge minerals — the cost is drained *during* construction by the flow economy
  (Phase 3), so a blueprint can be placed even with an empty bank and will simply wait.
  Owner-tagged; session-scoped per sector (persistence is a noted follow-up).
- **Client placement + blueprint ghost UX** `src/client/structures/StructurePlacementController.ts`:
  selecting a kind from the speed-dial "Build ▸" menu enters `placementMode` (Zustand
  `placementKind: StructureKindId | null`) and spawns a **client-only blueprint ghost** — a
  translucent (≈40% alpha) version of the structure's silhouette in the structure's tint,
  rendered by a dedicated `BlueprintGhostRenderer` (Pixi Graphics overlay, NOT a swarm
  entity — it exists only on the placing client until confirmed). The ghost **follows the
  tap/cursor** in world space and shows, live as it moves:
  - a **connection-range ring** (`CONNECTION_MAX_RANGE = 600`) and a faint **candidate
    line** to the nearest in-range hub (Connector/Capital) it *would* auto-connect to;
  - **valid/invalid tint** — green when a hub is in range with a free slot and LOS is
    clear, red when no hub reachable / overlap / out of bounds (mirrors the server
    `canConnect` gate so the preview can't lie);
  - for miner/turret, the **operating range** ring (`miningRange` / `weaponRange`).
  **Confirm** (tap-again / a confirm button) sends `place_structure`; **cancel** exits
  `placementMode` and drops the ghost. **Coordinate source:** publish the render-worker
  camera transform (scale + center) to the main thread once per frame (low-freq, via the
  existing worker→main channel) so a screen tap converts to world coords; **fallback** =
  drop at the local player ship's current mirror pose + forward offset if the transform
  plumbing slips. (Decision flagged for the build.)
- **Client render:** structure subtype → silhouette in the swarm render bucket
  (`PixiRenderer` swarm path); distinct shape/colour per subtype read from
  `entry.shipKind`. **Under-construction (scaffolding) look:** a structure with
  `isConstructed:false` renders dimmed / wireframe-style with a **fill/progress bar**
  driven by `constructionProgress / constructionCost` (and a red emptying bar while
  deconstructing) — so the player sees it "slowly build up" as the grid feeds it.
- **Speed-dial:** add "Build ▸" sub-actions (Capital / Connector / Solar / Miner / Turret).
- **Tests:** `tests/integration/sectorRoom/structureEntity.test.ts` (send `place_structure`,
  assert it joins the swarm registry, takes damage, dies → `entity_destroyed`); E2E
  `tests/e2e/structure-placement.spec.ts` (place via dial, structure renders).

---

## Phase 3 — Power grid + **connectors** + **construction flow economy** + pulse

Connectors **and the flow-economy construction** are the heart of this phase. Modelled
directly on eqx-peri's `Connection` + `GridManager` (researched live), adapted to eqx-net's
server-authoritative model. **Connectors are intra-sector only** — a connection always links
two structures owned by the same player inside one `SectorRoom`; there is no cross-sector
connector (the user confirmed: structure-to-structure, not sector-to-sector).

**Flow economy (the model the user called out):** a placed structure is a **blueprint /
scaffolding** (Phase 2) that builds *gradually* by pulling minerals from connected storage
over pulses — it is **not** paid for up-front and is **not** functional until 100% built. If
the grid runs dry, construction **pauses** and resumes automatically when minerals return.
This is the same pulse that moves power and (Phase 4) mined minerals — one 1 Hz heartbeat
drives the whole logistics web.

### 3a. Connection data model (server, authoritative)

- **New** `src/core/structures/Connection.ts` (zone-pure, mirrors eqx-peri):
  `Connection { id, aId, bId, throughput, flowMaterial: 'power'|'minerals'|null,
  flashUntilMs }`. Helpers: `getOtherNode(id)`, `length(poseA, poseB)` (Euclidean),
  `flash(nowMs, durationMs)` / `isFlashing(nowMs)`. `id` from an auto-increment counter.
- Connections live in a server-side **`StructureRegistry`** (Phase 2) as an
  **adjacency map** `Map<structureId, Connection[]>` plus a flat
  `Map<connectionId, Connection>` — O(1) neighbour lookup for BFS/A*.

### 3b. How a connection forms — `canConnect(a, b)` (the hub model, eqx-peri verbatim)

On every `place_structure` (and never on the physics tick), the placement subsystem
attempts to wire the new structure into its owner's grid. `canConnect(a, b)` ports
eqx-peri's exact rules:

1. **Hub rule (the key one):** **at least one endpoint must be a hub** — a **Connector**
   or the **Capital** (eqx-peri: *"at least one side must be a Connector"*; *"all other
   structures connect exclusively to Connectors"*). So a leaf (solar/miner/turret) can
   **only** attach to a Connector or the Capital — **never to another leaf**. Hubs link to
   hubs (and to the Capital) to extend the web. This is the corrected model.
2. **Connection-limit (`maxConnections`):** each structure has a per-kind cap from the
   catalogue — **Connector 6, Capital 4, every leaf 1**. Both endpoints must have a free
   slot. The cap is what makes the web shape: a leaf burns its single slot on one hub;
   hubs fan out to 4–6 neighbours.
3. **Range gate:** **edge-to-edge AABB** distance ≤ `CONNECTION_MAX_RANGE = 600` (NOT
   centre-to-centre; returns 0 when bounding boxes overlap/touch — port eqx-peri's
   `edgeDistance`).
4. **No self / no duplicate:** a structure can't connect to itself or duplicate an
   existing connection.
5. **Line-of-sight:** `isConnectionLineBlocked(a, b, others)` rejects a connection whose
   segment passes through another structure's body (segment-vs-AABB slab test, ported
   from eqx-peri).
6. **Auto-pick:** if the player didn't pick a target, connect to the **nearest in-range
   hub with a free slot** that passes 1–5. If none, the structure is placed
   **unconnected** (renders dimmed/unpowered until a hub is built in range) — the player
   then drops a Connector to bridge it, exactly like The Space Game's relays.

> **Dead-end rule (load-bearing, eqx-peri verbatim):** an **unconstructed** structure is a
> *dead end* in BFS/A* — it is reachable as a transfer **destination** (so it can receive
> the minerals that build it) but **not traversable** (you cannot relay power/resources
> *through* a half-built node). This forces **outward sequential expansion**: the Capital
> funds a Connector, the Connector completes, and only *then* can leaves hanging off it be
> fed. A scaffolding Connector therefore connects but does not yet extend the live grid.

`connect()` constructs a `Connection(a, b, CONNECTION_THROUGHPUT)`, pushes it into both
endpoints' adjacency entries, decrements both free-slot counts, and sets
`topologyDirty = true`. (A manual connect/disconnect-target UI is a noted follow-up; the
first cut is auto-connect-to-nearest-hub on place + auto-sever-on-destroy. Because the
default placement target is a hub, the natural workflow is **Capital → Connectors →
leaves**, which is precisely the Space-Game build order.)

### 3c. Disconnect / sever

On structure **destroy** (hull → 0) or **remove**, `disconnect(structureId)` removes all
its `Connection`s from both endpoints, returns their `Connection` ids, and sets
`topologyDirty = true`. Cleanup must also clear the structure from the registry, grid
components, and route cache (no leaks across reconnect — same discipline as the mount-map
cleanup rule in `src/server/CLAUDE.md`).

### 3d. Topology, power aggregation, and the pulse — incl. construction (server)

- **New** `src/core/structures/Grid.ts` (zone-pure, injected): BFS over the adjacency map
  → connected components, rebuilt **only when `topologyDirty`** (never per tick). **Treats
  unconstructed nodes as dead-ends** (destinations only — see the dead-end rule above).
  `getGridPowerSummary(component)` = Σ `powerOutput` − Σ `powerConsumption` over **built**
  members → `netPower` + `powered` flag (`netPower ≥ 0`). A* route between two structures
  (hop-count cost + Euclidean heuristic, normalised by `CONNECTION_MAX_RANGE` so heuristic
  ≤ actual hop count, exactly as eqx-peri); **route cache invalidated on `topologyDirty`**.
- **`isConstructed` gate (eqx-peri parity):** `powerOutput`, `powerConsumption`,
  `storageCapacity`, mining, and turret fire **all return 0/inert until `isConstructed`**.
  A blueprint neither produces, draws, nor stores anything — it only *consumes the
  construction stream*.
- **New** `src/server/structures/StructureGridSubsystem.ts`: a low-frequency
  (`TRANSFER_PULSE_MS = 1000` ms, `unref`'d) loop (LivingWorldDirector pattern), **off the
  60 Hz physics tick** (keeps invariant #14 pressure off; any per-tick glue stays
  allocation-free). Each pulse, in order:
  1. **Rebuild topology** if dirty.
  2. **Aggregate power** per component (built members only).
  3. **Construction pulse** (`processConstructionPulse`, eqx-peri's name): for each
     blueprint reachable from a storage source in its component, deliver up to
     **`CONSTRUCTION_PULSE_AMOUNT = 5`** minerals/pulse, debited from the nearest connected
     storage (Capital) along the A* route; add to `constructionProgress`. When
     `constructionProgress ≥ constructionCost` → flip `isConstructed = true`, reset HP to
     `maxHealth`, set `topologyDirty = true` (the freshly-built node now relays). **If the
     source has no minerals, deliver nothing — construction simply pauses** (emergent, no
     pause flag) and resumes next pulse once minerals exist.
  4. **Repair pass** (same routine): damaged *built* structures receive up to
     **`REPAIR_PULSE_AMOUNT = 3`** minerals/pulse at **`REPAIR_COST_PER_HP = 0.1`** per HP.
  5. **Deconstruction** (if `isDeconstructing`): drain at **`DECONSTRUCTION_RATE_KG = 100`**/
     pulse, returning minerals to storage; remove the structure when fully reclaimed.
  6. **Transfer pulse** (Phase 4 mineral hauling): route queued transfers along A* paths,
     each connection capped at `CONNECTION_THROUGHPUT` units/pulse.
  7. **Flash** every connection that carried flow this pulse (`flash(nowMs,
     FLASH_DURATION_MS = 300)`, `flowMaterial` set so construction/mineral vs power
     pulses colour differently).
- **Capital**: pre-built; baseline `powerOutput` + the big `storageCapacity` (mineral bank
  + the source the construction stream draws from). **Solar**: `powerOutput` once built.
  `netPower` gate flips turrets/miners on/off (Phases 4/5).
- **Constants** added to `structureGridConstants.ts` this phase: `CONSTRUCTION_PULSE_AMOUNT
  = 5`, `REPAIR_PULSE_AMOUNT = 3`, `REPAIR_COST_PER_HP = 0.1`, `DECONSTRUCTION_RATE_KG =
  100`, `SCAFFOLDING_HP_FRACTION = 0.1`.

### 3e. Connectors on the wire + client render (incl. colours/pulse visuals)

- **Dynamic wire slice:** new `SnapshotMessage.structures?: Array<{ id, powered,
  netPower?, connTo?: id[], minerals?, built?: boolean, buildPct?: number,
  deconstructPct?: number }>` (slim, low-cadence; mirrors `drones[]`), emitted only when
  structures exist (zero cost otherwise). `connTo` lists each structure's connected
  neighbour ids (draws the web); `built`/`buildPct` drive the scaffolding fill-bar so the
  player watches a blueprint "build up" pulse by pulse; `deconstructPct` drives the red
  emptying bar. (`buildPct` only sent while `!built`, omitted once complete — keeps the
  slice small.)
- **Pulse flashes** reach the client as a **discrete bus/network event**
  `grid_pulse { flashed: Array<[aId, bId]>, material: 'power'|'minerals' }` (low-frequency,
  ≤1 Hz — fits the discrete event-bus channel, NOT the per-frame continuous channel;
  honours the Event-Bus Architecture rule). Avoids streaming per-connection flash state.
- **Client** `src/client/structures/ConnectorRenderer.ts` (Pixi Graphics), porting
  eqx-peri's `ConnectionRenderer` visual model:
  - **Idle line:** muted blue **`0x4488aa`** at **alpha 0.3**, width `max(1/scale, 1)`.
  - **Flowing (flashing) line:** material colour at **alpha `0.9 − flashProgress*0.5`**,
    width `max(1/scale, 2.5)`, where `flashProgress = 1 − (flashUntil − now)/300`
    (fade-out over `FLASH_DURATION_MS = 300`). Plus a **glow overlay** at **3× width**,
    `alpha = (1 − flashProgress)*0.3`. This is an **alpha/width pulse** (the whole segment
    brightens then fades) — eqx-peri uses no travelling-dash, so neither do we (simpler +
    matches the source).
  - **Material → colour:** `power` → default cyan **`0x44ddff`**; `minerals` → a warm
    ore tone (e.g. **`0xee8844`**, eqx-peri's M-type iron colour) so power vs mineral
    pulses read differently. (eqx-peri's full `MATERIAL_COLORS` table maps many ore
    types; we have one mineral, so one colour.)
  - Endpoints looked up by id from the swarm render bucket — re-read the resolved
    `entry.x/y`, **never re-interpolate** (one-pose-per-frame rule). Unconnected/unpowered
    structures render dimmed. HUD power readout via Zustand `gridNetPower` (discrete — OK).
- **Constants** (`src/core/structures/structureGridConstants.ts`):
  `CONNECTION_MAX_RANGE = 600`, `CONNECTION_THROUGHPUT = 100000`, `TRANSFER_PULSE_MS = 1000`,
  `FLASH_DURATION_MS = 300`; per-kind `maxConnections` live in the catalogue.

### 3f. Tests

- `src/core/structures/Connection.test.ts` — endpoint traversal, length, flash window.
- `src/core/structures/Grid.test.ts` — `canConnect` rules (**hub-required: leaf↔leaf
  REJECTED, leaf↔connector/capital ACCEPTED**; `maxConnections` cap: 7th link to a
  Connector rejected, 2nd link to a leaf rejected; edge-to-edge range; no-self/no-dup;
  LOS), BFS components, power aggregation, A* routing + route-cache invalidation, sever.
- `tests/integration/sectorRoom/structureGrid.test.ts` — place capital, then a connector
  in range of it, then a solar in range of the connector → `structures[]` shows the
  **web** (solar→connector→capital `connTo`), `powered:true`, positive `netPower`; assert a
  solar placed adjacent to another solar (no hub in range) is **unconnected/unpowered**
  (proves leaf↔leaf is rejected); destroy the connector → solar severs and reports
  unpowered.
- `tests/integration/sectorRoom/structureConstruction.test.ts` — **the flow economy**:
  seed Capital storage, place a Connector blueprint in range → over successive pulses
  `buildPct` climbs by `CONSTRUCTION_PULSE_AMOUNT/constructionCost` and Capital minerals
  drop in lockstep; on completion `built:true` + HP=maxHealth + it now relays (a leaf
  behind it starts building only *after*). **Pause test:** empty the Capital mid-build →
  `buildPct` stops advancing across pulses, refill → it resumes (no progress lost).
  **Dead-end test:** a leaf behind an *unbuilt* Connector receives nothing until the
  Connector completes. **Repair test:** damage a built structure → HP climbs `REPAIR_PULSE_AMOUNT/REPAIR_COST_PER_HP`
  per pulse, debiting minerals.
- **Netgate:** the `structures[]` slice + `grid_pulse` touch the snapshot/broadcast path →
  `pnpm e2e:netgate` required for this phase (invariant #8).

---

## Phase 4 — Mining towers + mining lasers + minerals

- **Server** (`StructureGridSubsystem` mining step): each miner's mount(s) `pickTarget`
  the nearest asteroid within `miningRange` (reuse `WeaponMountController`; target filter
  = asteroid records, `kind===0`). On the 1 Hz pulse, extract `miningRate` minerals
  (power-gated by grid netPower), accumulate, then pulse-transfer toward the capital's
  `storageCapacity`. Asteroids effectively-infinite for the first cut (per-asteroid
  reserve depletion is a noted follow-up). Mining never damages the asteroid.
- **Wire:** add `miningTargetId?` / `mountAngles?` to the miner's `structures[]` entry so
  the client can draw the beam to the right asteroid and aim the arms.
- **Client:** mining-laser beam from miner mount → target asteroid via `BeamSpritePool` +
  `LaserGlow`; mineral count in the HUD (Zustand `minerals`). Optional in-world mineral
  label near the capital (Pixi text).
- **Tests:** `tests/integration/sectorRoom/structureMining.test.ts` (miner near asteroid →
  capital minerals increase over pulses); E2E `tests/e2e/mining-beam.spec.ts` (beam
  visible; use `testTimeScale` to fast-forward pulses).

---

## Phase 5 — Defensive turrets

- **Server:** `tickStructureMounts()` (MountAimSubsystem pattern) aims turret mounts at
  the nearest hostile drone (`pickTarget`, filter `id.startsWith('swarm-')`), fires
  through `CombatSubsystem`/`AiFireResolver` keyed by the structure id, power-gated by
  grid netPower. Mount angles flow on the `structures[]` slice (quantised, emit-on-slew —
  same discipline as `drones[].mountAngles`).
- **Client:** turret barrel sprites + aim line (`MountVisualManager` pattern) + fire beam.
- **Tests:** `tests/integration/sectorRoom/structureTurret.test.ts` (turret + hostile
  drone → drone takes damage / dies); E2E turret-fires spec.
- **Netgate** again if the turret mount-angle path widens the snapshot writes.

---

## Cross-cutting

- **Docs (invariant #10):** `docs/architecture/structures-and-power-grid.md` (system
  internals: catalogue, wire slice, grid topology, **construction flow economy + dead-end
  rule**, pulse) + `docs/features/building.md` (player-facing: speed dial → **blueprint
  ghost** → place → **watch it build** → connect → power → mine → defend). Append
  `docs/LESSONS.md` for any gotcha (esp. the worker-camera-transform placement seam).
- **CLAUDE.md updates (invariant #7):** root catalogue note for `structureKinds.ts`
  (append-only); `src/server/CLAUDE.md` for the grid subsystem + `structures[]` slice
  threshold; `src/client/CLAUDE.md` for the SpeedDial + placement controller + connector
  render rules.
- **Invariants to honour:** #2 Zustand purity (minerals/power are discrete counts — OK;
  no x/y/angle in store), #3 zod at the boundary, #8 netgate for snapshot-path phases,
  #9/#13 tests accompany every behavioural change (and smoke-bug tests come first), #11
  append-only catalogues + pose-core byte, #14 no hot-loop allocation (grid pulse is
  1 Hz/off-tick; keep any per-tick glue scratch-reused).
- **Commit cadence:** each phase (and each step within) is its own green-bar commit on
  branch `claude/speed-dial-resource-structures-fmJZm`.

## Verification

- Inner loop per step: `pnpm typecheck && pnpm lint && pnpm test`.
- Server boot smoke after any server change: `timeout 8 pnpm dev:server` (expect
  `INFO: EQX Peri server started port: 2567`).
- Targeted E2E per phase (narrow `--project=chromium <spec> --reporter=line`, explicit
  Bash timeout).
- `pnpm e2e:netgate` for Phases 3 & 5 (snapshot-path touch).
- Manual (the full Space-Game build loop, all from the bottom-right SpeedDial): select a
  kind → a **translucent blueprint ghost** with range ring + candidate connect-line follows
  the cursor (green/red validity) → confirm drops a **scaffolding** that **builds up
  gradually** (fill bar climbs, Capital minerals tick down, connection flashes each pulse).
  Sequence: **Capital** (pre-built) → **Connector** (builds, then relays) → **Solar** off
  it (web lights up, netPower positive) → **Miner** near an asteroid (mining beam, minerals
  climb) → **Turret** (kills a drone). Confirm: emptying the bank **pauses** a build and it
  resumes on refill; a leaf with no hub in range stays dimmed until a Connector bridges it;
  a leaf behind an unbuilt Connector waits until that Connector finishes.
