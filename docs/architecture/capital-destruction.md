# Capital destruction: dynamic ship splitting (design, 2026-11-12)

Status: **design + slice S1 (the core fracture module) + slice S2a (server
wreck bodies, behind the `capitalWrecks` flag) + slice S2b (wrecks reach the
client and are drawn plainly).** S2c (persistence, lifting the cap) and S3
(art and glowing cut edges) are not built. Owner direction (2026-11-12): "Implement the ship splitting
dynamically", and "keep the damage model as an idea for now". The damage
model (zones, armour, internal systems, the destruction sequence) is parked in
[docs/SHELF.md](../SHELF.md) "Capital damage model".

Today a capital leaves no scrap: `warshipDesign` marks no part `canScrap`, so
`shipScrapGroups` is empty and a dying capital only explodes (see
[composite-ships-and-scrap.md](composite-ships-and-scrap.md) "Deferred").
Hand-authored scrap components suit a fighter; a kilometre-long hull should
break where it was hit. This doc is the plan for that.

## 1. The owner's spec (fracture part)

The owner gave this "with a pinch of salt". In short:

**Technique.**
1. Take the hull polygon (it may be concave).
2. Make Voronoi cells from seed points.
3. Clip each cell to the hull outline.
4. Run each piece through convex decomposition (Rapier needs convex shapes).
5. Spawn each piece as a rigid body.

**Looks.**
- Seeds cluster near the killing blow: small shattered pieces there, big
  chunks far away.
- Some cuts follow section boundaries, plus random ones.
- Jagged edges: subdivide cut lines and displace midpoints.
- Glowing cut edges: new edges are flagged so a shader glows them molten
  orange, then cools them to dark.
- Texture continuity: hull art is mapped from the ship's original local
  coordinates, so the pieces fit back together.
- Pieces inherit the ship's velocity, plus an outward push from the blast
  centre and a random spin.
- Staggered secondary breaks.
- A big white flash for the catastrophic case.
- Dust and shards are particles, not bodies; the number of real fragments is
  capped.

**Multiplayer.** Wrecks are terrain, so every client must fracture
identically. The server sends a seed; every client regenerates the geometry
deterministically; no geometry goes over the wire. The server stays
authoritative over wreck positions afterwards.

**Out of scope:** boarding/capture; damage stats and balance.

## 2. How it maps onto this codebase

| Spec item | Where it lives |
|---|---|
| Hull polygon | `shipHullOutline(kind)` (`src/core/geometry/shipHullOutline.ts`): the composite `hull` of each capital, local Pixi-up coordinates, authored at 1× |
| Voronoi, clip, jag, convex decomposition | **`src/core/destruction/`** (S1): pure, deterministic, no dependencies beyond the already-allowed `poly-decomp` |
| Seed + kill point | Chosen by the server at death (`SHIP_DESTROYED` / `createSwarmDeath`, where `ScrapSpawner` runs today) |
| Rigid bodies | One swarm entity per piece, the way scrap is spawned today (`ScrapSpawner`, `World.spawnObstacle` with `SCRAP_COLLISION_GROUPS`) |
| Poses on the wire | The binary swarm wire, a new scrap-like kind (S2) |
| Section boundaries | Derived from `warshipDesign` (barbette stations, superstructure blocks): straight lines across the beam |
| Glowing cut edges | Per-edge `cut` flags in the S1 output, read by a client shader (S3) |
| Texture continuity | Pieces keep the ship's local frame; the client samples the baked hull art at those coordinates (S3) |
| Size-dependent numbers | `shipTuning(kind)` (invariant #18): fracture runs on the 1× outline, then the piece outlines are scaled by the shape scale times the ship scale, exactly as `shipShapeToPolygon` does for the live collider |

Both sides run the same core function on the same inputs (invariant #15: the
contract lives in shared code). The server needs the convex parts for its
Rapier colliders; the client needs them for its predWorld twin and the
outlines for drawing.

## 3. Slices

Each slice is one PR, about one agent session, tests first.

### S1: core fracture module (this PR series)

`src/core/destruction/fractureHull.ts`:

- **Input:** hull polygon (local coordinates, either winding, concave
  allowed), seed (u32), kill point (local), optional section-boundary cut
  lines, max piece count (the cap, at most 64). Since `FRACTURE_ALGO_VERSION`
  2, the owner's decisions in §6 add:
  - `hullRadius`: the hull's size in local units. When it is left out, it is
    the farthest outline vertex from the ship's centre.
  - `killBlowDamage`: the killing blow's damage over max hull HP (0..1+).
  - `recentDamageRate`: damage over the last few seconds, normalised the same
    way (0..1+); a slow grind is near 0.
  - `snapChance`: the chance of a clean snap (default
    `FRACTURE_SNAP_CHANCE` = 0.2).

  With none of the first three given, the cap is the exact target count
  (fixed-count mode, used by the review tool). `fracturePlan(input)` returns
  the seeded decisions (snap or shatter, target count, primary line) without
  building any geometry.
- **Output:** pieces, each with its outline (CCW, quantised), its convex
  decomposition, area, centroid, and a per-edge flag marking new cut edges.
- **Piece count (random and earned).** These come from one seeded decision
  stream:
  - `size = sqrt(min(1, hullRadius / 3000))`;
  - `violence = ½·f(killBlowDamage) + ½·f(recentDamageRate)`, with
    `f(x) = x / (x + 0.35)`;
  - `x = clamp01(0.1 + 0.9·violence + 0.5·(u − ½))`, where `u` is a seeded
    draw;
  - `target = 3 + floor(size · 61 · x²)`, at most the cap.

  The result: a slow grind leaves 3–13 big hulks on a battleship (most
  often 3), while a sudden heavy blow shatters it into 26–62 pieces. Bigger
  hulls give more pieces, and both ends occur across seeds. With few seeds,
  the seed falloff widens by `(12 / count)²`, so a grind leaves a few big
  hulks instead of one hulk and slivers.
- **Primary break line (the last hit decides where it splits).** A straight
  line through the kill point, roughly square across the keel. The keel is the
  major axis of the outline's vertex covariance, in closed form with sqrt
  only. The seed tilts the line by up to about 19°: the direction is
  `across + t·keel` with `t = (k / 1000) · 0.35`, where `k` is a seeded
  integer in [−1000, 1000], normalised with sqrt. It is cut first, and every
  other cut happens on either side of it. Two seeds straddle the line at the
  kill point, so the smallest pieces meet there on both sides.
- **Clean snap (a chance).** With probability `snapChance`, the hull splits
  along the primary line alone: two halves, plus any small bits a concave
  outline leaves at the cut. There are no Voronoi seeds and no section cuts.
- **Algorithm:**
  1. Seeded integer PRNG (mulberry32, the existing `core/random/rng.ts`).
  2. Seeds by rejection sampling inside the hull, with acceptance
     `R² / (R² + d²)` (d = distance to the kill point; floored so the far end
     still gets a few big chunks).
  3. Split the hull along the primary line, then along each section line;
     then, inside each section, Voronoi cells of the seeds that fall in it.
  4. Each Voronoi cell is convex: a bounding box clipped by the bisector
     half-planes.
  5. Clip the (concave) hull by each cell edge with a robust line split that
     returns every disjoint part, instead of plain Sutherland–Hodgman, which
     leaves zero-width bridges when a cell cuts a concave hull in two.
  6. Quantise vertices to 1/64 u.
  7. Jag every Voronoi cut edge shared by two pieces: recursive midpoint
     displacement, perpendicular to the edge, seeded by the edge's own
     endpoints so both neighbours draw the same jagged line. Any edge that
     would make a piece self-intersect stays straight on both sides.
  8. `poly-decomp` convex decomposition per piece.
- **Cap:** if clipping makes more pieces than the cap (or the target), retry
  with fewer seeds, then without section cuts, then without the primary line
  (deterministically).
- **Review:** `EQX_FRACTURE_SVG=1 pnpm vitest run src/core/destruction` prints
  four SVGs (fixed 24 + a section cut, slow grind, heavy blow, clean snap).
  Each shows the kill point as a white dot with a red ring and the primary
  line as a dashed cyan line.

### S2: server spawns wreck pieces

**S2a: done (server only, behind a flag).** A capital's death, NPC or
player-flown (active or parked), breaks it into wreck bodies on the server.

- **Flag.** Room option `capitalWrecks` (or `EQX_CAPITAL_WRECKS=1`), off by
  default: clients don't draw wrecks yet, and a playtest must never meet
  invisible walls. Off ⇒ the room never builds the subsystem; behaviour is
  identical to before. No room sets it today.
- **Kill point.** `SectorRoom.applyDamage` records, per capital, the last
  hit's world point (projectile / shell / missile impact, player beam hit,
  NPC beam hit via `noteBeamImpact`). A hit with no point (ram, mining beam)
  falls back to the attacker's position. At death it goes into the hull's 1×
  Pixi-up frame and onto the outline (`hullLocalKillPoint` →
  `projectToOutline`, fracture v3: "Why isn't the red dot on the border of
  the ship?"). Fracture v4: the primary line always crosses the hull; a hit
  on a bow or stern tip breaks that end off a seeded 15–35 % of the hull
  length aft of the tip, never along the keel.
- **Damage inputs.** `killBlowDamage` = the final hit ÷ max hull;
  `recentDamageRate` = damage over the last ~3 s (a 6-bucket ring,
  `WRECK_RECENT_DAMAGE_TICKS`) ÷ max hull. Entries are pooled per capital: no
  per-hit allocation.
- **Bodies.** `buildWreckPieces` (`core/destruction/wreckPieces.ts`): one
  dynamic body per piece from its convex parts, at its centroid, mass ∝ area
  at the ship's density, velocity v + ω × r plus an outward push from the kill
  point (a fraction of the kind's `maxSpeed`, scaled by how violent the death
  was), spin ω plus a seeded kick, light damping so they settle. Default
  collision groups: ships, rocks and other pieces all collide with them. The
  pieces tile the hull exactly, so they spawn with no overlap; the dying body
  is despawned in the same worker batch (an active player hull's body too,
  its slot kept for respawn).
- **Entity class.** A wreck piece is swarm kind 4 (`SWARM_KIND_WRECK`,
  server-only for now), predicate `isWreckPiece`. No health: `EntityResolver`
  treats it as immune, so a shot stops on it and does nothing. Loops that
  cover it: the projectile pipeline (bolts and shells), player beams, NPC and
  turret beams (`nonPlayerRayHit`, `LineOfFireGate`), missile flight, spawn
  clearance, the interest grid. Loops that skip it: the binary swarm encoder,
  sector persistence, missile locks, blast damage, every drone/AI loop (kind
  filters). Not on the lag-comp ring (its entity budget is the drones').
- **Blocking shots.** `core/destruction/wreckHits.ts`: the bounding circle,
  then the piece's convex parts (`wreckRayHit`, `wreckSweepHit`).
- **Budget.** `MAX_LIVE_WRECK_PIECES` (768) per room; the oldest piece goes
  first. Owner: wrecks stay for ever; this only guards the slot pool until
  S2c persists them. S2b keeps it.
- Locks: `wreckPieces.test.ts`, `CapitalWreckSubsystem.test.ts`,
  `tests/integration/sectorRoom/capitalWrecks.test.ts`.

**S2b: done (wrecks reach the client, drawn plainly; still behind the flag).**

- **Wire.** `SWARM_KIND_WRECK = 4` rides the binary swarm wire. Each record
  gains a `u16 wreckId` at +34 (stride 34 → 36), so `SWARM_WIRE_VERSION` went
  4 → 5 and the decoder drops a v4 packet (invariant #11). The shared
  `shipKind` byte is the parent capital, `componentIndex` the piece index.
  Poses ride the pose channel like scrap: the display-delay interpolation and
  teleport guard for drawing, the remote-entity anchor for the body.
- **Descriptor.** `SnapshotMessage.wrecks[]`: one `WreckDescriptor` per live
  wreck (`{ wreckId, parentKind, seed, killX, killY, killBlowDamage,
  recentDamageRate, snapChance, algoVersion }`; the kill point is hull-local,
  1× Pixi-up, already on the outline). `CapitalWreckSubsystem` hands out a
  free u16 `wreckId` per wreck and keeps the list (a shared array rebuilt only
  when the set changes). `SnapshotBroadcaster` attaches it on every snapshot
  for `WRECKS_CHANGE_WINDOW` (3) broadcast counters after a change (so every
  recipient gets a new wreck at once; an empty list then means "none left")
  and otherwise at the far-drone 2 Hz cadence while any wreck lives. A late
  joiner rebuilds every wreck within half a second (#16).
- **Geometry.** `wreckPieceGeometry(inputs)` (`core/destruction/wreckPieces.ts`)
  is the one source of a piece's shape: convex parts, outline, cut flags, mass,
  radius, all body-local. The server's `buildWreckPieces` places its output;
  the client's `WreckGeometryStore` (`client/net/wreckGeometryStore.ts`)
  rebuilds it from the descriptor, cached per wreck. A descriptor from another
  `FRACTURE_ALGO_VERSION` is dropped (no body, no sprite), never guessed at.
- **Client collision.** `WreckClientLeaf` builds the predWorld twin from the
  same parts, mass and damping (unlocked, default collision groups). Kind 4
  is an `isRemoteMovingSwarmKind`, so the body follows the remote-entity
  anchor like scrap (#12, no second paradigm). A piece gets its body only once
  its wreck's descriptor is known. The local beam and hit prediction test
  pieces at the drawn pose with the server's `wreckRayHit` (#15).
- **Drawing.** One plain `Graphics` per piece, built once: the outline filled
  with the parent hull's base colour at 45 % and a 2 u outline at 18 %
  (`buildWreckPieceGfx`). No child, texture or filter, so Pixi batches a
  whole wreck; the cap adds at most 768 display objects. Works on both
  renderer paths (the worker rebuilds the geometry from `mirror.wrecks`).
- **A worker crash fixed on the way.** A piece can contain a sliver part
  (< 1 u thick) that Rapier cannot hull; `createCollider` threw inside the
  physics worker and killed the pool. `World.spawnObstacle` now skips such a
  part (same code on both sides, so the twins still match).
- **Test trigger.** testMode `test_kill_capitals` kills every capital NPC in
  the room; room `wreck-test` (a peaceful battleship 2.5 km north of the
  spawn, capital wrecks on).
- Locks: `tests/unit/swarmWireRoundTrip.test.ts` (kind 4 + v4 hard-fail),
  `tests/integration/wire/wreckGeometryParity.test.ts` (server bodies ==
  client rebuild, bit for bit), `tests/integration/sectorRoom/wreckLateJoiner.test.ts`
  (a late joiner gets `wrecks[]` and rebuilds every piece),
  `tests/unit/wreckPredWorld.test.ts` (ramming a piece: no corrections),
  `swarmSpriteUpdater.wreck.test.ts` (one plain sprite per piece),
  `World.slivers.test.ts`, `tests/e2e/capital-wreck-render.spec.ts`.

**Left for S2c:** persistence (the sector snapshot stores each descriptor
plus every piece's drifted pose; geometry re-derives on hydrate) and lifting
the 768-piece cap (owner: wrecks stay for ever). Also open: the lag-comp
choice for pieces and a lingering-capital integration test.

**Left for S3:** art and glow (textured pieces, molten cut edges from the
`cutEdges` flags, particles). Then the flag can default on.

The original S2 plan:

On a capital's death the server:
- picks the seed (u32) and kill point (the last hit's point in hull-local
  coordinates);
- runs `fractureHull`;
- spawns one dynamic rigid body per piece at the dying pose, with the ship's
  velocity, plus an outward push from the kill point and a seeded spin.

Mass and HP come from the piece area; the per-area constants are tuning, not
fighter-sized `SCRAP_DEFAULT_MASS` / `SCRAP_HP`.

**Wire.** A new pose-core kind, `SWARM_KIND_WRECK = 4`.
- Each record adds a `u16 wreckId` at +34, so the stride grows 34 → 36 bytes.
- `componentIndex` (+33) is the piece index.
- `shipKind` (+32) is the parent ship kind.

That is a stride change, so **`SWARM_WIRE_VERSION` goes 4 → 5 and the decoder
hard-fails a v4 packet** (invariant #11; lock it in
`tests/unit/swarmWireRoundTrip.test.ts` and the `BinarySwarmDecoder` tests,
like the v3 → v4 bump).

**Descriptor.** The fracture inputs travel as one small record per wreck:
`{ wreckId, parentKind, seed, killX, killY, maxPieces, algoVersion }`.
- It rides the slim JSON snapshot as `wrecks[]`, emitted while any piece of
  the wreck lives. This is invariant #16: a late joiner rebuilds the geometry
  from the snapshot alone; a death event is only an accelerator.
- No vertex ever goes on the wire.

**Authority.** The server stays authoritative over every piece's pose, which
flows on the binary channel like drones and scrap. The client's collision body
follows the remote-entity anchor (invariant #12), the same path as scrap.

**Persistence.** Like scrap (Phase 5), the sector snapshot stores the
descriptor plus each piece's drifted pose and health; geometry re-derives on
hydrate.

### S3: client draws the pieces

- **Texture continuity.** Each piece is drawn as a mesh (or a mask over the
  baked hull sprite) with UVs taken from its local outline, which is still the
  ship's frame. Laid side by side the pieces show the intact ship.
- **Glowing cut edges.** The `cut` edge flags become a per-vertex attribute.
  A small shader glows those edges molten orange at the death and cools them
  to dark over a few seconds.
- **Particles.** Dust and shards at the death are particles (the existing FX
  layer), never bodies.

### S4: secondary breaks and the catastrophic flash

- **Staggered secondary breaks.** A big piece breaks again a short time
  later: a deterministic re-fracture of that piece with a derived seed
  (`fnvMixU32(seed, pieceIndex)`), scheduled in server ticks, never wall time.
  It travels as a new descriptor that names its parent piece.
- **Catastrophic case.** A big white flash, plus a blast that damages nearby
  ships. It waits on the owner's answer about how rare it is (§6).

### Later: wrecks as terrain and salvage

- **Terrain.** Long-lived wreck pieces: heavy, slow, cover that blocks ships
  and shots.
- **Salvage.** Ties into the scrap economy.
- **Lifetime.** A per-sector cap instead of today's global `MAX_LIVE_SCRAP`
  FIFO.

## 4. Determinism strategy

Every client must produce the same pieces as the server, bit for bit, from
`(outline, seed, kill point, cuts, cap)`.

- **Arithmetic only.** The fracture path uses `+ − × ÷` and `Math.sqrt`, which
  IEEE 754 rounds correctly on every engine. No `Math.sin/cos/atan2/pow/exp`,
  whose last bits differ across JS engines. `poly-decomp`'s `quickDecomp` is
  pure arithmetic; its `removeCollinearPoints` uses `Math.acos`, so we never
  call it.
- **Integer PRNG.** mulberry32 via `Math.imul` and `>>>`, bit-identical
  everywhere. Floats are drawn as `u32 / 2³²`, an exact division.
- **Fixed order.** Plain indexed loops over arrays; no `Map`/`Set` iteration
  that depends on insertion from unordered sources; every sort has a total
  tie-break (the ring index).
- **Quantised output.** Every vertex snaps to 1/64 u. After that, orientation
  tests on output vertices are exact: products of multiples of 1/64 at ship
  sizes fit in a double's 53 bits. Quantisation also absorbs any last-bit
  difference in the clipping maths.
- **Symmetric jag.** A cut edge's jag is seeded from its quantised endpoints
  in a canonical order, never from the piece's own random stream. Neighbours
  therefore share the jagged line; a gap or overlap would show as an area
  error, which the tests check.
- **Algorithm version.** `FRACTURE_ALGO_VERSION` rides the wreck descriptor.
  A client that sees a different version must not guess; it drops the wreck
  geometry and logs a warning. A saved wreck from an older algorithm is
  re-fractured or discarded on hydrate (decided in S2).
- **Tests.** Same seed deep-equals across runs; a different seed differs. A
  golden hash of a battleship fracture locks cross-version drift, so a change
  that alters output must bump the version.

## 5. Costs

- **When it runs.** Once per capital death, on the server tick, and once per
  wreck on each client (on first sight, or at join).
- **Cost.** It is O(seeds² × hull vertices) with seeds ≤ ~32. The S1 test
  prints the time for a battleship and gates nothing (counts, not
  timings).
- **No per-frame cost.** The output is computed once and then read; nothing
  is allocated per frame afterwards (invariant #14).

## 6. Owner decisions (2026-11-12)

- **How many pieces: random, and earned.** "I want to see both. It should be
  random, and I guess informed by the strength of the final hit and how quick
  the damage happened and the size of the ship." So the chunk count is drawn
  from the seed within a range set by:
  - hull size;
  - the killing blow's strength;
  - the recent damage rate (damage over the last few seconds).

  A slow grind leaves a few big hulks; a sudden heavy blow shatters the ship
  into many. Both ends must occur. Pieces cost little: "I don't see how
  you're saying like 25 scrap in an area is expensive to render or
  simulate." The game already runs 50-piece scrap stress tests. The module's
  hard cap stays 64.
- **Wrecks stay for ever.** They are saved with the sector, with no fade-out.
- **Wrecks block shots.** Shells, bolts and beams hit wreck pieces; they are
  real cover.
- **Player capitals break up exactly like NPC capitals.** Anyone may salvage
  the wreck, including the former owner.
- **Wreck pieces don't break further** ("No for now"). Shooting a piece never
  re-fractures it.
- **Smaller ships break up this way too** ("Yes"). Fighters, frigates and
  cruisers fracture dynamically like capitals, replacing today's hand-made
  scrap. This is a later slice, after the capital path works.
- **The last hit decides where it splits** ("The impact location of the last
  hit should play a huge role in where it splits").
  - **Where the break runs:** the primary break line crosses the hull through
    the impact point of the killing blow, and the small shattered pieces
    cluster there.
  - **What the kill point is:** the hit's real impact position in the hull's
    local frame, sent by the server. It is never the ship's centre.
  - **Follow-up for S1:** `fractureHull` gains this primary cut through the
    kill point.
- **A clean snap is a chance** ("Yes, but it's dynamic and generated, just
  make it a chance"). Usually the hull shatters around the impact. With some
  probability it instead snaps cleanly in two along that same line through
  the impact point (not at a fixed midships).
- **Catastrophic blasts will hurt nearby ships** ("Yes, but not now/yet"). For
  now the gas-store detonation is visual only; area damage comes later.
