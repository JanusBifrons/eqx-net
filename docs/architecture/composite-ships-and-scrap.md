# Composite ships + scrap-on-death

A ship can be authored from **multiple styled vector components** instead of a
single hull polygon, and on death it breaks into one free-floating **scrap**
piece per component. Geometry is ported verbatim from the sibling **Equinox**
prototype (`github.com/JanusBifrons/Equinox`). The first composite ship is
**Havok**.

This document is the why + the map. Rules live in the CLAUDE.md files; gotchas
in `docs/LESSONS.md`.

## The shape model

`ShipShape` (`src/shared-types/shipKinds/types.ts`) is a discriminated union:

- `{ kind: 'polygon', points, color, scale }` — the legacy single hull (all 8
  original kinds; visual silhouette == collision boundary).
- `{ kind: 'composite', scale, hull, parts }` — `parts: ShipPart[]` is the
  **visual** (each a styled polygon with `points`, `color`, optional
  `stroke`/`strokeWidth`, `offsetX/Y`, `role`, `canScrap`); `hull` is the single
  **gross collision outline**. A composite ship collides as one body (the
  `hull`) — per-part live collision is intentionally NOT modelled.

The seam `shipHullOutline(kind)` (`src/core/geometry/shipHullOutline.ts`) returns
`composite ? hull : points`, so every collision/physics reader is shape-agnostic
and polygon kinds stay byte-identical. `shipShapeScale` / `shipPrimaryColor` are
the sibling accessors.

Rendering: `buildCompositeShipGfx` (`src/client/render/pixi/spriteBuilders.ts`)
bakes all parts into ONE Pixi `Graphics` (one sprite / one draw per ship).

## Porting from Equinox

Equinox authors components in **+x = forward**, canvas **y-down**; eqx-net is
**Pixi-up** (nose at −y). `equinoxPartPoints`
(`src/shared-types/shipKinds/composite/equinoxTransform.ts`) reproduces Equinox's
`Component`: mirror (cross-axis) → scale → **centroid-centre** (`adjustCenter` —
the offset places the component's centroid, not its origin) → translate by
offset → re-frame `(x,y) → (y,−x)`. A sub-feature (the cockpit dome) passes
`centroidSource` so it stays glued to its parent component.

Havok (`src/shared-types/shipKinds/composite/havok.ts`) is the Equinox `debug.js`
assembly — 2 rear-wings, 2 wings, 2 pads, a cockpit body + the green canopy — 23
ShipParts total (7 primary-red silhouettes + 16 secondary-white detail shapes:
highlight strips, the wing portholes, the cockpit tip/tail strips, the
`scale(1.75,1)` dome ellipse). Its `hull` is the convex hull of all part points.
Preview: `pnpm tsx scripts/render-havok-preview.mjs`.

## Scrap-on-death

When a ship is destroyed, each composite **component** spins off as one
free-floating scrap piece.

- **Components** are grouped by `shipScrapGroups(kindId)`
  (`src/core/geometry/shipScrapGroups.ts`): a silhouette (`canScrap:true`) + its
  detail parts (role-prefix match), each recentred on the component centroid,
  with a convex-hull collider. Precomputed once at module load; polygon kinds
  yield none.
- **Wire**: scrap is `SWARM_KIND_SCRAP = 3` on the binary swarm wire
  (`SWARM_WIRE_VERSION 3 → 4`, a `componentIndex` u8 added; the existing
  `shipKind` byte carries the **parent** ship-kind). Geometry is NOT on the wire
  — the client looks the component up by `(parentShipKind, componentIndex)`.
- **Spawn** (`src/server/spawn/ScrapSpawner.ts`, hooked from the player
  `SHIP_DESTROYED` handler and the drone `createSwarmDeath` policy, *before*
  evict so the dying pose is still live): each piece spawns at its component's
  world pose (catalogue Pixi-up → world math-up via `x*scale,−y*scale` then
  rotate by the ship angle + translate — matching `shipShapeToPolygon`),
  inheriting the ship's velocity + a radial drift (`SCRAP_BURST_SPEED`), at the
  ship's angle.
- **Collision**: scrap is a dynamic body in `SCRAP_COLLISION_GROUPS`
  (`src/core/physics/collisionGroups.ts` = membership bit 1 / filter ~bit 1) so
  it collides with ships/asteroids/structures but NOT with other scrap. A new
  optional `collisionGroups` param threads `World.spawnObstacle → worker → proxy
  → SwarmSpawner`.
- **Damageable + permanent**: scrap is seeded `SCRAP_HP` (+ `swarmShield 0`) and
  the `EntityResolver` routes kind 3 to the drone leaf, so it can be shot and
  destroyed. A dying scrap piece does NOT recursively shatter (guarded in
  `SectorRoom.spawnScrapFromDrone`). There is no time-decay; a global FIFO cap
  (`MAX_LIVE_SCRAP`) bounds accumulation. **Scrap now PERSISTS across a server
  restart (Phase 5 v4):** the sector snapshot's `scrap[]` array carries each
  piece's drifted pose + `parentShipKind` + `componentIndex` + health, and the
  collider re-derives on hydrate from `(parentShipKind, componentIndex)` via the
  shared pure `scrapColliderFor` (so it's never persisted nor on the wire).
  Restored scrap is not re-added to the FIFO (a bounded snapshot set; the slot
  pool hard-caps).
- **Client render**: `scrapClientLeaf` builds the predWorld collider (same
  component collider + scrap group). It is **DRONE-like, NOT asteroid-like**
  (Phase-5 desync fix, 2026-06-14): the body is spawned **UNLOCKED** at the
  server's `SCRAP_DEFAULT_MASS`. Since 2026-11-08 its body follows the
  remote-entity anchor, like drones and remote ships (latest server state each
  snapshot, stepped on the predicted timeline, never re-posed per frame — see
  `drone-snapshot-interpolation.md`), so the local player's predicted shove
  matches the server's dynamic mass-1 scrap; its sprite draws the single
  interpolated pose (`entry.kind === 3` joins the `=== 1` drawn-pose branch).
  It was a per-frame kinematic follower of the drawn pose from 2026-06-14 to
  2026-11-08. **Why it was made dynamic:** scrap was originally
  locked + reposed like an asteroid, making it an infinite-mass wall the player
  bounced off in prediction while the server let them shove it — every snapshot
  reconciled that divergence as a "huge spike in corrections" (the user's
  report). `buildScrapGfx` renders the component's recentred sub-shapes from the
  catalogue (keeping their colours so a dead ship visibly comes apart). Lock:
  `scrapClientLeaf.test.ts` (drives a ship into a scrap fragment in the real
  predWorld; the fragment must be shoved, not immovable). Preview:
  `pnpm tsx scripts/render-scrap-preview.mjs`.

## Deferred

Capital break-up (the "capitals leave no scrap yet" gap) is designed in
[capital-destruction.md](capital-destruction.md): a capital fractures where
it was hit into seeded Voronoi wreck pieces, instead of hand-authored scrap
components.

- Converting the other 7 kinds to composites; porting the rest of the Equinox
  component palette (RoundEngine, RectHull/HexHull, ShortPillar).
- Optional scrap polish: spin, salvage/economy ties.
- **Capitals leave no scrap yet.** The capital kinds are composite, but
  `warshipDesign` marks no part `canScrap`, so `shipScrapGroups` is empty and a
  dying capital (player or NPC) only explodes. How a kilometre-long hull breaks
  up (which sections, their mass and HP; `SCRAP_DEFAULT_MASS` 1 and `SCRAP_HP`
  30 are fighter-sized) is an open owner decision (found 2026-11-12). Its death
  blast does follow the hull (`blastRadiusFor`).

## Core reference

Moved from `src/core/CLAUDE.md` (section "Composite ships + scrap geometry").

- `ShipShape` is a discriminated union (`polygon | composite`). The
  `shipHullOutline(kind)` seam (`geometry/shipHullOutline.ts`) returns the
  composite `hull` or the polygon `points` — **every collision/physics reader
  goes through it**, so polygon kinds are byte-identical. The
  "silhouette == collider" invariant is RELAXED for composites: the collider is
  the authored gross `hull`; the visual `parts[]` are detail (per-part live
  collision is intentionally NOT modelled). `shipShapeScale` / `shipPrimaryColor`
  are the sibling accessors.
- `geometry/shipScrapGroups.ts` precomputes ONCE at module load (like
  `shipHullDecomp`) one scrap GROUP per composite component — a silhouette
  (`canScrap:true`) + its detail parts (role-prefix), each recentred on the
  component centroid, with a convex-hull collider. Polygon kinds → empty. The
  death→scrap path (server) and `buildScrapGfx` (client) both read it.
- `physics/collisionGroups.ts` `SCRAP_COLLISION_GROUPS` (membership bit 1 /
  filter ~bit 1) makes scrap NOT collide with other scrap but collide with
  everything else. Threaded through `World.spawnObstacle`'s optional
  `collisionGroups` param (→ worker `SPAWN_OBSTACLE`). `swarm/scrapConstants.ts`
  holds the tuning (burst/damping/HP/MAX_LIVE_SCRAP). Full story:
  [docs/architecture/composite-ships-and-scrap.md](../../docs/architecture/composite-ships-and-scrap.md).
## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Abandon → scrap; wrecks RETIRED (Equinox P6.3 / C2+C3, 2026-06-15 — supersedes "abandon → wreck")

**Scrap replaces wrecks.** An abandoned hull no longer becomes a damageable `WreckState` entity — it shatters into drifting scrap and leaves the world (the user's "wrecks shouldn't exist any more; it just turns into scrap"). `findAbandonedShips` ([rooms/sectorIdleEvaluator.ts](../../src/server/rooms/sectorIdleEvaluator.ts)) still returns BOTH active and lingering abandoned ships (roster-row deleted while alive) with a `lingering` flag; the `update()` poll now routes active → `SectorRoom.abandonShipToScrap(playerId)` and lingering → `SectorRoom.abandonLingeringHullToScrap(shipInstanceId)`. Both spawn scrap at the death pose via the shared `spawnHullScrap` (composite kinds shatter, polygon kinds just vanish), then DESPAWN the body + free the slot (no wreck rekey) + tear down bookkeeping; the active path also ejects the owning session (`ship_abandoned` + `client.leave`). The lingering path is **shipInstanceId-keyed** (the owner may be piloting a DIFFERENT active hull) and **never touches any playerId-keyed map** — it mirrors the lingering-hull DEATH policy (`createLingeringHullEntity`), so combat-death and abandon end identically. Locks: [abandonToScrap.test.ts](../../tests/integration/sectorRoom/abandonToScrap.test.ts) + [abandonLingeringToScrap.test.ts](../../tests/integration/sectorRoom/abandonLingeringToScrap.test.ts). The galaxy-only linger/abandon/pool flows are E2E-driven through the isolated `galaxy-test` room + the `lingerMs` trigger (see the root CLAUDE.md bespoke-triggers table).

### Scrap-on-death (2026-06-13)

A composite ship breaks into one **scrap** swarm entity (kind 3) per component
on death — both players AND drones. `ScrapSpawner` (`spawn/ScrapSpawner.ts`,
hand-rolled-mock testable) owns the decision: per `shipScrapGroups(kind)`
component it spawns at the component's world pose (catalogue Pixi-up → world
math-up via `x*scale,-y*scale`, rotate by ship angle, translate — matching
`shipShapeToPolygon`), inheriting ship velocity + a radial `SCRAP_BURST_SPEED`
drift, at the ship's angle. Death hooks (ALL spawn BEFORE the slot is freed so
the dying pose is live): drone via `swarmDamageStrategy.createSwarmDeath`'s
optional `spawnScrapFromDrone` `LeafDeps` seam; ACTIVE player hull via the
`SHIP_DESTROYED` handler in `SectorRoom` (pose from `shipPoseCache`/SAB); and
**LINGERING hull (Equinox P6.3) via the `spawnScrapFromLingeringHull` `LeafDeps`
seam** called inside `createLingeringHullEntity`'s death policy (pose read from
`lingeringPoseCache` before that policy tears it down — the `SHIP_DESTROYED`
path can't serve a lingering hull: its slot/pose are gone by emit time AND
`getActiveShip(shipInstanceId)` is undefined; lock `lingeringScrapOnDeath.test.ts`).
Polygon kinds yield nothing. **Scrap is DAMAGEABLE**: seeded `SCRAP_HP` + `swarmShield 0`,
and `EntityResolver` routes kind 3 to the drone leaf (hits hull → destroyed) —
GUARDED so a dying scrap piece does NOT recursively shatter
(`SectorRoom.spawnScrapFromDrone` returns early for kind 3). No time-decay; a
global FIFO cap (`MAX_LIVE_SCRAP`, `notifyRemoved` on eviction) bounds it. Scrap
is EXCLUDED from `SectorPersistence` (transient debris). Wire: `SWARM_KIND_SCRAP`
+ a `componentIndex` byte bumped `SWARM_WIRE_VERSION 3 → 4` → **netgate applies**
(invariant #8). Locks: `ScrapSpawner.test.ts` + `scrapOnDeath.test.ts`
(integration). See [docs/architecture/composite-ships-and-scrap.md](../../docs/architecture/composite-ships-and-scrap.md).

## Core reference

Moved from `src/core/CLAUDE.md` (section "Composite ships + scrap geometry").

- `ShipShape` is a discriminated union (`polygon | composite`). The
  `shipHullOutline(kind)` seam (`geometry/shipHullOutline.ts`) returns the
  composite `hull` or the polygon `points` — **every collision/physics reader
  goes through it**, so polygon kinds are byte-identical. The
  "silhouette == collider" invariant is RELAXED for composites: the collider is
  the authored gross `hull`; the visual `parts[]` are detail (per-part live
  collision is intentionally NOT modelled). `shipShapeScale` / `shipPrimaryColor`
  are the sibling accessors.
- `geometry/shipScrapGroups.ts` precomputes ONCE at module load (like
  `shipHullDecomp`) one scrap GROUP per composite component — a silhouette
  (`canScrap:true`) + its detail parts (role-prefix), each recentred on the
  component centroid, with a convex-hull collider. Polygon kinds → empty. The
  death→scrap path (server) and `buildScrapGfx` (client) both read it.
- `physics/collisionGroups.ts` `SCRAP_COLLISION_GROUPS` (membership bit 1 /
  filter ~bit 1) makes scrap NOT collide with other scrap but collide with
  everything else. Threaded through `World.spawnObstacle`'s optional
  `collisionGroups` param (→ worker `SPAWN_OBSTACLE`). `swarm/scrapConstants.ts`
  holds the tuning (burst/damping/HP/MAX_LIVE_SCRAP). Full story:
  [docs/architecture/composite-ships-and-scrap.md](../../docs/architecture/composite-ships-and-scrap.md).

## History

> **C3 (done) removed the wreck ENTITY end-to-end** — `WreckState` + `state.wrecks`, `SnapshotMessage.wrecks`, `WreckLifecycleCoordinator`, the `EntityResolver` wreck branch + `WreckEntity` leaf + the wreck `EntityKindTag`, the client `mirror.wrecks` render/select/pick/hover paths, and `wreck-render-probe.spec.ts` are all gone. No `WreckState` exists; the abandon/death paths above are the only hull-removal flows, and both produce scrap. (Removing `SnapshotMessage.wrecks` is a JSON-field removal, NOT a `SWARM_WIRE_VERSION` bump — the binary swarm wire is untouched.)
