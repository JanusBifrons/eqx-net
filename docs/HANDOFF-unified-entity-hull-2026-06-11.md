# Unified Entity Hull — one points→render+collision path; structures get polygon hulls + optional shield/hull

> ## ⚠️ CORRECTION (2026-06-11, after Phase 4 landed — read this first)
> The "latent bug … the real 'fly into a capital'" framing BELOW (fighter-shield
> borrow → `SET_HULL_EXPOSED` → collider shrinks to a fighter shape) is
> **FALSIFIED.** Structures are seeded **`swarmShield = 0` on spawn** (already
> hull-only), so they never break a shield, never post `SET_HULL_EXPOSED`, and
> **block correctly** (`tests/e2e/structure-ram-blocked.spec.ts` — the
> fly-through does NOT reproduce). What `c2bb51b2` actually fixed (Phase 4) was
> the **wrong REPORTED `shieldMax`/`hullMax`**: `damageSwarmLayered` resolved a
> structure subtype through `getShipKind('capital')` → the FIGHTER default
> (150/150) instead of the capital's 0/5000 — a stats-panel HP% bug, not a
> collider bug. Phase 4 is DONE (`resolveSwarmShieldHull` + generic optional
> shield + `structureKinds` optional shield schema, catalogue v2). **REMAINING
> = Phases 1–3** (the actual unification: structure `shape.points` → render +
> POLYGON collider, replacing the ball + the procedural `buildStructureGfx`).
> That work is still the user's directive and still valuable (collider == the
> rendered silhouette); it is NOT a bug fix. Treat Phase 0's repro as SUPERSEDED
> by Phase 4's `structureEntity.test.ts` lock.

> **Handoff for a fresh agent.** All paths relative to `C:\Users\alecv\Desktop\eqx-net\eqx-net`.
> **Step 0 (after approval):** create the branch `feat/unified-entity-hull`
> **STACKED on `feat/tship-collision-fix`** (PR #23 — this work depends on its
> triangle `setHullExposed` + `shipCollisionTriangles`, so branching off bare
> `main` would build on the reverted convexHull base + conflict). Rebase onto
> `main` once #23 merges. Copy this plan verbatim to
> `docs/HANDOFF-unified-entity-hull-2026-06-11.md` and commit it on the branch.
> **Predecessor:** PR #23 (`feat/tship-collision-fix`) shipped the T-ship hull
> fix — `setHullExposed` now emits TRIANGLE colliders (only triangles fire
> `CONTACT_FORCE_EVENTS` for static overlap), the crossguard is a clean T, and
> `shipCollisionTriangles()` exists in `shipHullDecomp.ts`. This plan builds ON
> that. Do NOT regress it.

## Context

A 2026-06-11 user directive ([[unified-entity-hull-directive]]): **ships and
structures (and anything new) must share ONE hull path** — an entity's *form* is
a series of points, and those points drive BOTH its rendering AND its collision
hull. No per-type lookup/special-casing; inherited generically (the Generic
Entity Pipeline ideal, [[gep-entity-system-directive]]).

**Today they diverge:**

| | Hull points | Render | Collider |
|---|---|---|---|
| **Ship** (kind 1) | `shipKinds[k].shape.points` (Pixi-up) + `scale` | `buildShipGfxFromShape(shape)` | `shipShapeToPolygon`→`decomposeForKind`→`shipCollisionTriangles` → TRIANGLE colliders (shield-down); ball (shield-up) |
| **Structure** (kind 2) | **none** | `buildStructureGfx(kindId, radius)` — **procedural** regular polygon (`STRUCTURE_SIDES` sides, cos/sin) | **BALL** (radius), always |

**The latent bug this also fixes — the real "fly into a capital."** Structures
reuse the DRONE shield→hull path (`StructureEntity` → `swarmDamageStrategy` →
`ShieldHullRouter.damageSwarmLayered`). That path reads the entity's `shipKind`
byte — but for a structure that byte is a *structure subtype* (`'capital'`),
which is **not** a ship kind, so `getShipKind('capital')` / `getDroneShieldMax` /
`getDroneMaxHealth` all **fall back to the fighter default**:
- shield pool = **fighter's** `shieldMax` (a capital gets a fighter-sized shield — accidental),
- `hullMax` reported = **fighter's** `maxHealth` (~750), not the capital's 5000 (wrong HP %),
- on shield-break it posts `SET_HULL_EXPOSED('capital')` → `getShipKind('capital')` = fighter → the worker swaps the structure's **radius-80 ball for a ~12u fighter triangle collider** (verified: `spawnObstacle` registers the body in the same `bodies` map `setHullExposed` reads — `World.ts`). After that the collider is tiny but the octagon still renders at 80 → **you fly into it.** Only triggers *after* the (small) shield breaks, which is why a short ram (`structure-ram-blocked.spec.ts`, 1.2 s) passes — the shield never drops.

The unification fixes this as a *consequence*: structures resolve their own
geometry + their own (optional) shield, never a ship shape.

### Decisions (confirmed with the user)

- **D1 — single hull pipeline.** One geometry path: `shape.points` (+ scale) →
  polygon → convex decomposition → triangle colliders + render gfx. Ships
  already use it; bring structures onto it. The per-catalogue source
  (`getShipKind` vs `getStructureKind`) is resolved ONCE at the edge by the
  pose-core `kind` byte the entity already carries (1 = ship/drone, 2 =
  structure) — a thin type-guard at spawn, NOT scattered branching (matches the
  realized GEP boundary).
- **D2 — collider = polygon matching the silhouette** (NOT a ball). Each
  structure gets a polygon collider equal to its rendered shape.
- **D3 — shield is OPTIONAL per kind; the HULL (points) is universal.** The
  shield is a decoupled optional layer. A kind WITH a shield: shield-up = bubble
  (ball, `radius + SHIELD_RADIUS_PAD`) + damage hits shield first, on break
  expose the hull polygon. A kind WITHOUT a shield: ALWAYS the hull polygon
  collider, damage straight to hull, no bubble, no break event, no aura.
  - **Shield-presence is a GENERIC, optional, per-kind ENTITY attribute**
    (user, 2026-06-11) — declared the SAME way for ships, structures, drones,
    anything: a kind either carries shield params (shieldMax + regen) or it
    doesn't, and the shared resolver treats "no shield params ⇒ shieldless"
    uniformly. **Do NOT special-case "ships always / structures never."**
    - **Current DATA:** every ship declares a shield (unchanged → byte-identical
      ship path), no structure does → today all structures take the shieldless
      path (hull polygon, damage straight to their own `maxHealth`). But the
      structure catalogue GAINS the optional shield SCHEMA so any structure can
      opt in later by setting the fields, with ZERO code change. This both
      removes the fighter-shield borrow (a structure resolves its OWN shield =
      none today) AND keeps the door open for a shielded structure. The shield
      bubble / `shieldDown` bit / aura fire generically for ANY kind that
      declares a shield — no structure exercises them today, but the code is not
      structure-blind.
- **D4 — ships stay byte-identical.** Ships already do points→render+collider;
  the work is making structures match + generalising the shared helpers. The
  ship decode/collider/render bytes must not move (netgate, Invariant #8).
- **D5 — own PR off `main`** (`feat/unified-entity-hull`), separate from #23.

### Project rules that bind this work (CLAUDE.md)

- **#8 Netgate** — this touches the live physics/collision loop (collider
  construction, `setHullExposed`, the shield model) → `pnpm e2e:netgate` is
  required, deferred to PR CI per [[for-the-netgate-and-full-suite-defer-to-pr-ci]]
  (local loop = typecheck + new tests + lint).
- **#11 Append-only catalogues.** Adding `shape` + optional shield fields to
  `structureKinds.ts` is ADDITIVE; bump `STRUCTURE_KIND_CATALOGUE_VERSION`. The
  structure subtype still rides the shared `shipKind` u8 (kind-2 path) — geometry
  is catalogue-derived, NOT wired, so **no `SWARM_WIRE_VERSION` bump**.
- **#13 Failing-test-first, at the level where the bug lives.** Phase 0 below.
- **#14 No new hot-loop allocation.** Hull triangles/parts are precomputed once
  per kind at module load (as ships already do); render reads them.
- **Hull conventions (from the just-shipped B3, do not relearn):** catalogue
  points are **Pixi-up** (Y down, nose −y); `shipShapeToPolygon` applies
  `y: -y*scale` (math-up for Rapier); `setHullExposed` emits **triangle**
  colliders fan-triangulated from convex parts; `stripCollinear` removes
  redundant collinear vertices (flat edges) so parts stay strictly convex + fan
  triangles are non-degenerate. Render: `sprite.x = gameX, sprite.y = -gameY,
  sprite.rotation = -angle`. These already make render == collider at all angles.

## Current code map (read before touching)

- `src/shared-types/shipKinds/*` — ship catalogue; `shape: {points, scale, color}`.
- `src/shared-types/structureKinds.ts` — structure catalogue; **has `radius`, no `shape`**, no shield fields. `STRUCTURE_SIDES` lives in the renderer, not here.
- `src/core/geometry/shipHullDecomp.ts` — `shipShapeToPolygon`, `decomposeForKind`, `stripCollinear`, `SHIP_KIND_COLLISION_PARTS`, `shipCollisionParts`, `shipCollisionTriangles`, `SHIP_KIND_COLLISION_TRIANGLES`. **Keyed by `ShipKindId`** — generalise.
- `src/core/physics/World.ts` — `spawnShip` (ball, then `setHullExposed`), `spawnObstacle` (registers in `bodies` with `kind: fighter` default!), `setHullExposed(id, exposed, kind: ShipKind)` (triangle colliders). The worker side.
- `src/core/physics/worker.ts` + the `SET_HULL_EXPOSED` `WorkerCommand` (`{id, exposed, kindId, tick}`) — carries `kindId`, worker resolves geometry. **Needs to discriminate ship vs structure geometry.**
- `src/client/render/pixi/spriteBuilders.ts` — `buildShipGfxFromShape`, `buildStructureGfx` (procedural; `STRUCTURE_SIDES`).
- `src/client/render/pixi/swarmSpriteUpdater.ts` — kind==2 → `buildStructureGfx`.
- `src/client/net/entity/leaves/structureClientLeaf.ts` — client predWorld: `spawnObstacle` BALL + `lockBody`. → polygon.
- `src/server/rooms/ShieldHullRouter.ts` — `damageSwarmLayered` (the fighter-fallback bug, lines ~142/156/158), `tickShieldRegen`.
- `src/server/entity/leaves/structureEntity.ts` + `swarmDamageStrategy.ts` — structure damage routing.
- `src/server/rooms/droneKindHelpers.ts` — `getDroneShieldMax`/`getDroneMaxHealth` (the `getShipKind` fallback).
- `src/core/combat/ShieldHull.ts` — the layered damage math (server-authority-only).

## Phases

### Phase 0 — Reproduce the capital fly-through (failing-test-first, RED)
The bug lives at the structure-damage → `SET_HULL_EXPOSED` → worker-collider
seam. Two locks:
- **Unit (`World`)**: spawn an obstacle (ball radius 80, a structure stand-in);
  call the structure shield-break path and assert the resulting collider extent
  is still ~80 (the structure hull), NOT ~12 (a fighter shape). RED today.
- **Integration (`SectorRoom`)** OR extend `structure-ram-blocked.spec.ts`: seed
  a structure, apply damage until its shield breaks, then assert it STILL blocks
  (rendered player Y stays short) AND `data-build-pct`/hull % reflects the
  structure's real `maxHealth`, not ~750. RED today.
Commit the RED test; it goes GREEN at Phase 3/4.

### Phase 1 — One hull-geometry pipeline (core)
- Author `shape: { points, scale, color }` for each structure in
  `structureKinds.ts` — explicit polygons matching today's silhouettes (capital
  octagon r80, connector hexagon r24, solar quad r40, miner pentagon r50, turret
  triangle r36; points authored Pixi-up like ships, e.g. a regular n-gon scaled
  to the radius). Bump `STRUCTURE_KIND_CATALOGUE_VERSION`.
- Generalise `shipHullDecomp.ts`: the decompose/triangulate internals take a
  `ShipShape`-like `{points, scale}` (rename the public helpers or add
  `hullPartsForShape(shape)` / `hullTrianglesForShape(shape)`). Precompute a
  `STRUCTURE_KIND_COLLISION_TRIANGLES` table the same way. **Ship tables stay
  byte-identical** (same inputs).
- Add the thin edge resolver: `hullTrianglesFor(kindByte, subtypeId)` →
  ship-or-structure triangles (the ONE place the type is discriminated).
- Unit: structure decomposition is convex + area-conserving (mirror
  `shipHullDecomp.test.ts`); golden snapshot of each structure's part count.

### Phase 2 — Render from points (client)
- `buildStructureGfx` draws from the structure's `shape.points` (via the shared
  `buildShipGfxFromShape` path). Delete the procedural `STRUCTURE_SIDES` cos/sin
  generation. Silhouette unchanged (authored points == prior regular polygons —
  verify by screenshot probe, like `tship-collision-probe`).

### Phase 3 — Polygon collider, unified (worker + client predWorld)
- `World.setHullExposed` builds the hull polygon for ship OR structure geometry
  via the Phase-1 resolver. The `SET_HULL_EXPOSED` worker command gains an
  entity-kind discriminator (or carries a unified kind key) so the worker
  resolves structure geometry, not the fighter fallback.
- `spawnObstacle` for a structure: register the real structure kind (not the
  fighter default) so `setHullExposed`/mass/inertia resolve correctly.
- Client `structureClientLeaf`: spawn the polygon collider (shield-state aware
  in the general code, but per D3 ALL structures are shieldless → always the
  hull polygon), `lockBody` (static).
- Per D3 every structure is shieldless: it spawns hull-exposed (polygon) from
  the start and NEVER swaps colliders — so there is no shield-break path to
  corrupt the collider. (The shield-up bubble branch exists generically for a
  future shielded structure, but no structure exercises it now.)

### Phase 4 — Generic optional shield (server + client)
Shield-presence is a generic per-kind attribute (D3): a kind carries shield
params or not; the shared model treats "absent ⇒ shieldless" uniformly across
ships + structures. Today: ships shielded, structures not — but by DATA, not by
type special-casing.
- Generalise the shield model so **absent/0 `shieldMax` ⇒ no shield layer**
  (always the hull polygon, damage straight to hull, no bubble, no break event,
  no aura). Ships (all shielded) stay byte-identical.
- Add the OPTIONAL shield SCHEMA to `structureKinds.ts` (`shieldMax` + regen
  delay/rate, all `.optional()`), so a structure CAN declare a shield. Current
  structures declare NONE → shieldless. (A future shielded structure is then
  DATA, not code.)
- `ShieldHullRouter` (and `droneKindHelpers`): resolve shield/hull from the
  entity's OWN catalogue generically — `getShipKind` for kind-1, `getStructureKind`
  for kind-2 — NEVER the cross-catalogue fighter fallback. A shieldless kind
  skips the shield entirely; the `SET_HULL_EXPOSED`-on-break (the
  collider-corruption source) only fires for a kind that ACTUALLY has a shield,
  so no structure triggers it today.
- `shieldDown` wire bit (reuse `SWARM_RECORD_FLAG_SHIELD_DOWN`) + `ShieldAura`
  fire generically for ANY entity that declares a shield (works if a structure
  opts in); no structure exercises them now.
- Fix the structure `hullMax`/`maxHealth` the B2 stats panel reads (real
  structure `maxHealth`, e.g. capital 5000 — not the fighter ~750).

### Phase 5 — Locks + verify
- Phase-0 repro → GREEN.
- `t-ship-no-self-collision`, `ramming-probe-armpit`, `structure-ram-blocked`,
  `structure-visible-damageable` → still GREEN.
- New: structure-polygon-collision E2E (ram a structure, blocked at the polygon
  edge); structure-stays-solid-under-sustained-damage (no collider swap — the
  Phase-0 fly-through repro, now GREEN because structures are shieldless);
  shieldless-kind-has-no-bubble (the optional-shield generalisation).
- Screenshot probe for structures (silhouette == collider overlay).
- `pnpm e2e:netgate` (PR CI).

## Risks / watch-outs
- **Ship byte-identity / netgate** — the ship collider+render+decode path must
  not move. Verify ship hull tables unchanged (golden test) + netgate.
- **Worker geometry resolution** — the worker must reach structure geometry
  without importing server-only code (the hull module is in `src/core`, OK). The
  `SET_HULL_EXPOSED` contract change is the load-bearing seam (keep the
  `WorkerCommand` union + `SectorRoom.WorkerCmd` + worker handler + the core
  CLAUDE.md note in sync).
- **Mass/inertia** — structures currently spawn via `spawnObstacle` with a
  default mass; the polygon swap must keep them heavy/static (they're locked
  client-side; server obstacle mass is `STRUCTURE_DEFAULT_MASS`). Don't let the
  zero-density collider math change the pinned mass.
- **Append-only** — structure catalogue edits bump
  `STRUCTURE_KIND_CATALOGUE_VERSION`; no `SWARM_WIRE_VERSION` bump.
- **Scope discipline** — do NOT silently swap architecture
  ([[feedback-never-deviate-from-plan-silently]]); if a phase can't hold
  byte-identity for ships or needs a wire bump, STOP and flag.

## Resolved (user, 2026-06-11)
- **Shield is a GENERIC optional per-kind attribute** (ship/structure/anything),
  resolved the same way; "no shield params ⇒ shieldless." **Current data:** all
  ships shielded (unchanged), no structure shielded → structures are hull-only
  TODAY. But the structure catalogue gets the optional shield SCHEMA so a
  structure can opt in by data alone (no code change), and the bubble/`shieldDown`/
  aura paths stay structure-capable. Not special-cased "structures never."
