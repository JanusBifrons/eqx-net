# Structures Follow-ups — Turret/Miner Visuals, Click-to-Inspect, Connector Preview + Obstacle Blocking

> **Handoff for a fresh agent.** All paths relative to the repo root. This is an
> APPROVED, not-yet-started plan covering four items from on-device play of the
> structure/build system. Branch: `feat/structure-tap-placement` (builds on the
> shipped tap-to-place + collision-impact-speed + living-world-disarm +
> placement-production-channel work). A copy also lives at the planning path
> `C:\Users\alecv\.claude\plans\i-want-you-to-majestic-pie.md`.

## Context

Four issues surfaced from on-device play of the structure/build system:

- **A. Turret + miner visuals are broken.** A Turret ("defence tower") renders as
  *only a triangle* — no barrel, no aiming, no firing visual. A Miner is
  invisible / absent.
- **B. No way to inspect entities.** Click an entity to draw a box around it and
  show stats (health, etc.) — for all ships and structures (and drones/wrecks),
  **except the player's own ship**.
- **C. No connection-range feedback before placing.** Connector lines only draw
  *after* a structure is placed, so the player can't tell if a spot is in range.
- **D. Connectors route through obstacles.** A connection can form *through* an
  asteroid or another building; this should be disallowed.

### Decisions (confirmed with the user)
- **D — blocked connector → place it but leave it unconnected** (do NOT reject the
  placement). It places dimmed/unpowered, exactly like an out-of-range placement
  today; the Item-C preview warns the player before they commit.
- **B — live-updating stats** while an entity is selected (watch an enemy's HP
  drop), via a small selection-scoped server channel (~5 Hz, only the one
  selected entity). Selectable = every entity **except the local player's own
  ship** (own structures/drones ARE inspectable).

### Project rules that bind this work (CLAUDE.md)
- **#2** No spatial fields (x/y/vx/vy/angle/...) in Zustand. Spatial state lives in
  the render mirror / a non-Zustand module singleton.
- **#11** Ship- and structure-kind catalogues are append-only; the binary swarm
  wire is **v3** — no reorder/format change here, no `SWARM_WIRE_VERSION` bump.
- **#13** Smoke-reported bugs get a **failing test first, at the level where the
  bug lives**, then the fix.
- **#14** No new allocation in hot loops (render/tick/snapshot) — reuse
  module-scope scratch.
- **webdriver-dataset trap (just fixed):** the client `data-*` dataset is gated
  behind `navigator.webdriver` and is **E2E-only**. Never read it for production
  UI; use a module singleton (canonical pattern:
  `src/client/structures/placementChosen.ts`) or non-spatial Zustand. For E2E
  observability use `RendererFeedback` fields or `window.__eqxLogs`, never `data-*`.
- **Scenario room:** `structure-scenario-test` (`SectorRoom.seedStructureScenario`)
  bakes a prebuilt Capital + 2 Solar + Miner@asteroid + Turret@drone;
  `structureGridPulseMs` fast-forwards the grid. Reach it via
  `?room=structure-scenario-test&worker=0`. Use it to reproduce/verify A, C, D.

### Phasing / ordering: **A → D → C → B**
A is independent and a fast on-device win. D is a pure-core change that **C depends
on** (the preview must use the same obstacle-aware `canConnect` the server uses).
B is the largest and independent. Commit each item separately when its inner loop
(`pnpm typecheck && pnpm lint && pnpm test`) is green.

---

## Item A — Structure turret + miner visuals

**Root cause (confirmed):** `src/client/render/pixi/swarmSpriteUpdater.ts:91` gates
mount-visual rendering behind `if (entry.kind === 1 && entry.shipKind)` (drones
only). Structures are `entry.kind === 2`, so `ctx.mountVisuals.ensureForShip()` +
`applyMountAngles()` are **never** called for them. Both TURRET (mount `barrel`,
`weaponId 'hitscan'`) and MINER (mount `drill`, `weaponId 'laser'`) carry mounts in
`src/shared-types/structureKinds.ts`. So the turret is just its 3-sided base
polygon (the "triangle") with no barrel.

**Ground truth:** structures carry **no `mountAngles`** on any wire —
`StructureGridSubsystem.tickTurrets` only sets `turretTargetEntityId`, and the
snapshot structures slice (`SectorRoom.rebuildStructuresSlice`) emits only
`turretTargetId` / `miningTargetId`. So the barrel angle must be **derived
client-side** from the target id + the target's pose (no wire bump).

**Changes:**
1. `src/client/render/MountVisualManager.ts` — add `ensureForMounts(id, kindId,
   mounts, color, parent)` taking the mount list + tint **directly** (structures
   use a flat `.color`, not ship `.shape.color`, so `ensureForShip` can't be reused
   as-is). Refactor `buildTurretGfx`/`buildAimLineGfx` to take an explicit
   `color: number`; keep `ensureForShip` as a thin wrapper that delegates (one
   construction path). `applyMountAngles` already takes an explicit `mounts` array
   — unchanged.
2. `src/client/render/pixi/swarmSpriteUpdater.ts` — add a `kind===2` branch
   (after the `kind===1` block): `const sk = getStructureKind(entry.shipKind)`,
   `ensureForMounts(spriteKey, sk.id, sk.mounts ?? [], sk.color, sprite)`. Derive
   the barrel angle client-side: `targetId = st.turretTargetId ?? st.miningTargetId`
   (each leaf structure has one mount, index 0); if `mirror.swarm.get(targetId)`
   resolves, compute the world bearing structure→target, convert into the mount's
   arc-local frame (subtract body angle + `mount.baseAngle`, same Y-flip
   `applyMountAngles` uses), clamp via `WeaponMountController.clampToArc`, and pass
   it in a **module-scratch `mountAngles` array** (invariant #14). No target →
   leave at base. **The aim convention is load-bearing** — a sign error points the
   barrel 180° off; validate in the scenario room with a screenshot + an angle
   assertion.
3. **Miner-invisible — diagnose, don't guess.** Join
   `?room=structure-scenario-test&worker=0`; confirm the miner is in `mirror.swarm`
   (kind 2); check `mirror.structures.get(minerId).built` (scaffolding renders at
   `alpha 0.45`, lines 112-114 — fast-forward via `structureGridPulseMs` if
   unbuilt); confirm it isn't simply z-stacked behind its asteroid. Document the
   real finding and fix accordingly (likely: it reads as a bare polygon with no
   drill, fixed by the mount-visual branch above; OR a legibility/alpha tweak).

**Wire/schema:** none. No `SWARM_WIRE_VERSION` bump, no catalogue change.

**Failing-first tests (#13):**
- PRIMARY (bug's level): `swarmSpriteUpdater.structureMounts.test.ts` — a
  `{kind:2, shipKind:'turret'}` swarm entry + a `structures` entry with
  `turretTargetId` ⇒ assert the structure sprite gained a barrel child
  (`mountVisuals.mountCountForShip('swarm-<id>') === 1`) and a non-zero rotation
  aimed at the target. **Fails today** (no `kind===2` branch). Sibling MINER case
  with `miningTargetId`.
- Unit on `ensureForMounts` — builds exactly one barrel + aim-line, tint from the
  passed `color`.
- E2E via the scenario room — assert structure mount count > 0 through
  `RendererFeedback.mountCounts` (extend `swarmSpriteUpdater` to populate it for
  swarm sprites) + a screenshot.

**Reuse:** `MountVisualManager`, `getStructureKind().mounts`,
`WeaponMountController.clampToArc`/`wrapPi`, resolved structure + target poses,
`RendererFeedback.mountCounts`.

---

## Item D — Block connectors through asteroids / obstructions

**Root cause:** `canConnect` (`src/core/structures/Grid.ts:125`) already returns
`'blocked'` via `isConnectionLineBlocked(a,b,nodes)` (line 101) — but that only
tests the segment vs OTHER STRUCTURES' AABBs (`segmentIntersectsAabb`, line 72).
Asteroids aren't in `nodes`, so connectors pass straight through them.

**Changes:**
1. `src/core/structures/Grid.ts` — add `interface GridObstacle { x; y; radius }`.
   Extend `isConnectionLineBlocked(a, b, nodes, obstacles?)` to also test the
   segment against each obstacle, reusing `segmentIntersectsAabb(a.x,a.y,b.x,b.y,
   o.x-o.r, o.y-o.r, o.x+o.r, o.y+o.r)` (AABB/square approximation — cheap, proven,
   consistent with the existing structure test; a precise polygon test via
   `generateAsteroidVertices` + slab-clip is a deferred higher-fidelity option).
   Thread `obstacles?` through `canConnect(a,b,adjacency,nodes,obstacles?)`. **Keep
   the param OPTIONAL** so existing callers/tests stay byte-identical when omitted.
2. `src/server/structures/structureGridView.ts` — `autoConnectStructure` gains an
   `obstacles` argument; the `SectorRoom` call site builds the asteroid list from
   the swarm registry filtered to `kind===0` → `{x,y,radius}[]` and passes it into
   `canConnect`. `buildGridNodes` unchanged.
3. **Behaviour (confirmed): place-but-stay-unconnected.** `autoConnectStructure`
   already returns `null` (structure renders dimmed/unpowered) when no hub
   qualifies — blocked-by-asteroid is just another "no qualifying hub". Do **not**
   add a placement-rejection path. The Item-C preview warns the player first.

**Wire/schema:** none — pure-core signature extension + server passing existing
swarm data. Run `pnpm e2e:netgate` (this can change the structures-slice `connTo`
content, invariant #8).

**Failing-first tests (#13):**
- PRIMARY core unit (`Grid.obstacles.test.ts` or extend `Grid.test.ts`): two
  in-range hubs with an obstacle ON the segment ⇒
  `canConnect(...,[obstacle]).reason === 'blocked'`; off-segment / no obstacle ⇒
  `{ok:true}`. **Fails today.** Also assert the optional-param call (no obstacles)
  is identical to current behaviour.
- Server integration in `tests/integration/sectorRoom/` (mirror
  `structureScenario.test.ts`): two hubs with an asteroid between them ⇒ no
  connection forms (`connTo` empty for the pair).

**Reuse:** `segmentIntersectsAabb`; swarm `kind===0` asteroids server-side (and
`mirror.swarm` `kind===0` client-side for Item C).

---

## Item C — Connector connection-range PREVIEW lines (uses Item D)

**Goal:** while `mirror.pendingPlacementPreview` is set, draw preview lines from
the ghost to the hubs it WOULD connect to (green = would connect; dim/red =
in-range-but-blocked), using the SAME obstacle-aware `canConnect` from Item D so
the preview matches what the server will actually do.

**Changes / new files:**
1. NEW `src/client/structures/mirrorToGridNode.ts` (pure, unit-testable):
   `structureMirrorToGridNode(entityId, structureState, swarmEntry)`
   (isHub/maxConnections/isCapital/radius from
   `getStructureKind(swarmEntry.shipKind)`, `isConstructed = built`, pose from
   `swarmEntry.x/y`); `ghostToGridNode(preview, kind)`;
   `asteroidObstaclesFromSwarm(swarm)` → `{x,y,radius}[]` filling a **module-scratch
   array in place** (invariant #14). Build adjacency from `mirror.structures[].connTo`
   so "hub full" previews correctly.
2. `src/client/render/pixi/ConnectorRenderer.ts` — add a preview pass gated on
   `mirror.pendingPlacementPreview != null`: for each existing structure, run
   obstacle-aware `canConnect(ghostNode, structureNode, adjacency, nodes, obstacles)`
   and draw ghost→structure styled by the result (`ok`→green; `blocked`→dim red;
   `out-of-range`→skip/faint). Pure style params in a small helper mirroring
   `connectorVisual.ts`. Reuse a module-scratch obstacle array + one reusable ghost
   `GridNode`; no per-frame Map allocation; runs only while a ghost is up.
3. Add `RendererFeedback.placementPreviewConnectionCount: number` (count of green
   "would-connect" lines), threaded through `renderer.worker.ts` FEEDBACK post +
   `WorkerRendererClient.emptyFeedback` + the FEEDBACK handler + `protocol.test.ts`
   fixture. E2E asserts via this feedback field (not the webdriver dataset).

**Wire/schema:** none on the network wire; one additive `RendererFeedback` field.

**Failing-first tests (#13):**
- Unit on `mirrorToGridNode.ts` adapters (correct GridNode/obstacle mapping).
- Unit on the preview-style helper (`ok`→green, `blocked`→red, out-of-range→skip).
- PRIMARY E2E `structure-connector-preview.spec.ts` (scenario room): position a
  Connector ghost near a hub ⇒ `placementPreviewConnectionCount >= 1`; second case
  with an asteroid between ghost and the only hub ⇒ count 0 (ties D into the
  preview). **Fails today.**

**Reuse:** obstacle-aware `canConnect`/`isConnectionLineBlocked` (Item D),
`getStructureKind`, `mirror.structures/swarm/pendingPlacementPreview`,
`connectorVisual.ts` pattern, single-`Graphics` draw model, `RendererFeedback`.

---

## Item B — Click-to-inspect: selection bracket + live stats panel (largest)

**B1 — Pure pick fn.** NEW `src/client/render/pickEntity.ts`:
`pickEntityAt(worldX, worldY, mirror)` scans `mirror.ships`, `mirror.swarm`
(kind 1 drones + kind 2 structures; EXCLUDE kind 0 asteroids), `mirror.wrecks`;
returns the nearest within radius/tap-slop. **Excludes the own ship via
`mirror.localShipInstanceId`** (NOT bare `localPlayerId` — a displaced player owns a
lingering hull AND a new active ship). Ships lack a mirror radius → derive from
`getShipKind` collision radius or a fixed slop. Pure (no Pixi/DOM).

**B2 — Tap routing.** `src/client/render/PixiRenderer.ts`: add a gameplay-tap
branch beside galaxy + placement — when the tap resolves AND
`!galaxyLayer.isPanZoomActive()` AND `!_placementActive`, `camera.screenToWorld`
→ game coords (`gameY = -w.y`) → `pickEntityAt(..., _lastMirror)`. Do the pick
**renderer-side** (it has the mirror + camera on both worker and main paths).
Renderer owns `_selectedId` (set on pick, toggled off on re-tap of the same
entity, cleared on empty-space tap) and publishes it via a new
`RendererFeedback.selectedPickId` (+ `selectedPickKind`).

**B3 — Selection id in Zustand.** `state/store.ts` + `state/storeTypes.ts`: add
discrete `selectedEntityId: string|null`, `selectedEntityKind`, and setters
(sibling of `placementKind` — invariant #2 clean). The main thread writes it from
`RendererFeedback.selectedPickId` transitions (on change only).

**B4 — World bracket.** NEW `src/client/render/SelectionBracket.ts`: mirror
`HealthBars.ts` — ONE pooled `Graphics` (single selection), draw a 4-corner
bracket at the selected entity's screen pos (`pixiY = -gameY`) sized to its radius;
dirty-flag redraw + module scratch (invariant #14). Wire into `PixiRenderer.update`
alongside the health bars. No state round-trip — the renderer already owns
`_selectedId`.

**B5 — Live selection-scoped stats channel.** New discrete messages (zod
`.strict()` in `src/shared-types/messages/`): client→server `select_entity {id}` /
`deselect_entity {}`; server→client `entity_stats { id, kind, name, hp, hpMax,
shield?, shieldMax? }`. `SectorRoom.onMessage` tracks per-connection selection and
emits `entity_stats` at **~5 Hz on its own low-Hz timer** (off the hot path), only
to the selecting client, stopping on deselect / death / disconnect / transit.
**Drones + wrecks DON'T use the channel** — read `mirror.swarm.healthFrac` /
`mirror.wrecks.health` directly; only player ships + structures need
`entity_stats` (the snapshot deliberately omits remote-ship health, and structures
carry only build pct). Client stores stats in a `selectionStats` **module
singleton** (mirror `placementChosen.ts`), mutated in place — avoids 5 Hz React
re-renders. Only the discrete `selectedEntityId` lives in Zustand (panel
visibility).

**B6 — React/MUI panel.** NEW `src/client/components/EntityStatsPanel.tsx`:
pattern after `ShieldHullBar.tsx` / `StructurePlacementBanner.tsx` — reads
`selectedEntityId` (visibility) from Zustand + `selectionStats` (poll, ~1 Hz) for
the numbers; shows kind/name + health (+ shield) bars; tiny (9–11 px, `p:0.5`),
anchored via the Slot system. Empty-space tap deselects (hides the panel).

**Wire/schema:** NEW discrete `select_entity`/`deselect_entity`/`entity_stats`
(selection-scoped, low-Hz, NOT snapshot/binary additions — no `SWARM_WIRE_VERSION`
/ catalogue bump). NEW `RendererFeedback.selectedPickId` (+kind). NEW discrete
Zustand `selectedEntityId`/`selectedEntityKind`.

**Failing-first tests (#13):**
- PRIMARY unit on `pickEntity.ts`: tap-in-drone → that drone; tap own ship
  (`localShipInstanceId` match) → null; empty → null; overlap → nearest; asteroid
  → not selectable.
- Component `EntityStatsPanel.test.tsx` (jsdom): renders name + hp bar when
  selected + stats present; hidden when id null.
- Server handler test: `select_entity` → emission; `deselect_entity` / death →
  stops.
- E2E in a combat room: tap a drone → bracket (via `selectedPickId` feedback, not
  the dataset) + panel with the drone's hp; empty-tap → both gone. **Fails today.**

**Reuse:** `HealthBars`/`Labels` pooled-Graphics + dirty-flag pattern,
`camera.screenToWorld`/`toScreen`, existing `onTap` plumbing, `localShipInstanceId`,
`swarm[].healthFrac` / `wrecks[].health`, `placementChosen.ts` singleton pattern,
`ShieldHullBar`/`StructurePlacementBanner`, the Slot/anchor system, zod `.strict()`,
`RendererFeedback`.

**Risks:** tap-mode cross-fire — gate precisely on `!isPanZoomActive() &&
!_placementActive` and regression-test all three tap modes; per-frame bracket cost
(single Graphics + dirty flag); own-ship identity (`localShipInstanceId`, not
`localPlayerId`); stats-channel lifecycle leaks (clean per-connection selection on
deselect/disconnect/death/transit); netgate if `entity_stats` nears the send loop
(keep it on its own timer).

---

## Cross-cutting compliance
- **#2:** selection id is a discrete string; placement/preview poses stay in the
  render mirror; hp/shield are non-spatial.
- **#11:** no catalogue reorder, no `SWARM_WIRE_VERSION` bump anywhere; new B
  messages are discrete, not snapshot/binary fields.
- **#13:** each item lists its failing-first test at the bug's level.
- **#14:** module scratch in A (mountAngles), C (obstacle array + ghost node), B
  (bracket Graphics + styles).
- **webdriver trap:** all E2E observability via `RendererFeedback` / `window.__eqxLogs`.
- **#8 netgate:** run for D (canConnect → structures-slice content) and B (if
  `entity_stats` nears the send loop).

## Verification (end-to-end)
- Inner loop each item: `pnpm typecheck && pnpm lint && pnpm test`.
- A: scenario-room screenshot — turret shows a barrel that aims at its drone
  target; miner is visible (document the diagnosis). New
  `swarmSpriteUpdater.structureMounts.test.ts` green.
- D: `Grid` obstacle unit test + sector integration (asteroid between hubs → no
  connection). `pnpm e2e:netgate`.
- C: `structure-connector-preview.spec.ts` (scenario room) — preview count ≥1 near
  a hub, 0 through an asteroid.
- B: `pickEntity` unit, `EntityStatsPanel` component test, server-handler test,
  and an E2E (tap a drone → bracket + live-hp panel; empty-tap → gone).
- Boot smoke after server-touching changes (D, B): `timeout 8 pnpm dev:server`.
- Update `docs/architecture/structures-and-power-grid.md` (structure mount
  visuals, obstacle-aware connections, preview) and `src/client/CLAUDE.md` /
  `src/core/CLAUDE.md` per invariant #7; add a `docs/LESSONS.md` entry on the
  `kind===2` mount-visual gate.

## Suggested commit sequence
1. `fix(structures): render + aim turret/miner mount barrels (kind===2)` (+ miner
   diagnosis) — Item A
2. `feat(structures): obstacle-aware connections — block connectors through asteroids` — Item D
3. `feat(structures): live connection-range preview while positioning a blueprint` — Item C
4. `feat(client): click-to-inspect selection bracket + live entity stats panel` — Item B
   (may split B into pick/bracket, stats-channel, panel).
