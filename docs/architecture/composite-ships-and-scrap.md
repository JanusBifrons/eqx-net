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
  (`MAX_LIVE_SCRAP`) bounds accumulation. Scrap is excluded from persistence
  (transient debris; a cold boot starts with none).
- **Client render**: `scrapClientLeaf` builds the predWorld collider (same
  component collider + scrap group, locked + reposed), and `buildScrapGfx`
  renders the component's recentred sub-shapes from the catalogue (keeping their
  colours so a dead ship visibly comes apart). Smooth drift comes from
  `interpolateSwarmPose`. Preview: `pnpm tsx scripts/render-scrap-preview.mjs`.

## Deferred

- Converting the other 7 kinds to composites; porting the rest of the Equinox
  component palette (RoundEngine, RectHull/HexHull, ShortPillar).
- Optional scrap polish: spin, salvage/economy ties.
