# Capital destruction: dynamic ship splitting (design, 2026-11-12)

Status: **design + slice S1 (the core fracture module) + slice S2a (server
wreck bodies, behind the `capitalWrecks` flag) + slice S2b (wrecks reach the
client and are drawn plainly) + slice S3 (the dead ship's own art on every
piece, glowing cut edges, the break-up burst).** S2c (persistence, lifting the
cap) is not built. Owner direction (2026-11-12): "Implement the ship splitting
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
- **Cracks (v6, money-shot review).** v5 seeded the far field at a floor
  density with a least keel-wise spacing, which drew a comb of even, evenly
  spaced square bands, and its near field was a ladder. v6 (`crackLines`, its
  own seeded stream):
  - a FAN of straight cracks through the kill point (1–4 besides the primary
    line, more for a harder death), tilted up to ~44° either side of square
    and at least `FAN_MIN_GAP` apart, so the hull splits into wedges meeting
    at the kill point;
  - a few FAR cracks (0–3) across the hull away from the fan, at seeded
    uneven stations (≥ 1.6 beams apart, ≥ 1.1 beams from the ends) and
    seeded tilts of 11–37° either way, so each end breaks into a few big
    chunks;
  - the Voronoi seeds stay inside the fan (no far floor), so the shatter is
    only at the kill point; a tip hit gets no fan, its seeds stay on the
    tip's side of the primary line.
  The primary line and all cracks are jagged now (section cuts stay
  straight), and T-junctions are welded first (`weldTJunctions`: a vertex of
  one piece lying on another's cut edge is inserted into it) so a long crack
  pairs up on both sides and jags. Over the kill-focus seed sweep (heavy
  cruiser): far pieces 5.5 → 3.3, far crack tilt 4° → 24°, how radial the
  cracks at the kill point are 0.70 → 0.85; the v5 locks still hold.
- **Chunks at the impact (v7, owner review 2026-11-13: "Tune it").** A
  filmed heavy-cruiser death still read as procedural: v6's far cracks cut
  full-width slices where no shell hit, and its fan plus Voronoi seeds cut
  the struck midsection into a comb of 6–10 thin glowing slivers. Owner:
  "The last hit's impact sets the split", chunks ENORMOUS and heavy. v7
  drops the Voronoi seeds and the far cracks (steps 2–4 below no longer
  run). `crackLines` now makes, on its own seeded stream:
  - two ZONE cracks, one either side of the primary line, 0.75–1.2 beams
    from it at the struck edge (wider for a harder death), tilted like the
    primary within ±0.25; a crack that would chip less than 0.6 beam off
    the hull's end is dropped;
  - 0–2 FAN cracks (more for a harder death), each from the kill point to
    its zone crack 70–95 % of the way across the hull, so a zone half
    breaks into a wide triangle and a quad. A fan crack splits only the
    sections inside its zone half (`LocalLine` regions), and only where
    every part it leaves is chunky: at least `FAN_MIN_WIDTH_BEAMS` (0.45)
    of the beam wide and at most `FAN_MAX_ASPECT` (2.6) times longer than
    that width (rotating calipers); otherwise that section stays whole
    (filmed take 2026-11-13: a fan crack left a long thin triangle, 4 %+
    of the hull, along the port edge). Lock: "no long thin piece of any
    size" in `fractureHull.killFocus.test.ts` (no piece under 0.45 beams
    wide, none under 0.9 beams wide more than 3× longer than wide; the bow
    and stern sections keep the hull's own shape and are exempt). No two
    cracks run near-parallel closer than 0.45 beams either (each crack as a
    chord between junctions; closest over 1,200 seeds a level: 0.56 beams;
    the zone cracks keep ≥ 0.5 beams keel-wise from the primary by
    construction). Lock: "no two cracks run near-parallel" (filmed take
    2026-11-13 asked whether a zone crack and the primary could leave a
    40–50 u sliver: they cannot; that strip was the cut-edge glow spilling
    over one crack as it opened, a renderer fix in S3);
  - rarely ONE far crack: only for a killing blow ≥ max hull on a hull
    ≥ 4.5 beams long, with a 12 % seeded chance, well clear of the zone.
  A tip hit has no zone; one fan draw may crack the broken-off end once.
  The result: 2–4 chunky pieces at the kill point and one big section each
  side (3–7 pieces in all; the piece count still rises with hull size and
  violence, as more chunks and a wider zone, within the cap). Over 60 seeds
  of heavy-cruiser side hits: pieces under 4 % of the hull and over 4× longer
  than wide 129 → 0 (filmed salvo), fractures with a cut over 2 beams from
  the kill point 60/60 → 8/60 (heavy blow only, one crack each), pieces
  centred within 1.5 beams of the kill point 14–32 → 2–4. Locks: the v7
  describe in `fractureHull.killFocus.test.ts`.
- **Algorithm (v6; since v7 steps 2–4 are replaced by the cracks above):**
  1. Seeded integer PRNG (mulberry32, the existing `core/random/rng.ts`).
  2. Seeds by rejection sampling inside the hull (and, since v6, inside the
     crack fan), with acceptance `R⁴ / (R⁴ + d⁴)` (d = distance to the kill
     point; since v6 without a floor, drawn from a box 4 falloff radii round
     the kill point).
  3. Split the hull along the primary line, the fan and far cracks, then
     along each section line; then, inside each section, Voronoi cells of
     the seeds that fall in it (under a metric stretched along the keel:
     2× in v5, 1.5× since v6).
  4. Each Voronoi cell is convex: a bounding box clipped by the bisector
     half-planes.
  5. Clip the (concave) hull by each cell edge with a robust line split that
     returns every disjoint part, instead of plain Sutherland–Hodgman, which
     leaves zero-width bridges when a cell cuts a concave hull in two.
  6. Quantise vertices to 1/64 u.
  7. Jag every Voronoi cut edge (since v6 also every crack and the primary
     line) shared by two pieces: recursive midpoint
     displacement, perpendicular to the edge, seeded by the edge's own
     endpoints so both neighbours draw the same jagged line. Any edge that
     would make a piece self-intersect stays straight on both sides.
  8. `poly-decomp` convex decomposition per piece.
- **Cap:** if clipping makes more pieces than the cap (or the target), retry
  (deterministically, v7) with fewer fan cracks, then without the far crack,
  then without section cuts, then with fewer zone cracks (which side keeps
  its crack is seeded), then without the primary line.
- **Review:** `EQX_FRACTURE_SVG=1 pnpm vitest run src/core/destruction` prints
  four SVGs (fixed 24 + a section cut, slow grind, heavy blow, clean snap).
  Each shows the kill point as a white dot with a red ring and the primary
  line as a dashed cyan line.

### S2: server spawns wreck pieces

**S2a: done (server only, behind a flag).** A capital's death, NPC or
player-flown (active or parked), breaks it into wreck bodies on the server.

- **Flag.** Room option `capitalWrecks` (env `EQX_CAPITAL_WRECKS`). Off by
  default while clients couldn't draw wrecks; **ON by default in every room
  since 2026-11-14** (see "Switched on" below). Off ⇒ the room never builds
  the subsystem; behaviour is identical to before.
- **Kill point.** `SectorRoom.applyDamage` records, per capital, the last
  hit's world point (projectile / shell / missile impact, player beam hit,
  NPC beam hit, passed as real `applyDamage` args). A hit with no point (ram, mining beam)
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
- **Bodies (heavy break-up, owner review 2026-11-13).** `buildWreckPieces`
  (`core/destruction/wreckPieces.ts`): one dynamic body per piece from its
  convex parts, at its centroid, mass ∝ area at the ship's density (Rapier
  derives each piece's inertia from its parts at that density), damping
  0.06 linear / 0.05 angular.
  - **Crack delay.** A piece spawns with the dead hull's rigid motion
    (v + ω × r, spin ω), so the hull holds its shape for `WRECK_CRACK_MS`
    (1200 game ms, `shared-types/wreckTiming.ts`; `wreckCrackTicks()` = 72
    server ticks). Then `CapitalWreckSubsystem.tick()` gives each piece its
    kick (`WRECK_KICK` worker command → `World.addVelocity`), turned by how
    far the piece has turned since the death. Game ticks, so it follows the
    sector's speed (#20). A client effect (the crack-and-ripple before the
    split) times itself from the descriptor's `deathTick + wreckCrackTicks()`.
  - **The kick.** A slow push away from the kill point,
    `wreckPushMin + (wreckPushMax − wreckPushMin)·r²/(r² + d²)`,
    r = `WRECK_PUSH_FALLOFF_FRAC` (0.3) × hull radius, × 0.75–1.25 by how
    violent the death was; `wreckPushMax/Min` = 0.010 / 0.004 × hull radius
    per second (`shipTuning`, #18; ~22 / ~9 u/s for a 2× heavy cruiser; the
    2026-11-12 money-shot push was 0.17 / 0.08, the first heavy tune
    0.012 / 0.004). A slow seeded spin given as a RIM speed
    (`WRECK_SPIN_RIM_NEAR/FAR` 0.13 / 0.05 × `wreckSeparate`, 0.55–1× of it,
    either way round, divided by the piece's radius, at least
    `WRECK_SPIN_MIN_RADIUS_FRAC` 0.06 × hull radius), so a big piece turns
    slower than a small one (≤ ~3°/s; measured < 1°/s on a heavy cruiser).
  - **Neighbours always part.** The push is fastest at the kill point, so a
    piece nearer it chased the slower neighbour beyond it along the same
    line, and the spins turned long pieces into each other: pieces slid over
    each other and two stern pieces folded into a "V" (owner review
    2026-11-13). Every shared cut between two pieces (`findSeams`: cut edges
    on one line, plus cut edges that only touch, as at the T-junction where
    a fan crack ends on a zone crack, whose two sides are jagged
    differently) must open at `shipTuning(kind).wreckSeparate` (0.014 ×
    hull radius per second, ~31 u/s for a 2× heavy cruiser) or more at BOTH
    ends of the shared stretch, spin included, and the two centres must part
    at half that. Where they don't, an equal and opposite push (momentum
    kept) along the cut's normal / the centre line makes up the difference
    (Gauss–Seidel, at most 400 passes, aiming 10 % past the target). The cut
    line separates the two pieces, so parting along its normal never
    overlaps them. Side effect: momentum moves outward along the chain, so
    the pieces at the ends of the hull drift fastest (~75 u/s for a heavy
    cruiser), and the piece at the kill point is slow; the knock-back from
    later shells (below) supplies the violence.
    Tuning (owner review of a filmed take, 2026-11-13: at 0.0025 the gaps
    were 5–15 px after 8 s at the capital zoom ~0.17 and the hull read as
    "cracked but intact" for 3–4 s; "heavy and weighty, but the break must
    be SEEN"): measured on a heavy cruiser killed by a shell, the narrowest
    cut is ~31 u open 1 s after the kick (≥ 5 px at 0.17) and ~170–215 u
    8 s after, with no piece over ~75 u/s. The separation speed is
    multiplied along a chain of neighbours, so it is tuned for v7's 3–7
    chunks: v6's ~30-piece shatter flung its small pieces at ~250 u/s at
    this speed. Lock: `tests/integration/sectorRoom/wreckPiecesSeparate.test.ts`
    (gap ≥ 0.012 × radius 1 s after the kick and ≥ 0.065 × radius 8 s
    after, speed < 0.037 × radius).
  - **Pieces collide with each other** (`WRECK_COLLISION_GROUPS` =
    0x0004FFFF, server spawn and client twin): heavy chunks bump instead of
    passing through. The physics collider is `colliderParts`, each drawn
    part shrunk by `shipTuning(kind).wreckColliderInset` (0.0005 × hull
    radius, ~1 u) toward its centre, so neighbours sharing a cut edge spawn a
    hair apart; drawing and weapon hits keep the full `parts`. Both sides
    read `colliderParts` from `wreckPieceGeometry` (#15). Ships, rocks, scrap
    and structures collide with pieces as before. The dying body is
    despawned in the same worker batch (an active player hull's body too,
    its slot kept for respawn).
  - **Overkill knock-back (owner request 2026-11-13: "The thing which knocks
    them back should be the impact of subsequent shells, if any overkill
    happens due to incoming shots after destruction").** A shot that lands
    on a piece (the rest of the salvo after the kill, or any later fire)
    shoves it. `SectorRoom.applyDamage` takes the shot's direction beside its
    hit point and calls `CapitalWreckSubsystem.onWreckHit(id, hitX, hitY,
    dirX, dirY, damage)`, which posts `WRECK_IMPULSE` (→
    `World.applyImpulseAtPoint`): impulse J = damage ÷ the parent's max hull
    × the hull's mass × `shipTuning(kind).wreckKnockSpeed` at the hit point,
    along the shot, so an off-centre hit also turns the piece. The speed
    change J ÷ m is capped at `wreckKnockMax` per hit. Both are 0.012 / 0.025
    × hull radius per second (#18): a blow worth the whole hull's HP would
    move the whole hull at `wreckKnockSpeed`. Heavy cruiser (2×: 4018 hull,
    mass 2326, radius 2184): `wreckKnockSpeed` ≈ 26 u/s, cap ≈ 55 u/s; one
    16" shell (1400) is J ≈ 21,000, so its biggest piece (~640–715 mass)
    moves ~30–33 u/s and turns ~3°/s on a hit 0.3 radius off centre, a
    mid-size piece (~80) hits the cap, and a 10-damage bolt moves the big
    piece ~0.2 u/s (a sliver can still reach the cap: it is tiny).
    - **During the crack hold the whole wreck takes the hit (owner review
      2026-11-13).** A battleship salvo lands over ~0.5 s: the first shell
      breaks the hull and the rest arrive during the `WRECK_CRACK_MS` hold.
      Shoving only the piece hit made one chunk slide and turn out of line
      while the others held, so the hull bent like a banana before it split.
      Now, while `serverTick < deathTick + wreckCrackTicks()`, `onWreckHit`
      posts `WRECK_RIGID_IMPULSE { entityIds, jx, jy, px, py }` with the
      wreck's piece ids (built once at death) instead. The worker
      (`World.applyRigidGroupImpulse`) treats the live pieces as ONE rigid
      body: it makes their motion exactly rigid from their momentum (centre
      of mass velocity = Σmv ÷ M, spin = angular momentum about the centre
      of mass ÷ the group's moment of inertia, each piece's
      `principalInertia` plus m r²), adds Δv = J ÷ M and Δω = (r × J) ÷ I,
      and sets every piece to v_com + ω × r_i, spin ω. The pieces keep their
      relative poses; the hull moves and turns as one. The speed cap is on
      the whole wreck (`wreckKnockMax` × its mass). The same 16" shell moves
      a heavy cruiser's wreck ~9 u/s and turns it ~0.6°/s from near one end.
      At the end of the hold the separating kick (`WRECK_KICK`) ADDS to that
      motion, turned by how far each piece has turned since the death; the
      pieces turned together, so the kick stays radial to the hull. After
      the hold a hit shoves the single piece, as above.
    - **Paths.** Shells and bolts (`ProjectilePipeline` direct hit, the
      shell's velocity), player beams (`PlayerFireResolver`, the beam
      direction), NPC beams (`AiFireResolver`, impact point and beam
      direction as `applyDamage` args). Missiles already push through their splash impulse
      (`MISSILE_IMPULSE`); rams push through the contact. Not yet: structure
      turret beams (they call `applyDamage` with no hit point) and shell blast
      splash.
    - **Clients.** No client path: the piece's new velocity reaches clients
      on the binary swarm wire, and the predWorld twin (`wreckClientLeaf`) is
      re-anchored to the authoritative pose and velocity every snapshot (the
      remote-entity anchor, #12). Between the hit and the next snapshot the
      twin coasts on its old velocity (≤ ~50 ms, a few units on a body
      hundreds of units across); the drawn piece is interpolated from the
      wire, so nothing pops.
    - **Hit gate fix.** `wreckSweepHit` / `wreckRayHit` used `rayHitsSphere`
      as the circle gate, which returns null once the origin is inside the
      circle and past its closest approach to the centre: a shell stepping
      through a long piece off its centre passed through its far half. The
      gate is now `segmentNearCircle` (the segment comes within the radius).
      The same pattern remains in `refineSweepHit` for capital hulls (a
      follow-up).
  - Locks: `tests/integration/sectorRoom/wreckPiecesSeparate.test.ts` (no
    overlap, neighbours never approach, crack delay holds, slow speed and
    spin, a shoved piece bumps its neighbour), `wreckPieces.test.ts` (every
    seam opens at both ends), `CapitalWreckSubsystem.test.ts` (crack delay,
    knock-back formula and cap), `wreckOverkillKnockback.test.ts` (a real
    16" shell on a piece after the kill: Δv along the shot ≈ expected, spin
    the way the off-centre hit turns it), `wreckRigidHold.test.ts` (a real
    16" shell during the hold: every pair of pieces keeps its relative pose
    within 1 u / 0.1° and the wreck moves along the shot; with fracture v7's
    5 pieces, 32 u / 1.16° of bending without the fix, 0.16 u / 0° with it), `World.rigidGroup.test.ts` (one spin, v_com +
    ω × r, momentum + J), `wreckHits.test.ts` (the gate).
- **Entity class.** A wreck piece is swarm kind 4 (`SWARM_KIND_WRECK`,
  server-only for now), predicate `isWreckPiece`. No health: `EntityResolver`
  treats it as immune, so a shot stops on it and does no damage (it knocks
  the piece instead, see "Overkill knock-back"). Loops that
  cover it: the projectile pipeline (bolts and shells), player beams, NPC and
  turret beams (`nonPlayerRayHit`, `LineOfFireGate`), missile flight, spawn
  clearance, the interest grid. Loops that skip it: the binary swarm encoder,
  sector persistence, missile locks, blast damage, every drone/AI loop (kind
  filters). Not on the lag-comp ring (its entity budget is the drones').
- **Blocking shots.** `core/destruction/wreckHits.ts`: the bounding circle
  (`segmentNearCircle`), then the piece's convex parts (`wreckRayHit`,
  `wreckSweepHit`). A shot that lands knocks the piece (above).
- **Budget.** `MAX_LIVE_WRECK_PIECES` (768) per room; the oldest piece goes
  first. Owner: wrecks stay for ever; this only guards the slot pool until
  S2c persists them. S2b keeps it.
- **Kill point and drift fixes (hostile review, 2026-11-12).** A filmed
  death (a battleship's 16" salvo kills a player heavy cruiser in
  `showcase-capital-duel`) showed cracks over ~60 % of the hull, a
  lengthwise "tuning fork" at the bow, and pieces that kept the outline with
  hairline gaps for 6 s. Findings:
  - **The kill point was right.** An integration test reproduces the death
    with a real 16" shell through the projectile pipeline at three hull
    angles: the recorded kill point is the shell's impact to the float, the
    transform (rotation sign, Pixi y-down vs math y-up) is correct, and the
    attacker fallback is not used. The primary line passes through it.
  - **The spread came from the fracture.** The seed density fell off as
    1/d² (a long tail down a long hull) over a 3.5 % floor, and Voronoi
    cells between seeds at the same station across the narrow beam ran down
    the keel. Fracture v5 (`FRACTURE_ALGO_VERSION` 5): a 1/d⁴ falloff over a
    0.4 % floor, a Voronoi metric stretched 2× along the keel, and, beyond
    one falloff radius from the kill point, a least keel-wise seed spacing.
    Over a seed sweep of heavy-cruiser side hits the share of new cut length
    within 20 % of the length of the kill point went 77–88 % → 86–94 %, cut
    length running along the keel 20–22 % → ≤ 4 %, and the worst long piece
    misses ≤ 15 % of its beam (was 64–79 %).
  - **The drift was cancelled by the pieces themselves.** The push was a
    flat ~20–60 u/s away from the kill point, and the pieces tile the hull
    exactly, so a piece at the kill point ran into its slower neighbour; the
    contacts (restitution 0.8) traded the push away (the piece nearest the
    kill point coasted at 60 u/s, the farthest at 76). Pieces now never
    collide with each other, and the push follows the falloff above. In the
    reproduced death the debris field's mean radius grows 393 u in 5 s (was
    132 u), the nearest piece leaves at ~134 u/s, the farthest at ~41 u/s.
    (#502's capital overlap pass is not on this branch, so it was not the
    cause.)
  - **The client does not ease the cracks in.** The "cracks fading in over
    ~1 s" were the slow real separation: the client draws each piece at its
    interpolated server pose, and the pieces start tiling the hull exactly.
    With the faster push the gaps open within a few frames.
  - Locks: `fractureHull.killFocus.test.ts`,
    `tests/integration/sectorRoom/wreckBreakAndDrift.test.ts`,
    `tests/unit/collisionGroups.test.ts`.
- **The money shot (hostile review of the v5 take, 2026-11-12).** The owner
  wants "a capital visibly breaking apart where it was hit". The review of
  the next filmed take found five faults; each fix has its lock:
  - **Death flash.** A hull-wide flat white disc and grey halo (the
    break-up's flash, 0.55 × the wreck radius) and, under it, #493's
    hull-sized death blast at the hull centre. Now: a small 0.22 s core
    flash (0.02 → 0.07 × the wreck radius), FxExplosions fireballs at the
    kill point (`wreckBlasts`: 0.12 × the wreck radius plus two 0.065 ones
    beside it, all within ~0.25 of it), thinner dust, the shards as before.
    The welcome's `capitalWrecks` flag tells the client the room breaks
    capitals, and it then leaves a dying capital's death blast to the
    break-up (`hullDeathBlastReplaced`). Locks: `WreckBreakFx.test.ts`,
    `wreckArt.test.ts`, the GPU-lit case in `capital-wreck-render.spec.ts`.
  - **Procedural cracks** (a comb of even square far bands, a ladder at the
    kill point): fracture v6, below (S1).
  - **Hull art lost.** Root cause: the player's look (`shiplight=high`) is
    GPU-lit art, whose frames are UNLIT data maps that only the lit shader
    lights; the pieces drew the raw albedo slice through the default shader
    under a 23–55 % burnt tint, so they read as flat dark-grey slabs. S3's
    E2E ran the baked look (automation's default) and never saw it. Pieces
    of lit art are now `LitShipMesh`es (below, S3) with a 60–82 % tint.
  - **Separation** (5–20 px gaps at zoom 0.22 after 22 s): 3× the push, the
    falling-off spin above. The drift test asserts a 300+ u/s piece at the
    kill point and a field that opens 1,500+ u in 5 s (measured 395 u/s,
    1,810 u, 18°/s).
  - **Glow** still bright orange at 4.5 s: bright ~1 s, ember 3 s, dark 6 s.
  - Found on the way: the client's snapshot coalescer kept only the newest
    snapshot per frame, so a `wrecks[]` descriptor on a dropped snapshot was
    lost until the 2 Hz repeat (1.2–3.6 s in the E2E, past the 1.5 s
    break-up window). It now carries a dropped snapshot's list forward
    (`snapshotCoalesce.test.ts`). The DataChannel byte coalescer had the same
    gap; sub-capital slice 3 closed it (see "Wreck descriptors on the wire").
  - **The hull vanished before its pieces appeared** (take B, 2026-11-13:
    ~0.5 s of empty space under the kill blast). The renderer swept the hull
    sprite the frame its entity left the mirror, but a piece is drawn only
    once its binary pose and its `wrecks[]` descriptor have both arrived (two
    channels; out-of-interest pieces ride the binary wire every 6 ticks, and
    a spectator has no interest window). Now a capital that dies in a
    `capitalWrecks` room (marked from `explodingShips`) is held by
    `DyingHullHold` (`render/pixi/dyingHullHold.ts`): drawn at its last pose
    until a piece of its kind is drawn within its hull, then removed in that
    same frame, or after 1.5 s of game time if the wreck never shows. Active,
    NPC and parked hulls alike. Lock: `dyingHullHold.test.ts`.
  - Frames for review: a GPU probe films the break-up (CDP screencast,
    frames picked by timestamp at death + 0.3 s, + 2 s, + 5 s).
- Locks: `wreckPieces.test.ts`, `CapitalWreckSubsystem.test.ts`,
  `tests/integration/sectorRoom/capitalWrecks.test.ts`.

**S2b: done (wrecks reach the client, drawn plainly; still behind the flag).**

- **Wire.** `SWARM_KIND_WRECK = 4` rides the binary swarm wire. Each record
  gains a `u16 wreckId` at +34 (stride 34 → 36), so `SWARM_WIRE_VERSION` went
  4 → 5 and the decoder drops a v4 packet (invariant #11). The shared
  `shipKind` byte is the parent capital, `componentIndex` the piece index.
  Poses ride the pose channel like scrap: the display-delay interpolation and
  teleport guard for drawing, the remote-entity anchor for the body.
- **Descriptor.** One `WreckDescriptor` per live wreck (`{ wreckId,
  parentKind, seed, killX, killY, killBlowDamage, recentDamageRate,
  snapChance, algoVersion, deathTick?, cutKind?, cutAng?, cutW? }`; the kill
  point is hull-local, 1×
  Pixi-up, already on the outline). `CapitalWreckSubsystem` hands out a free
  u16 `wreckId` per wreck and keeps the list (a shared array rebuilt only when
  the set changes). S2b sent the whole list on the snapshot; sub-capital
  slice 3 replaced that with deltas (next section).

**Wreck descriptors on the wire (sub-capital break-up slice 3).** Sub-capitals
will leave permanent wrecks at ~200 deaths a minute in a big fight. The S2b
wire resent the whole `wrecks[]` list for 3 broadcasts after ANY change and at
2 Hz otherwise: at 3 deaths a second that is ~5 full lists a second per
recipient, growing with every live wreck (measured, msgpack: 3.8 KB/s at 10
live, 100 KB/s at 300, 334 KB/s at 1,000). Now:
- **Join.** The welcome carries the full live set (`WelcomeMessage.wrecks`,
  zod-checked with `WreckDescriptorSchema`).
- **Deltas.** `WreckWireDeltas` (stepped once per broadcast, diffing the live
  list only when its version moves) keeps the adds and removes of the last
  `WRECK_DELTA_WINDOW` (18) broadcast counters, six snapshots per recipient,
  so one dropped snapshot never loses one. `wreckAdds` carries descriptors (a
  recycled id carries its new one); `wreckRemoves` carries ids; an id is
  never in both.
- **Rolling resync.** On one snapshot per recipient in `WRECK_RESYNC_EVERY`
  (2 Hz), `wreckSync = { lo, hi, d }`: the live wrecks with `lo <= id < hi`
  are exactly `d` (at most `WRECK_RESYNC_CHUNK` = 6). The chunks walk the id
  space and wrap, so a client that missed an add OR a remove converges (#16;
  22 live wrecks after a forced miss: 1.6 s).
- **Client.** `WreckGeometryStore.applySnapshot` applies sync, then removes,
  then adds (deltas are never older than the chunk), idempotently, with
  alloc-free guards (`isWreckDescriptor`, `isWreckId`, locked to the zod
  schemas) since the snapshot is the #3 carve-out.
- **Coalescing.** All three fields are absent-means-no-change.
  `SnapshotCoalescer` folds a dropped snapshot's deltas into the newer one
  (`carryWreckDeltas`, the newer wins per id); the DataChannel byte coalescer
  decodes a superseded frame whose bytes contain the `wreckAdds` /
  `wreckRemoves` keys instead of discarding it (`carriesWreckDeltas`).
- **Bytes.** ~4.1–4.2 KB/s per recipient at 3 deaths a second, flat from 10
  to 1,000 live wrecks.
- Locks: `SnapshotBroadcaster.wreckDeltas.test.ts`,
  `tests/unit/wreckWireConvergence.test.ts`, `snapshotCoalesce.test.ts`,
  `dataChannelTransport.test.ts`, `wreckWire.test.ts`,
  `tests/integration/sectorRoom/wreckLateJoiner.test.ts`.

**S2b, continued.**

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
  (a late joiner gets the welcome's `wrecks` and rebuilds every piece; a new
  death rides as one add, a gone wreck as a remove),
  `tests/unit/wreckPredWorld.test.ts` (ramming a piece: no corrections),
  `swarmSpriteUpdater.wreck.test.ts` (one plain sprite per piece),
  `World.slivers.test.ts`, `tests/e2e/capital-wreck-render.spec.ts`.

**Left for S2c:** persistence (the sector snapshot stores each descriptor
plus every piece's drifted pose; geometry re-derives on hydrate) and lifting
the 768-piece cap (owner: wrecks stay for ever). Also open: the lag-comp
choice for pieces and a lingering-capital integration test.

**S3 is built** (see "S3: client draws the pieces" below). The flag can
default on once S2c lands.

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
  the wreck lives. (As built since sub-capital slice 3: the welcome carries
  the full set and snapshots carry adds, removes and a rolling resync.) This is invariant #16: a late joiner rebuilds the geometry
  from the snapshot alone; a death event is only an accelerator.
- No vertex ever goes on the wire.

**Authority.** The server stays authoritative over every piece's pose, which
flows on the binary channel like drones and scrap. The client's collision body
follows the remote-entity anchor (invariant #12), the same path as scrap.

**Persistence.** Like scrap (Phase 5), the sector snapshot stores the
descriptor plus each piece's drifted pose and health; geometry re-derives on
hydrate.

### S3: client draws the pieces (built)

The owner's look spec: each piece shows its own part of the dead ship's art,
so the pieces fit like a jigsaw; new cut edges glow molten and cool to dark;
dust and shards are particles; a big white flash at the kill point; the
pieces stay for ever and the glow ends dark. As built
(`src/client/render/pixi/wreckArt.ts`, `effects/perEffect/WreckBreakFx.ts`):

- **Texture continuity.** A piece reuses its parent kind's EXISTING baked art
  (`shipHandleFor(kind)`, the handle the live hull drew; no re-bake, no new
  texture page). Capital art is tiled along the hull (`TILE_MAX_SIDE` rows per
  texture), so `wreckPieceMeshes` clips each convex part to every tile's row
  band and fans it: one `Mesh` per tile the piece covers. A vertex's UV is its
  hull-local position (outline + centroid, the ship's own frame) mapped into
  the tile's frame, so a point two pieces share gets the same UV in both. UVs
  are frame-relative, so the same meshes follow the sun frames (the frame
  nearest the piece's rotation, swapped only on change). Every mesh sets
  `batchMode: 'batch'`, so a whole wreck batches over at most its parent's
  tile textures. Pieces are tinted burnt (slightly: 60–82 %), darkest near
  the kill point. GPU-lit art (`?shiplight=gpu|high|medium|low`, the
  player's default look) is a data page of UNLIT maps: each tile piece is a
  `LitShipMesh` whose geometry is the piece in the HULL's frame (the shader
  lights by hull-local position; offset back to the centroid) with UVs on
  the atlas page, registered with `litPass` like the live hull (money-shot
  review: slice A through the default shader gave flat grey slabs). Before
  the art is ready (or in the classic look) the piece is
  today's plain polygon, swapped once the art arrives.
- **Glowing cut edges.** One glow per piece over its `cutEdges` (the
  original outline never glows; since 2026-11-13 a mesh lit by a crack front,
  see "Cracks spread" below), coloured by `wreckGlowAt`: white-hot for
  0.12 s, bright orange to ~0.6 s, an ember at `WRECK_GLOW_EMBER_S` (1.8 s),
  dark at `WRECK_GLOW_END_S` (4.5 s), when the stroke is destroyed (was
  3 s / 6 s; review 2026-11-13: "saturated orange for ~3 s"). The clock is the descriptor's new `deathTick` against the
  piece's latest server tick, so a late joiner (or a descriptor without one)
  starts cool. Per-wreck state lives in the renderer's `WreckArtState`.
- **Break-up.** The first piece of a wreck younger than 1.5 s fires
  `effects.spawnBurst('wreck-break', killPoint, { radius, flashScale })`: a
  short small core flash (1.6× for a clean snap), dust and hot shards flung
  outward, plus FxExplosions fireballs at the kill point (`wreckBlasts`),
  sized from the wreck radius, counts by effects tier (70+40 on high, 8+4 on
  minimal). The kill point comes from that piece's pose and its known
  centroid in the hull frame. The pool is built on the first break-up and
  leaves the stage when idle.
- **A smaller kill blast (owner decision 2026-11-13, after filmed reviews).**
  The spreading cracks and the ripples mostly hid under the kill fireball
  and smoke. The fireballs shrank to about half the area they cover:
  `WRECK_BLAST_MAIN` 0.12 → 0.09, `WRECK_BLAST_SUB` 0.065 → 0.045 at
  `WRECK_BLAST_SUB_OFFSET` 0.09 → 0.06, so `WRECK_BLAST_REACH` is 0.112 of
  the wreck radius (was 0.165). Their smoke lifts twice as fast
  (`WRECK_BLAST_LINGER` 0.5, FxExplosions' `linger` argument; ordinary
  deaths keep 1): visible to ~1.1 s instead of ~2.1 s. The break-up dust
  stays inside the reach (was flung to ~0.4 of the radius) and lifts in
  ~1.2 s (was ~3 s). The flash at the hit stays (FxExplosions' 0.3 s glow,
  `WreckBreakFx`'s core flash now to 0.08). The crack front's pacing and the
  ripple placement follow `WRECK_BLAST_REACH`, so both moved in with it.
- **Counts.** A piece is a container, ≤ 6 meshes and one glow stroke
  (`WRECK_DISPLAY_OBJECTS_PER_PIECE_MAX` = 8), the stroke gone once cool.
  Both render paths (worker and main thread) run the same updater.
- Locks: `wreckArt.test.ts` (UVs are the hull-local mapping, tile meshes tile
  the piece, neighbours share edge UVs; the glow curve; cut edges only),
  `swarmSpriteUpdater.wreckArt.test.ts` (parent textures only, count budget,
  hot vs late-joiner cool, one break-up), `WreckBreakFx.test.ts`, and the S3
  case in `tests/e2e/capital-wreck-render.spec.ts`.

#### Cracks spread, then it breaks (built 2026-11-13)

Owner, on the filmed break-up: "The instant split feels a bit off. Slightly.
Perhaps some propagating cracks ... and explosions across the hull, small and
rippling showing internal damage, then it breaks up." The pieces already hold
together for `WRECK_CRACK_MS` (1200 game ms, `shared-types/wreckTiming.ts`)
before the server pushes them apart; this is what the client shows in that
window. Everything runs on the renderer's game clock (`ctx.fxNowMs`), so it
slows in slow motion and speeds up at 4×.

- **The crack front.** Each crack system (the cut edges of every piece,
  joined where pieces share a vertex: `CrackDistances`) is entered once, at
  its outline vertex nearest the kill point (the kill point itself for the
  primary line and the fan cracks), and the front runs ALONG the cracks from
  there, through T-junctions. Both sides of a crack therefore light
  together (per-piece runs lit one side of a zone crack ~0.5 s after the
  other when a fan crack ended on it). The front's clock (`crackFrontAt` /
  `crackIgniteMs`) runs over the crack distances that hold a crack only
  (`crackIntervals`, merged), from the nearest to the farthest in
  `WRECK_CRACK_FRONT_MS` (0.8 × the window), so it never idles across a
  stretch of the hull with nothing to light. Each cut segment grows from its
  near end to its far end; each END ages from the moment the front reached
  it, so a crack is white-hot at the tip and cools orange to red behind it.
- **The front is paced to be seen (review of the v7 takes, 2026-11-13).**
  Fracture v7 puts every crack within a beam or two of the kill point, and
  the kill blast's fireballs cover the hull out to `WRECK_BLAST_REACH`
  (0.112 × the wreck radius since the smaller kill blast, was 0.165) for
  ~1.1 s. Paced evenly over distance, the front
  spent about half its run under them: the take showed the first crack
  ~0.8 s after the kill and the rest "spanning the hull in ~0.1 s". The
  front now crosses the covered stretch (`crackHidden`) in
  `WRECK_FRONT_HIDDEN_SHARE` (20 %) of its time and spends the rest outside
  it (0.8 × 0.96 s ≈ 0.77 s visible, was ~0.5 s; the edge-granular test
  measure reads 0.70–0.75 s on the filmed heavy cruiser and floors at 0.7 of
  the front's run). The
  white-hot stage of the glow curve is 0.12 s, so the crack behind the head
  is already orange and the head reads (it was as white as the head).
- **First sight, not the death (review 2026-11-13).** The client first draws
  a wreck 0.1–0.5 s after the death (its descriptor arrives late). Anchored
  at the death, most of the front had already run and every crack lit at
  once. A wreck first seen inside its crack window starts the front, the
  glow's clock and the ripples at first sight (`deathMs` is then first
  sight); the break-up burst still uses the real age. A late joiner keeps the
  true age: cool, no front.
- **One glow mesh, not a stroke.** The glow is one `Mesh` per piece on a
  128×2 texture holding the glow curve (`wreckGlowTexture`: row 0 core, row 1
  halo at 0.3 alpha; U = age / 4.5 s). Four quads per cut segment: a halo and a
  core (per-vertex U: the age at each end) on the piece's OWN side of the
  edge only, each half the stroke's width and narrowed where a sharp corner
  would poke it out (`insideWidth`), so the two pieces' halves make the
  whole stroke while the hull holds and nothing is drawn in the gap once
  they part; then the white-hot head's halo
  and core (`GLOW_HEAD_MUL` wider, `GLOW_HEAD_LEN_R` × the wreck radius
  long) on the stretch behind the tip of a crack still growing. Widths are a
  share of the wreck radius (`GLOW_CORE_R`, #18), so they read at capital
  zoom (~0.17). Each frame rewrites only the U coordinates and, until the
  front has passed every cut, the positions, in place. Still one glow object
  per piece (budget 8). `frontHeads()` counts the heads drawn.
- **Ripple blasts.** At first sight of a fresh wreck `wreckRipples` picks up
  to `wreckRippleCap(tier)` points (7 high, 5 medium, 3 low, none minimal) on
  the cut edges whose whole ripple fireball lies outside `WRECK_BLAST_REACH`
  (v7 review: the old "far 65 % of the cracks" rule put every ripple 409–528
  u out, under a kill blast reaching ~360 u, and fired two 30 ms apart), one
  per equal stretch of the front's run there, at least
  `WRECK_RIPPLE_GAP_MS` (110) apart, so they fire in sequence as it passes.
  Each is a pooled `FxExplosions` burst of
  radius 0.05–0.07 × the wreck radius (review: 0.022–0.04 were lost; the
  kill blast is 0.09). With the smaller kill blast they sit closer in along
  the cracks (5–6 outside it on the filmed heavy cruiser). A late joiner gets none; one whose moment passed
  before its piece was drawn is dropped. `artStats().wreckRipples` counts
  them.
- **No black "char" strip (filmed v3 takes, 2026-11-13).** Each cut edge
  carried a black scalloped strip: across an opening gap the two read as a
  near-black band over the stars, and on the bow piece it stuck out past
  the hull. It was the glow mesh's cooling end: the curve faded to
  near-black (0x501404 → 0x200804 at up to 0.55 alpha) over a halo 3× the
  core's width, narrowed per segment end (the scallops); the white-hot head
  was a quad CENTRED on the crack (half of it in the neighbour or past the
  outline), and on a concave piece a strip with both ends inside could
  still cross the outline between them. Now the curve ends in a faint dark
  grey-brown (0x5a4a40 at 0.25 alpha by 2.2 s, to 0x3a2f2a at 0), the halo
  fades out by 2.0 s so a cooled edge keeps only the thin core, the head is
  a one-sided strip like the stroke, and each strip is narrowed until its
  far side is inside the piece (`stripInside`).
- **The burnt tint stays close to the art (review 2026-11-13).** The tint is
  per piece, so a wide near/far spread puts a hard brightness step at every
  cut. With the old near tint (0x9a8a80) a mid-hull kill turned every middle
  piece into a dark brown slab beside a normal bow and stern once the blast's
  light faded ("the middle chunks lose their hull art", measured on the take
  at 0.69 / 0.66 / 0.65 of the stern's R/G/B, matching the tint ratio). Near
  is now 0xc4bab2 against 0xd2cac4 far (≥ 0.9 per channel); the scorch is
  the glow's job.
- Locks: `swarmSpriteUpdater.wreckArt.test.ts` "cracks spread, then it
  breaks" (front from the kill point, also when first seen 300 ms late; a
  head runs while cracks grow; all lit by the split; each cools from its own
  ignition; ripples on the cuts, 0.05–0.07 × the radius, away from the kill
  point, under the cap, spread in time, none for a late joiner; the game
  clock drives both) and "after cooling, no glow draws and every piece keeps
  the hull art at about the same brightness"; "the filmed v7 break-up" (the
  heavy cruiser amidships, pieces arriving 300–400 ms late: front over
  0.8–1 s with ≥ 0.72 s outside the kill blast and a head running, both
  sides of a crack together, 3+ ripples outside the blast in sequence, glow
  under 0.6 alpha by 3 s, no glow outside its piece, pieces never fade;
  "char strip": every point of every glow quad inside its piece at every
  moment, the cooled scorch grey-brown, faint and halo-free; "the kill
  blast is small and brief": the real FxExplosions + WreckBreakFx bursts
  cover ≤ `WRECK_BLAST_REACH` ≤ 0.12 after the first 0.6 s and clear by
  1.3 s; ≥ 4 ripples outside it, some where the old blast hid them).
- **The "thin sliver that faded" (v7 take, 2026-11-13) was no piece.** Two
  bright lines ~40–50 u apart with a dark streaky strip between them, gone
  by ~4 s: one crack opening at ~31 u/s after the hold, with each piece's
  glow centred on its edge, so both halos and cores spilled over the gap
  and read as a strip that "faded" with the glow. v7 never cuts two
  near-parallel cracks closer than ~0.56 beams (`fractureHull.killFocus.test.ts`
  "no two cracks run near-parallel"), and every piece keeps its art. Fixed
  by drawing each piece's glow on its own side only (above).
- **The "near-black gaps" (rail-channel take, 2026-11-15) are the sky.**
  Review: the channel and the cracks between parted pieces read as black
  shapes pasted on the hull. Measured, not a render bug: in the GPU-lit
  look (plain break-up in `wreck-test`, and the rail-channel scene with the
  pilot's parked heavy cruiser) every gap pixel equals the bare backdrop
  with the whole ship layer hidden (0 of ~15,600 gap pixels darker); over a
  magenta clear colour the gaps are fully transparent; and no other display
  object darkens them (each hidden in turn). On the filmed frames the gap
  matches the sky beside it (channel band 40–47 luma where a nebula wisp
  runs through it, the open sky next to it 16–18 with no wisp). The sky
  behind a capital at push-in zoom is mostly near-black, so a hole next to
  a lit hull reads as a black shape. Any change is a look decision for the
  owner, not a fix.

### S4: secondary breaks and the catastrophic flash

- **Staggered secondary breaks.** A big piece breaks again a short time
  later: a deterministic re-fracture of that piece with a derived seed
  (`fnvMixU32(seed, pieceIndex)`), scheduled in server ticks, never wall time.
  It travels as a new descriptor that names its parent piece.

#### Re-split: the core child fracture (salvage stream PR 3, 2026-11-15)

A wreck piece can break again through the SAME `fractureHull` (no fork):
`wreckChildGeometry(chain)` (`src/core/destruction/wreckChildren.ts`)
re-fractures a piece's own outline. The chain is the root wreck's
`WreckFractureInputs` plus one step per break: `{ pieceIndex, killX, killY,
cutKind?, cutAng?, cutW? }`, the kill point in the hull's 1× Pixi-up frame
(the fracture projects it onto the piece's outline) and the breaking weapon's
kill cut, as the root descriptor carries it. Each step's seed is
`fnvMixU32(parentSeed, pieceIndex)` (`wreckChildSeed`). A chain with no steps
is the root wreck; a step naming a missing piece, or a kind whose profile has
no `resplit`, gives no children.

- **Split, not changed.** `wreckPieceGeometry` is now
  `fracturePiecesToGeometry(kind, wreckRootFracture(input))`
  (`wreckPieceFrame.ts`): the raw pieces in the hull's 1× frame, then the
  body-frame geometry. Children go through the same second half, so they come
  out in the root's frame (centroid in the ship's scaled math-up frame, mass
  from area at the kind's density); the server places a child from its parent
  piece's live pose as it placed the parent from the dead hull's.
- **No algorithm change, so `FRACTURE_ALGO_VERSION` stays 10.** The root
  output is byte-identical (golden in `wreckChildren.test.ts`, captured on
  main before the split); the chain is additive. A child fracture runs in
  fixed-count mode (no damage inputs: the cap is the target).
- **Old cracks keep their kind.** The fracture marks its input's edges
  `EDGE_HULL`; a child edge lying on one of its parent's cut edges takes that
  edge's kind back (`inheritEdgeKinds`), so an old crack still glows and still
  pairs as a seam.
- **Options per profile** (`DESTRUCTION_PROFILES[*].resplit`; `none` is null).
  Integrity is hidden and server-side: `I_max = clamp01(m_piece / shipBodyMass)
  × maxHull × integrityMul`, at least `integrityMinFrac × maxHull`. At 0 a
  piece of at least `minAreaFrac` of the hull's area splits; a smaller one
  becomes a salvage pod worth its mass share of `salvagePerHull`.

| | capital | subcap |
|---|---|---|
| `minAreaFrac` | 0.02 | 0.25 |
| `integrityMul` | 0.5 | 1 |
| `integrityMinFrac` | 0.01 | 0.05 |
| `salvagePerHull` | 200 | 10 |
| child `maxPieces` | 3 | 2 |
| child fracture | chunky (sound primary, `soundMinShare` 0.3, min width 0.36 beam, extra chunk 0.4), fans and far crack off, capital jag | chunky, same shares, no extra chunk, sub-cap jag |

- **The sliver spike.** `fractureHull` reads the ship-shaped keel, beam and
  tip from whatever outline it gets (covariance axis, extent across it), so a
  piece is just a smaller hull to it. Measured over every capital kind and six
  sub-capitals (fighter, heavy, gunship, missile frigate, robot square, trader
  hauler), three hits each (a bow-quarter hit and two violent beam hits),
  every root piece re-split and every child once more (depth 2): each child is
  at least 0.38 of its parent's least width, at most 4.8 long for its width (a
  long hull half keeps its own shape), at least 9.8 % of its parent's area (a
  capital's optional third chunk; sub-caps >= 29 %), and at most 21 convex
  parts (sub-caps <= 3). No fracture option was needed. Lock:
  `wreckChildren.test.ts` "child fracture spike" (bounds 0.3 / 5.5 / 0.08 /
  24).
- **Catastrophic case.** A big white flash, plus a blast that damages nearby
  ships. It waits on the owner's answer about how rare it is (§6).

#### Re-split on the wire: the descriptor chain (salvage stream PR 4, 2026-11-15)

A child wreck is an ordinary `WreckDescriptor` with a NEW `wreckId` that
names its parent: `parentWreck` (the parent's wreckId, u16) and
`parentPiece` (the piece that broke, the parent's `componentIndex`, u8). The
descriptor is ONE step of the chain: `killX`/`killY` are the breaking hit and
`cutKind`/`cutAng`/`cutW` its kill cut, in the hull's 1× Pixi-up frame as
for a root. `parentKind` and `algoVersion` repeat the root's; `seed` is the
child's own fracture seed, `wreckChildSeed(parent.seed, parentPiece)`, so
every link is checkable. `killBlowDamage`, `recentDamageRate` and
`snapChance` are not child inputs (the kind's `resplit` profile sets the
fracture); the server sends 0.

- **Both or neither.** `parentWreck` and `parentPiece` are present together
  (a child) or absent (a root), and a wreck is never its own parent: the zod
  `WreckDescriptorSchema` refine and the alloc-free `isWreckDescriptor`
  enforce the same rule (`wreckWire.test.ts`).
- **Pieces as today.** A child wreck's pieces ride the binary swarm wire with
  its own `wreckId` and their index as `componentIndex`; no record field
  changes, so `SWARM_WIRE_VERSION` stays 5. The descriptor rides the existing
  welcome / `wreckAdds` / `wreckSync` paths by reference (`WreckWireDeltas`
  diffs whole descriptors), so the new fields go through unchanged.
- **Client resolve.** `WreckGeometryStore` walks parent descriptors to the
  root, builds the `WreckChildChain` and calls the shared
  `wreckChildGeometry` (`resolveChildWreckPieces`, pure). A link that
  disagrees with its parent (kind, version, seed) or a chain deeper than
  `MAX_WRECK_CHAIN_DEPTH` (16, a cycle guard) resolves to nothing.
- **Out of order is normal.** A child can land before its parent (an add
  before the resync chunk holding the parent, the renderer seeing the mirror
  in id order). The store keeps it DEFERRED: its pieces read null (no body,
  no sprite) and it retries on the first lookup after the wreck set changes.
  A resolved child re-checks its ancestors only after the set changes, and
  rebuilds when one was replaced (a recycled id). Nothing is fractured per
  lookup in the steady state.
- **Contract (server, salvage PR 5):** every ancestor descriptor stays on the
  wire while any descendant lives (a refcount on the parent wreck), even when
  the parent has no live pieces of its own. An ancestor that leaves first
  leaves its descendants unresolved until it is back.
- **Locks:** `tests/integration/wire/wreckGeometryParity.test.ts` "wreck
  child chains" (server `wreckChildGeometry` == the client's resolve, bit for
  bit, depth 1 and 2, child before parent, parent removed and recycled,
  renderer path, `WreckWireDeltas` pass-through, malformed links).

### Later: wrecks as terrain and salvage

- **Terrain.** Long-lived wreck pieces: heavy, slow, cover that blocks ships
  and shots.
- **Salvage.** Ties into the scrap economy.
- **Lifetime.** A per-sector cap instead of today's global `MAX_LIVE_SCRAP`
  FIFO.

### Sub-capital profile (sub-capital break-up, slice 1, 2026-11-13)

The owner wants every other ship to break up too, but quietly: "use the same
systems, just make it use less effects, the glow simpler, only a few parts".
Capitals stay "a rare and very large spectacle". So there is one wreck
system with three **destruction profiles**, and every difference is a field
on the profile, not a branch in the code.

- **`destructionProfile(entity)`** (`src/shared-types/shipScale/destructionProfile.ts`)
  returns `capital` (authored `sizeClass: 'capital'`), `none` (engineering
  kinds and the cargo pod, which keep their scrap) or `subcap` (every other
  ship, fighters included). Ships read it through `shipTuning(kind).destruction`
  (#18). It takes an entity (`{ type: 'ship' | 'structure', kindId }`), so a
  structure kind can get a profile later; structures are `none` for now.
- **`DESTRUCTION_PROFILES`** (`destruction.ts`) is plain data: the fracture
  options, the crack hold, push and damping scales, whether pieces collide,
  and the FX flags (break burst, kill blasts, crack front, ripples, whether
  the wreck replaces the death blast, glow style and seconds). The capital
  entry holds the capital stack's values, and its fracture options are the
  fracture defaults. The fracture reads the profile (`wreckPieceGeometry`)
  and so does the client look (slice 4, below, plus `fx.dyingHoldMs`);
  slice 2 (server) swaps its constants for these fields.
- **The sub-capital fracture** (same `fractureHull`, v7, with options): at
  most 3 pieces, no fan or far cracks, and `chunkyPieces`. The primary crack
  must be sound: it splits the hull into exactly two pieces of at least 15 %
  each, both chunky. A line across a small concave hull (a fighter's notched
  tail, a delta's swept wings) would clip wingtips off as slivers, so it moves
  toward the centroid, then tries the diagonals and the keel through the
  centroid. The beam-wide zone cracks are replaced by at most one extra crack
  on the longer side, sized to that side (chance 0.4, more for a violent
  death). Every piece passes v7's chunky guard at 0.36 beam (a fighter is
  barely longer than its beam, so 0.45 would never allow a third piece; 0.3
  left thin strips), and a cut has one shallow kink (jag depth 1, roughness
  0.06; depth 2 gave the drone pieces saw-toothed shard outlines, hostile
  review 2026-11-13), so a piece is a handful of convex parts.
- **Parting and knock-back** are per unit of hull radius (`shipTuning`), tuned
  for capitals, and invisible at fighter size (a fighter's pieces parted at
  ~0.1 u/s and read as one hull with a crack). The sub-cap profile scales
  them: `pushScale` 30, `separateScale` 40 (240 since the take 9 and 10 reviews, see "Reads as broken"), `dampingScale` 10. The push runs
  away from the kill point, so on a hit at one end it moves every piece the
  same way: at ×50 alone it left robot pieces touching ~1 s after the break
  (round-2 review). `separateScale` raises the seam pass's least opening
  speed (`wreckSeparate`, 1.4 % of the radius a second) so every shared cut
  opens at >= ~0.56 radius/s: a gap of ~1/3 of the radius or more 1 s after
  the break (narrowest gap measured on the server over 4 hit points per
  kind, two runs: fighter 0.42-0.44, robot hexagon 0.46-0.61, missile
  frigate 0.30-0.39 radii; 0.02-0.17 before), still asleep in ~14 s. Locks:
  `src/core/destruction/wreckPieces.subcapParting.test.ts` and
  `subcapWrecks.test.ts` "stand clearly apart". `dampingScale` 10 (slice 2's measured value: at rest and asleep in ~15 s,
  ~1 radius of drift), and `knockScale` 320 / `knockMaxScale` 30 (applied in
  `shipTuning`'s `wreckKnockSpeed/Max`: a small-arms hit shoves half a
  fighter wreck ~10-25 u/s, no hit more than ~25 u/s). Capitals ×1. Lock:
  `tests/unit/destructionProfile.test.ts`.
  `spinScale` 0.3 (owner on the v5 film, 2026-11-13: "they spin too much
  when destroyed"): the pieces keep 0.3 of the dying hull's turn (its ω and
  the ω × r it gives each piece) and of the seeded kick spin, and a hit on a
  piece turns it with 0.3 of its lever arm (`CapitalWreckSubsystem.onWreckHit`
  moves the impulse point toward the piece's centre; the shove is unchanged).
  A fighter killed hard over at 2 rad/s threw its pieces at ~115 °/s; now
  ≤ ~35 °/s, and an off-centre small-arms hit no longer sets half a fighter
  spinning at ~100 °/s. The cuts still open as before (narrowest gap 1 s
  after the break 0.40-0.43 radii, asleep in ~14 s). Capitals 1
  (byte-identical). Locks: `wreckPieces.subcapParting.test.ts` "a fighter
  killed mid-turn", `CapitalWreckSubsystem.test.ts` "turns it by the
  profile spinScale".
- **Result** over 1,200 deaths per kind (seeds × bearings × violence): 2
  pieces mostly; 3 in about 20–33 % on fighters, gunships, frigates and the
  hauler, and rarely on the round robots; the interceptor always 2. No piece
  under ~10 % of the hull or under 0.3 of its least width; at most 6 convex
  parts; a clean break has at most 2 jag points per piece, none more than
  5 % of the cut off its chord. Lock: `src/core/destruction/fractureHull.subcap.test.ts`.
- **Capitals are byte-identical:** every new option defaults to the old
  behaviour, the goldens are unchanged and `FRACTURE_ALGO_VERSION` stays 7.

#### The client's quiet look (slice 4, built 2026-11-13)

The renderer reads the profile of the wreck's `parentKind`
(`destructionProfileOf`, once per wreck in `WreckArtState.infoFor`) and its
`fx` block picks the look. Capitals are unchanged; a sub-cap wreck, which
happens about 100× as often, is quiet so it never competes with a capital's
break-up:

- **No extra effects.** The break-up sink is called only when `fx.breakBurst`
  or `fx.killBlasts` is set, and `PixiRenderer` plays each part only when its
  flag is (so no `WreckBreakFx` burst and no `wreckBlasts` for a sub-cap). No
  crack distances, no crack front, no ripples (`fx.crackFront`,
  `fx.ripples`).
- **The ship's normal death explosion stays.** `hullDeathBlastReplaced` takes
  the dying kind and also asks its profile (`fx.hullDeathBlastReplaced`,
  capital only).
- **The ship's death explosion is smaller (owner 2026-11-13, "Shrink it").**
  While sub-caps break into wrecks (`subcapWrecks`), `deathBlastFor` scales
  the normal blast's radius by `fx.deathBlastScale` (0.5) and its smoke by
  `fx.deathBlastLinger` (0.5), so the break-up and the fight stay readable
  and capitals feel bigger. Flag off, or any other profile: unchanged.
- **A simple glow.** `glowStyle: 'simple'`: one quad (a band 0.1 × the
  wreck radius deep, at least 4.5 u so it is ≥ 2 px at fleet zoom; the core
  width alone was "a thin orange line on one edge" at fleet zoom, round-2
  review, and 0.4 × radius filmed as an opaque orange crescent over each
  piece, round 3) per cut segment, STRADDLING the cut: half outside the
  piece's face, the inner half kept inside the piece. The neighbour's band
  lies on the same line, so while the pieces touch the two read as one line;
  each used to sit wholly inside its own piece, so the two lay side by side
  as one stroke twice as wide, "a filled 3-4 px bar for ~0.2 s, then a
  line" (owner's v5 film, 2026-11-13). Lock:
  `swarmSpriteUpdater.subcapWreck.test.ts` "one thin line from the first
  frame". Full length
  from the first frame (no front, no halo, no white-hot head), positions
  written once; per frame only one shared U changes (uploaded only when it
  moves), on its own curve (`simpleGlowAt` / `wreckSimpleGlowTexture`): one
  warm orange held, then a clear bright red mid-fade (~0.55–0.7 of its life;
  round 3 saw no red stage in the old dim orange-red), then dark at
  `fx.glowSeconds` (1 s), the same
  for every kind. (The first cut squeezed the capital curve into 1 s: a
  white flash, ~0.4 s of orange, colour reading differently on different
  art; hostile review 2026-11-13.) The glow is destroyed when
  dark. At the `minimal` effects tier a simple glow is not built at all
  (a capital's full glow always is). A descriptor seen up to `glowSeconds`
  late starts its glow at first sight, like the capital front.
- **Pieces keep the ship's normal brightness: broken, not darkened.** The
  owner's call (2026-11-13, after the v4 debris film): "The darkened scrap
  just doesn't look right, what's the logic? Why would it darken when
  destroyed? It should just be broken, same brightness?" So a sub-cap
  piece's art is untinted (white multiply) from its first frame, whatever
  path built it (a late piece, a rebuild when the art arrives, no cut edge):
  the profile's `fx.deadTint` is null and `fx.burntArt` false. (Rounds 1–4
  darkened it with a warm ~35 % `deadTint` after the "solid purple wall"
  review; the owner rejected the look.) The glow is added after the art
  (drawn over it) and nothing tints it: a hit flash multiplies onto the art
  only (`WreckPieceSprite.setHitTint`, written on change), never the
  container, so the glow stays warm orange, and clears back to the normal
  tint. Capitals keep their light per-piece `burntTint` (`fx.burntArt`) and
  the container flash. Lock: `swarmSpriteUpdater.subcapDeadTint.test.ts`
  (every piece of six wrecks drawn at the normal tint apart from a live
  flash, pieces and descriptors arriving out of step, the art arriving late,
  hit flashes, baked / GPU-lit / plain art, a piece with no cut edges).
  (The bright pink diamonds in the round-2 crops, one per dead robot, are
  loot pods, swarm kind 3: an NPC kill spills its hold through
  `LootSubsystem.spillShipHold`, which then always used the bright magenta
  "player spill" tier. They take damage numbers by design and explode when
  shot down. Not wreck pieces. Owner decision 2026-11-13, "make them normal
  loot colour": an NPC's drop is now an ordinary pod coloured by its
  contents; only a dead player's cargo is magenta. Lock:
  `tests/integration/sectorRoom/lootLoop.test.ts`. The NPC kill pod spawns
  BESIDE the wreck, 1.2 hull radii plus its own radius from the centre, to
  the side of the killer's line of fire (seeded side; seeded direction with
  no known killer), at the ship's velocity (`SectorRoom.dropKillLoot`).
  At the centre it took the rest of the salvo at once, a second blast and a
  climbing damage number ~1 s after each death, and hid the break-up
  (owner's v5 film, 2026-11-13). A proper cargo-container
  visual among the scrap is on the shelf, docs/SHELF.md.)
- **No damage numbers on debris.** A hit on any wreck piece (swarm kind 4,
  capital or sub-cap) shows its spark and hit flash, but no floating number
  and no health bar (`isWreckPieceTarget`, both the authoritative and the
  predicted path): numbers merge by screen spot, so hits on a dead ship's
  pieces kept climbing its number after the explosion. A dead NPC's name tag
  goes the frame it dies (the hold keeps the sprite, not the mirror entry
  the label reads); a tag seen on debris is a live neighbour's.
- **The dying-hull hold applies, briefly.** In a room that breaks sub-caps
  (welcome `subcapWrecks`, mirrored to `RenderMirror.subcapWrecks`; slice 2
  sets it), a dying sub-cap's sprite is held until all its pieces draw, with
  the profile's deadline `fx.dyingHoldMs` (250 ms; capitals 1500 ms). The
  hold ends the frame every piece is drawn. The held sub-cap hull keeps its
  normal brightness (no dead tint, the owner's "same brightness" call) but
  never freezes mid hit-flash: no sweep updates a held sprite, so
  `DyingHullHold.tryHold` clears a flash it died wearing (round 2: 600 ms of
  a hull "frozen mid hit-flash" looked alive; the hold is now 250 ms under
  the shrunk death explosion). Capitals' held hulls are unchanged.
- **Cost per piece.** A small ship's art is one tile, so a piece is its
  container + 1 art mesh (baked `Mesh`, GPU-lit `LitShipMesh`, or the plain
  polygon before the art is ready) + 1 glow mesh while glowing: 3 scene
  nodes, 2 drawn. Settled: 2 nodes (container + mesh), 1 drawn, batched over
  its parent's one tile texture. In `perf:counts` terms (every node counts,
  culled or not) a few hundred settled pieces cost 2 nodes each: 300 pieces
  = 600, against ~1,400 of headroom on `fleet-fight/baked` (budget 6,990,
  measured max 5,592), so the budget holds to ~700 settled pieces in that
  scene; slice 5 measures the real soak and re-calibrates from it.
- **A settled piece does nothing per frame.** `WreckPieceSprite.update`
  returns at once when the glow is gone, its ripples are done and its
  rotation and the sun azimuth are unchanged (no light-frame pick, no glow
  write). The updater writes a wreck piece's container tint only on a change
  (a hit flash and its end). Sub-cap pieces off screen are culled
  (`isSpriteInView`; capital pieces stay drawn as before). Wreck pieces get
  no far-zoom icon (`FarZoomIcons` draws drones and ships only) and no radar
  contact (`radarCategoryForSwarm(4)` is null).
- Locks: `swarmSpriteUpdater.subcapWreck.test.ts` (no burst, blasts,
  ripples or front; a simple core glow gone by `glowSeconds`; ≤ 2 drawables
  per piece while glowing and 1 after; none at the minimal tier, the capital
  glow kept there; a settled piece writes no tint, texture or glow; culling;
  the normal death blast kept and shrunk; no dead tint; the warm 1 s glow;
  no icon or radar contact), `ColyseusClient.wreckDamageFx.test.ts` (no
  number on debris), `ColyseusClient.deadDroneLabel.test.ts` (no tag on a
  dead NPC), `dyingHullHold.test.ts` (the brief sub-cap hold), and the
  capital wreck-art tests unchanged.

### Sub-capital wrecks on the server (sub-capital break-up, slice 2, 2026-11-13)

Behind the `subcapWrecks` room option (env `EQX_SUBCAP_WRECKS`); off by
default until 2026-11-14, ON by default since (see "Switched on" below). There is still one wreck system: the capitals' subsystem
(`CapitalWreckSubsystem`, alias `WreckSubsystem`) now reads the dying kind's
profile instead of assuming a capital.

- **Who breaks.** `SectorRoom.wreckKindAllowed`: a `capital` with
  `capitalWrecks`, a `subcap` with `subcapWrecks`, unless the kind is
  composite (the havok keeps its per-component scrap; the cargo pod is
  `none`). The same three death hooks as capitals: a drone
  (`spawnScrapFromDrone`), an active hull (`SHIP_DESTROYED`, whose dead body
  is despawned so the pieces don't hit a corpse) and a killed lingering hull.
  Abandoning a hull is still not a death.
- **No hold.** `holdMs` 0: each piece's separating kick is added to its spawn
  velocity and spin (the pieces spawn at the death angle, the kick's frame),
  so no kick waits in `tick()` and a hit right after the kill shoves the
  single piece (overkill knock-back, the same hook as capitals, sized by the
  kind's radius).
- **Gentle and cheap.** The parting comes from the profile (`pushScale` /
  `separateScale`, see "Sub-capital profile" above; slice 2 started at 0.5). The body comes
  from `wreckBodyParams(kind)` (core; the client twin uses the same, #15):
  damping × `dampingScale` (10: linear 0.6/s, angular 0.5/s) and, because
  `piecesCollide` is false, `SUBCAP_WRECK_COLLISION_GROUPS` (membership bit 3,
  filter all but bit 3): sub-cap pieces never touch each other, but block
  ships, shots, scrap and capital pieces.
- **They go to sleep.** Measured in `subcapWrecks.test.ts` (game seconds from
  the kill until Rapier has slept every piece and the worker has set
  `FLAG_SLEEPING`): a fighter at rest killed by a bolt ~6–10 s; killed at full
  speed (~600 u/s) and turning at 2 rad/s ~15 s after ~1,000 u of drift; a
  missile frigate (~424 u/s) ~14.5 s; a robot hexagon (~368 u/s) ~14.5 s.
  With `dampingScale` 5 the same fighter took ~27 s.
- **Sleeping is cheap.** The physics worker keeps the bodies that are still
  asleep and already flagged in the SAB in `quietIds`; `getAllShipStates`
  skips them, so a resting piece costs one `isSleeping` call a tick, no
  Rapier reads, no allocation and no SAB write (its record already holds the
  resting pose). Rapier itself doesn't integrate or test contacts for a
  sleeping island. Anything that moves a body wakes it, and it is written
  again from the next tick. The swarm wire already skips unchanged records.
- **Permanent, with a separate cap.** `MAX_LIVE_SUBCAP_WRECK_PIECES` (2000) is
  its own FIFO: the oldest sub-cap piece goes first and a capital piece is
  never evicted by debris. The slot pool is `MAX_ENTITIES` 5120, so 2000 +
  768 capital pieces leave ~2,350 slots for ships, rocks, structures and
  scrap; the real ceiling is that pool (a refused spawn simply leaves no
  piece). Slice 5 sizes the cap from a soak.
- **On the wire** exactly like a capital wreck: swarm kind 4 with its
  `wreckId`, one `wrecks[]` descriptor per wreck (slice 3 changes that
  transport, not this). The welcome carries `subcapWrecks: true` so the
  client (slice 4) holds the dying hull briefly.

### Soak results (sub-capital break-up, slice 5, 2026-11-13)

**Question:** is permanent, sleeping debris cheap in a real battle? The
owner's words: "they'll go to sleep in the physics engine and shouldn't be too
expensive. But let's start big and see what happens."

**Answer: not yet.** In a live fight most pieces never fall asleep, and the
client, not the server, is what falls over first.

#### How it was measured

- **Scenes.** `fleet-fight-soak`: the fleet fight (30 fighters vs 30 robot
  squares a wave), reinforced every 10 s for 10 min, `subcapWrecks` on in the
  room. `fleet-fight-soak-lite` is the same at 10 a side.
  - Both arms of the full soak pile up ships, debris or not: reinforcement
    outruns the killing by ~250 ships a minute.
  - The lite soak is the one that isolates the debris.
  - Spawn steps can repeat (`repeatEveryMs` / `repeatUntilMs`), so a 10-minute
    script stays inside the 64-entry seed guard.
- **Arms.** Flag on vs `EQX_SUBCAP_WRECKS=0` (forces it off even where the
  room asks for it). Same machine, same session, one 10-minute take per arm
  (`pnpm perf:scenes --head-only --reps 1 --sample-ms 30000
  --head-params perfcounts=1`, port offset 500). This gives the over-time
  curve. It is NOT a verdict: a single take can't be one.
- **Samples.** Every 30 s, `--sample-ms` reads:
  - the server: tick and worker p50/p95/p99 over the last 30 s of ticks
    (`tickRecent`), and the body census (swarm, sleeping, wreck pieces asleep,
    awake-but-still, descriptors);
  - the wire: rx split into the binary swarm channel and msgpack messages;
  - wreck descriptors per snapshot;
  - the client window, then reset: frame p50/p95/p99, hitches, renderer p95,
    draw calls (`perfcounts=1`) and display objects.
- **The gate.** The standard 30 s `fleet-fight` A/B: 4 reps, base flag off,
  head `EQX_SUBCAP_WRECKS=1`. The server count gate is `perfSceneCounts`
  with the flag on and off.
- **Host.** Desktop (RTX 5070 Ti, 16 threads), with another session's servers
  running. `--no-load-gate` was used and the load is in the ledgers. Timings
  are comparable only within this session. Counts don't depend on it.
- **Wire caveat.** Slice 3 (#547, wreck descriptors as adds and removes) did
  not merge cleanly onto this base (6 conflicts). The wire numbers below are
  the CURRENT transport: the whole `wrecks[]` list for 3 broadcasts after any
  change, and 2 Hz otherwise.

#### Lite soak over time (10 a side; on vs off at the same scene time)

| t | pieces (on) | asleep | ships on / off | server tick p95 on / off (ms) | worker p95 on / off | rx on / off (KB/s) | of which swarm (on) | client frame p95 on / off | draws p95 on / off | display objects on / off |
|---|---|---|---|---|---|---|---|---|---|---|
| 30 s | 57 | 0 % | 34 / 32 | 8.1 / 0.6 | 2.4 / 0.2 | 184 / 79 | 120 | 16.7 / 16.7 | 69 / 53 | 3,140 / 2,743 |
| 60 s | 128 | 1 % | 85 / 48 | 14.8 / 0.6 | 4.8 / 0.3 | 471 / 109 | 301 | 16.8 / 16.8 | 87 / 58 | 5,010 / 3,445 |
| 90 s | 200 | 17 % | 111 / 62 | 1.6 / 1.3 | 1.7 / 0.6 | 778 / 167 | 464 | 16.8 / 16.7 | 94 / 63 | 6,198 / 4,225 |
| 120 s | 306 | 8 % | 122 / 81 | 6.5 / 2.5 | 4.7 / 0.8 | 1,077 / 230 | 595 | 16.7 / 16.7 | 108 / 71 | 7,010 / 5,021 |
| 150 s | 413 | 9 % | 128 / 98 | 5.6 / 1.5 | 5.9 / 0.8 | 1,335 / 314 | 760 | 16.7 / 16.8 | 110 / 80 | 7,870 / 5,828 |
| 180 s | 491 | 32 % | 156 / 97 | 2.9 / 1.4 | 6.3 / 0.7 | 1,228 / 401 | 783 | 16.8 / 16.7 | 102 / 80 | 8,232 / 6,272 |
| 210 s | 555 | 39 % | 188 / 120 | 2.6 / 1.4 | 5.9 / 0.7 | 1,428 / 494 | 869 | 16.8 / 16.7 | 77 / 79 | 9,616 / 7,246 |
| 240 s | 626 | 44 % | 206 / 142 | 3.3 / 1.6 | 9.1 / 0.9 | 1,820 / 590 | 857 | **100** / 16.8 | 94 / 90 | 10,790 / 8,448 |
| 270 s | 691 | 47 % | 237 / 164 | 3.5 / 3.1 | 10.4 / 1.5 | 1,756 / 697 | 1,020 | **117** / 16.7 | 79 / 89 | 12,279 / 9,430 |
| ~290 s | client dropped | | | | | | | | | |

- **Flag on.** The pilot's page left the room at ~290 s. There was no server
  backpressure warning, so the page itself gave out.
- **Flag off.** The same scene ran all 10 minutes: 472 ships at 570 s,
  1.7 MB/s, frame p95 33 ms, server tick p95 25 ms.
- **Full soak (30 a side).** On: the client dropped at ~150 s (602 pieces,
  ~500 ships, 3.5 MB/s, frame p95 83 ms). Off: it dropped at ~500 s (~1,000
  ships, 3.4 MB/s). In both arms the ship pile-up dominates that scene, so
  only the lite soak answers the debris question.

#### Verdicts

- **Do pieces sleep?** Mostly not while the fight goes on around them.
  - 0–17 % were asleep in the first 2.5 min and ~45 % by 4.5 min. In
    isolation a piece sleeps in 6–15 s (`subcapWrecks.test.ts`).
  - Likely causes:
    - the pieces block every weapon, and each hit knocks a piece (`knockScale`
      320) and wakes it;
    - ships fly into the pile, and the contact wakes the pieces;
    - every death drops new pieces into the same 600 u melee.
  - The census now counts awake-but-still pieces (`wreckAwakeSlow`: awake
    but under 1 u/s), so the next take can tell "kept awake by contact or
    knock" from "still drifting".
- **Does server tick cost grow once pieces sleep?** The sleep path works:
  - bodies stepped per tick track the AWAKE count, not the total (e.g. 606
    awake of 928 at 270 s);
  - swarm records per tick are ~ the awake count;
  - so a sleeping piece is nearly free, as designed (`quietIds`).

  But the worker's p95 grows with the awake pieces (1.5 → 10.4 ms against
  0.2 → 1.5 ms off). The main tick p95 stayed 3–4 ms after the first minute,
  apart from spikes in the first two minutes (8–15 ms). Cost follows awake
  pieces, and in a fight most pieces are awake.
- **Does the wire stay flat?** No. It grows ~2.5 KB/s per live piece, ~3×
  the off arm at the same time:
  - the swarm channel (awake pieces ship every tick they move; sleeping
    pieces still ride every 1 Hz full refresh, 36 B each);
  - the `wrecks[]` descriptors (~175 B each, ~50 a snapshot by 270 s).
- **Client: do frame time or draw calls grow?**
  - Draw calls: no (≈ 80–110, the same as off).
  - Display objects: barely (~4 per piece; ships cost far more).
  - Renderer p95: stays 2–6 ms.
  - But the main thread's frame p95 went from 16.7 to 100+ ms at ~620
    pieces, and the page then dropped. Renderer cost stayed low, so the
    main-thread cost per piece is what breaks the client.
  - Candidates, in likely order (not yet profiled):
    1. every piece is a predWorld body, anchored each snapshot and replayed
       on reconcile (O(ticks ahead × pieces));
    2. the `wrecks` map in `RenderMirror` is structured-cloned to the
       renderer worker every frame (O(wrecks));
    3. decoding ~1 MB/s of swarm records plus the repeated descriptor lists.
- **When does the 2,000 cap fill?** Not before something else breaks.
  - Full soak: ~300 pieces a minute (cap in ~7 min), but its client dropped
    at 600 pieces.
  - Lite soak: ~150 a minute (cap in ~13 min), but its client dropped at ~700.
  - The cap is not the binding limit today: the client is, at ~600–700 live
    pieces in view.
- **What dominates?**
  1. Client main thread per piece.
  2. Wire per piece.
  3. Physics worker per awake piece.

  The server main tick is the cheapest of the four.

#### Count budgets with the flag on (not widened)

| Budget | fleet-fight on / off / budget | wide-view on / off / budget |
|---|---|---|
| rx KB/s | **415** / 260 / 334 | **507** / 330 / 418 |
| bodies per tick | **80.8** / 48.2 / 63 | **98.9** / 75.7 / 98 |
| swarm records per tick | **80.3** / 47.9 / 62 | **98.5** / 75.2 / 93 |
| swarm bytes per tick | **2,898** / 1,732 / 2,088 | **3,552** / 2,715 / 3,142 |

Source: `perfSceneCounts.test.ts`, first 12.6 s, one run each. With the flag
on, both scenes break their server budgets, because every piece is still
awake 0–12 s after its kill. They were NOT widened: the fixes below are the
way back under.

**30 s `fleet-fight` A/B, 4 reps** (`pnpm perf:scenes --scenes fleet-fight
--base HEAD --reps 4 --head-env EQX_SUBCAP_WRECKS=1`, both arms
`perfcounts=1`, offset 500). Verdict: **RED**.

| Metric | Verdict | Off | On | Ratio |
|---|---|---|---|---|
| rx KB/s | RED | 319 | 735 | ×2.31 |
| display objects | RED | 5,036 | 7,520 | ×1.49 |
| server tick p95 | INCONCLUSIVE (p 0.34) | 2.04 ms | 3.17 ms | ×1.55 |
| server tick p99 | GREEN | 5.27 ms | 5.96 ms | ×1.13 |
| client frame p95 / hitches / renderer p95 | GREEN | 16.75 / 0 / 2.0 | 16.7 / 0 / 2.25 | ×1 |

Print-only counts:

| Count | Off | On | Ratio |
|---|---|---|---|
| bodies per tick | 58.4 | 147 | ×2.5 |
| swarm records per tick | 57.3 | 145 | ×2.5 |
| contacts per tick | 10 | 32 | ×3.2 |
| worker tick p95 | 0.73 ms | 1.57 ms | ×2.2 |
| AI agents per tick | 57 | 94 | ×1.7 |
| swarm at the end | 50 | 236 | ×4.7 |

The on arm keeps more ships alive: debris absorbs shots.

#### Why pieces stayed awake, and the fix (2026-11-13, follow-up)

**Measured with a wake census.** `EQX_WAKE_CENSUS=1` turns on a dev-only
census in the physics worker (`core/physics/wakeCensus.ts`). Every 5 s it
posts a sample, which `/dev/perf` carries as `wakeCensus`. It records:

- each asleep → awake flip of a wreck piece, with its cause that tick:
  - an impulse command: `knock`, `missile` or `kick`;
  - else the fastest body the piece touches: `shipSlow` or `shipFast`
    (split at 20 u/s), `piece` or `scrap`;
  - else `none` (woken with no contact of its own: a contact over within
    the step, or island coupling);
- why each awake piece is awake at the sample: touching something,
  `drifting` (over Rapier's sleep thresholds) or `settling` (under them,
  with Rapier's 2 s timer running);
- the share of pieces older than 20 s that are asleep.

The headless soak `tests/integration/sectorRoom/wreckSleepSoak.test.ts`
(`EQX_WRECK_SOAK_S=210`) plays `fleet-fight-soak-lite` on a real server
with no browser. The pilot is only a body at the spawn, so its sleep
numbers match the browser take (~30 % asleep at 3 min in both).

**Cause breakdown, before (210 s, 614 pieces).** Wakes of a piece that was
resting (asleep ≥ 12 ticks):

| Cause | Wakes | Share |
|---|---|---|
| knock (`onWreckHit`) | 964 | 40 % |
| slow ship (< 20 u/s) touching it | 1,012 | 42 % |
| no contact of its own (`none`) | 394 | 16 % |
| fast ship | 38 | 2 % |
| piece, scrap, missile, kick | 0 | 0 % |

- At any sample, ~85 % of the awake pieces were **drifting**, ~10 %
  settling and ≤ 5 % touching a ship. So contact itself costs little; the
  drift after each wake costs a lot.
- A laser hit (12 damage) on half a fighter wreck is ~15 u/s, near the
  18 u/s knock cap. At damping 0.6/s that is ~7 s down to Rapier's
  0.4 u/s, then its 2 s timer: ~9 s awake per small-arms hit.
- Rapier's thresholds are global (`lengthUnit`) and the JS API has no
  per-body ones, so they can't simply be raised for wreck pieces.

**The fix** (shared numbers in the sub-cap profile, `destruction.ts`; the
capital profile is unchanged, so its pieces are knocked by every hit as
before):

- **Knock floor on resting pieces** (`knockWakeScale` 2). Server only: the
  knock is server-authoritative and the client never predicts it.
  - A hit on a piece that is ASLEEP shoves it only when its uncapped knock
    is at least 2 × `wreckKnockMax` (fighter: 36 u/s, i.e. ≥ ~30 damage
    on a big piece).
  - Small arms still stop on the piece but leave it asleep. A 5" shell or
    anything heavier wakes and shoves it as before.
  - Awake pieces are knocked by every hit, as before.
- **Settle-to-sleep** (`settlePerRadius` 0.125, `settleSpin` 0.3).
  - `World.setSleepSettle` puts a piece to sleep after it has moved slower
    than 1/8 of its kind's radius a second (fighter 3 u/s) and spun slower
    than 0.3 rad/s for `WRECK_SETTLE_STEPS` (30) fixed steps.
  - Rapier's own rule is 0.4 u/s for 2 s.
  - It is deterministic and set from `wreckBodyParams`, so the server
    worker and the client predWorld twin run the same rule (#15).
  - A contact or a heavy hit still wakes the piece. It then re-settles in
    a few seconds instead of ~9.
- No damping change and no shorter lifetime.

Locks:

- `World.sleepSettle.test.ts`: the settle rule, determinism, and the
  profile wiring.
- `tests/integration/sectorRoom/subcapWreckSleep.test.ts`: a resting piece
  stays asleep and still under three laser bolts, and a 400-damage hit
  wakes and shoves it. A ship passing close by never wakes it. After a
  slow nudge it is asleep again in ~4 s (~7 s before the fix). A hard ram
  still shoves it. Both tests fail with the fix's two profile numbers set
  to 0.

**After (same headless soak, same session):**

| t | pieces | asleep (all) before / after | asleep, pieces older than 20 s, before / after | worker p95 before / after (ms) |
|---|---|---|---|---|
| 60 s | 132 / 126 | 14 % / 28 % | 35 % / 74 % | 2.4 / 1.8 |
| 90 s | 210 / 188 | 17 % / 47 % | 44 % / 69 % | 4.5 / 1.3 |
| 120 s | 315 / 281 | 29 % / 54 % | 43 % / 79 % | 10.4 / (49.7)* |
| 150 s | 407 / 380 | 30 % / 66 % | 46 % / 75 % | 7.6 / 5.9 |
| 180 s | 509 / 466 | 19 % / 81 % | 29 % / 90 % | 14.5 / 5.6 |
| 210 s | 614 / 573 | 11 % / 72 % | 37 % / 87 % | 13.6 / 6.9 |

\* A one-off host spike (also at 135 s, 40.7 ms). Timings come from one
take on a shared host and are print-only.

- From 135 s on, 75–90 % of pieces older than 20 s are asleep (mean
  ~83 %), against 26–46 % before. The target was ≥ 80 %.
- Resting pieces woken by a knock: 964 → 15.
- The slow-ship wake count rises (2,347 by 210 s). Pieces now re-settle
  quickly, so the same pass wakes them again later. Each such wake now
  costs ~4 s of drift instead of ~9.
- The remaining awake pieces are mostly fresh debris still drifting from
  its death (`neverSleptAwake` ~30) and pieces in the melee being brushed.
- Wire and client costs still need a browser take: `pnpm perf:scenes
  --scenes fleet-fight-soak-lite --head-only --sample-ms 30000`.

#### What to fix (in order)

1. **Wire: sleeping pieces leave the 1 Hz full refresh.** Treat them like
   sleeping structures (in interest, or every 5th refresh). This is
   two-sided (#15): the client decoder deletes any swarm entity missing from
   a full refresh (`BinarySwarmDecoder`, structures exempt), so a kind-4
   piece must be exempt too while its wreck's descriptor is live. Its
   lifetime then comes from the descriptor set, which slice 3 sends as adds
   and removes. Do it on top of slice 3. Saves 36 B × sleeping pieces per
   second per client (~70 KB/s at the cap).
2. **Slice 3 (#547)** removes the repeated `wrecks[]` lists (~50 descriptors
   a snapshot by 270 s here).
3. **Client main thread.**
   - Profile one lite-soak take at ~500 pieces (`?perfprobe=1` + a CDP CPU
     profile).
   - Expected first fix: don't keep a predWorld body for a SLEEPING piece
     that is far from the pilot. A sleeping piece only matters to the
     pilot's collisions inside its own interest window.
   - Expected second fix: send the `wrecks` map to the renderer worker only
     when its version changes, not inside every frame's mirror.
4. **Let pieces actually settle in a fight.** DONE (2026-11-13): the knock
   floor and settle-to-sleep above. Never shorten the lifetime (plan: "the
   fix goes there, not into a shorter lifetime").
5. **Cap.** Keep 2,000 as the server's ceiling, but it never binds today. Until
   1–3 land, the practical limit is ~600 live pieces near one pilot.
   Re-measure after each fix with `fleet-fight-soak-lite`.

#### Client cost per wreck piece: profiled and cut (2026-11-13)

**Profile.** One lite-soak take with a CDP CPU profile of the client's main
thread, 15 s from ~480 pieces (`pnpm perf:scenes --scenes
fleet-fight-soak-lite --head-only --reps 1 --sample-ms 15000 --head-params
perfcounts=1 --no-load-gate --cpu-profile <file> --cpu-profile-at-pieces 450`,
port offset 600). The renderer worker is not in it.

| Main thread, 15 s at ~480 pieces | Before | After |
|---|---|---|
| Rapier `step` (wasm folded into its caller) | **56 %** | 10 % |
| of which the reconcile replay (`handleSnapshot` → `reconcile`) | 36 % | 6 % |
| of which `tickPhysics` | 23 % | 7 % |
| `WorkerRendererClient.post` (the mirror's structured clone) | 8 % | 10 % |
| idle | 13 % | 58 % |

So suspect 1 was the cost: every piece was an AWAKE predWorld body in every
replayed and predicted step. Two causes:
- the anchor woke every piece on every snapshot (`setShipState(…, wake)`),
  so a piece the server had put to sleep never slept on the client;
- every piece in the mirror had a body, however far from the pilot.

Decoding (`decodeSwarmPacket` < 1 %) and the `wrecks` map are not the cost.

**Fixes.**
1. A piece the server reports asleep stays asleep in the predWorld
   (`anchorRemoteSwarmBodies` → `World.setShipStateAsleep`: pose written
   without waking, then `sleep()`). Matches the server body (#15). Rapier
   still wakes it when the local ship touches it, so collision is unchanged.
2. Wreck pieces stream into the predWorld by edge distance from the local
   ship, like structures (`syncSwarmIntoPredWorld`, `wantPredBody`,
   `PREDWORLD_STRUCTURE_RADIUS` 1500 u + 300 u hysteresis). Still one body
   path (#12); a far piece has no body, so the local beam's drawn-pose test
   skips it (beams reach ≤ 325 u).

Locks (counts): `tests/unit/wreckPredCost.test.ts`: bodies = the pieces in
range (10 of 210 with the pile 4 km away, then the pile's 200 beside it);
awake bodies after the anchor and the steps = the server-awake ones (20 of
40); the ship ramming a sleeping piece still shoves it.

**Before / after** (same session, same host; another session's lite soaks
ran on the box throughout, host CPU 31 % before and 60 % after at the start,
`--no-load-gate`; compare within this table only):

| pieces | frame p95 before (ms) | frame p95 after (ms) |
|---|---|---|
| ~180 | 16.8 | 16.7 |
| ~380 | 16.8 | 16.8 |
| ~430 | 33.4 | 16.7 |
| ~480 | 116.7 (profiling) | 16.7 (profiling) |
| ~555 | 83.4 | 16.8 |
| ~650 | 66.7 | 16.7 |
| ~730 | 133.3 | 16.8 (33.3 at 746, 50 at 776) |
| ~870–1,050 | — | 16.7–16.8 |
| ~1,080 | — | 100 |
| ~1,150–1,340 | — | 100–117 |
| client | dropped at ~293 s, 785 pieces | dropped at ~460 s, ~1,340 pieces |

The wall moved from ~430 pieces (first 33 ms p95) to ~1,080. Not profiled
past it yet; the renderer p95 there was 9–11 ms and the server tick p95
13–14 ms.

**Caveat.** In this scene the pilot idles ~1,600 u from the melee, so the
streaming fix removes most pieces from the predWorld. A pilot inside the
pile keeps the bodies in range; for them fix 1 (sleep) is what helps, and it
only helps the pieces the server has put to sleep.

**Next.** The mirror's structured clone to the renderer worker is now the
largest single cost (10 %): it copies every swarm entry with its 10-pose
ring every frame, whatever changed. A wreck-only version stamp would not
touch that; candidates are to stop sending the pose rings of
entities whose sprite reads the resolved pose (per src/client/CLAUDE.md only
asteroids still interpolate off the ring in the renderer; check before
cutting) or to send swarm deltas.

#### The mirror post as a change set (2026-11-13)

**Fix.** The swarm no longer rides the per-frame `MIRROR_UPDATE` clone.
The renderer worker keeps its own copy (`SwarmMirrorReplica`,
`render/worker/swarmMirrorDelta.ts`); `WorkerRendererClient` posts the
mirror without `swarm` plus a change set built by `SwarmDeltaEncoder`:
- entries that are new or whose non-pose fields changed (a flag, a
  mount-angle array, a key added or dropped) are sent whole;
- entries whose only change is the pose fields go as float64 records with
  only the pose-ring slots written since the last post, in a buffer that
  is transferred and handed back on `FEEDBACK` (no per-frame allocation);
- removed ids; a new swarm Map (sector handoff) resets the worker copy.
An entry that did not change (a resting piece) is not sent. Change
detection compares each entry's own keys with a shadow of the last post,
so a field added to `SwarmRenderState` later is synced with no edit here.
The `?worker=0` path is untouched (the renderer reads the mirror directly).

**Locks** (`swarmMirrorDelta.test.ts`, through the real
`WorkerRendererClient.update` and a structured-clone fake worker; both
fail on the previous client): COUNT, 1,000 sleeping pieces + 12 moving
ships post ≤ 12 swarm entries per frame (was 1,012); PARITY (#15), the
worker's swarm equals the main thread's after every post across moves,
sleeps, wakes, more than a ring of packets between posts, adds, removes,
key changes and a Map swap.

**Profile** (head, same command as above, ~476 pieces, 15 s): the whole
post (`postMirror`: encode + clone + postMessage) is **3.4 %** of the main
thread (10 % before, previous table; a different session), of which the
change scan (`encode`) is 2.2 %. Main thread 81 % idle (58 % before).

**Soak** (same session, base `e4adef90` then head, one take each, port
offset 600, `--no-load-gate`, host CPU 15 % at the start):

| pieces | frame p95 base (ms) | frame p95 head (ms) |
|---|---|---|
| ~180–830 | 16.7–16.8 | 16.7–16.8 |
| ~850–940 | 16.7 | 83–167 (server worker p95 58–103 ms) |
| ~960–1,020 | 16.7–33.3 | 16.8–67 (recovering) |
| ~1,050–1,150 | 16.8 | 16.7–16.8 |
| ~1,160–1,200 | 50–100 | 16.8–33.4 |
| ~1,200–1,290 | 100–117, back to 33 at ~1,290 | 100–133 (~1,210–1,230) |
| client | no drop; the take hit the runner's limit at 511 s (~1,290 pieces) | dropped at ~478 s, ~1,231 pieces |

Each wall coincides with the SERVER's physics worker p95 passing ~20 ms
(base 21–35 ms from 1,157 pieces; head 25–60 ms from 1,209, and the head's
dip at ~850 with a 60–100 ms server burst); the renderer p95 stayed 6–12 ms.
So with the post cut, the client's frame p95 past ~1,000 pieces follows the
server tick, not the client. One take per arm: the drop/no-drop difference
is inside what a single take can tell.

**Next.** The remaining client-side swarm cost is the O(entries) change
scan (2.2 %); a dirty stamp written by the decoder and `updateMirror`
would make it O(changed) too, at the price of a stamp at every writer.

#### The decisive soak on the combined branch (2026-11-13)

**Question:** can debris be switched on in play? This is the branch
`subcap-combined` (`a01f30ab`), which has all the cost fixes above: the
prediction world keeps sleeping pieces asleep and streams pieces by
distance, light hits don't wake resting pieces, pieces settle after 0.5 s
near-still, and the mirror post is a change set. It does NOT have slice 3
(#547, wreck descriptors as deltas; still only on `feat/wreck-wire-deltas`).

**Answer: not yet. It does not hold for 10 minutes.** In both takes the client
dropped before the end (~500 s and ~545 s). Frame p95 stays flat at 16.7 ms
up to ~1,050–1,470 pieces, then breaks.

**How it was measured.**
- Command: `pnpm perf:scenes --scenes fleet-fight-soak-lite --head-only
  --reps 1 --sample-ms 30000 --head-params perfcounts=1 --head-env
  EQX_WAKE_CENSUS=1 --no-load-gate`, port offset 700.
- Two takes. Take 2 adds `--cpu-profile … --cpu-profile-at-pieces 1100`.
- The ">20 s" column is new on this branch (`perf:scenes` reads the wake
  census): it is the asleep share of pieces older than 20 s.
- Host: desktop (RTX 5070 Ti, 16 threads). Other sessions were running
  test suites throughout, so this is not a quiet host. Before take 1: CPU
  27 %, 11 GB free, 9 other node processes. Before take 2: CPU 100 %,
  6.8 GB free, 38 other node processes.
- Timings compare within this section only.

**Take 1 (flag on).**

| t | pieces | asleep (all / >20 s) | server tick p95 | worker p95 | rx KB/s (swarm / other) | frame p95 | draws p95 | display objects |
|---|---|---|---|---|---|---|---|---|
| 30 s | 65 | 23 % / 84 % | 0.9 | 0.6 | 169 (104 / 66) | 16.7 | 62 | 3,479 |
| 60 s | 129 | 43 % / 65 % | 3.6 | 1.9 | 398 (233 / 165) | 16.8 | 79 | 5,010 |
| 90 s | 205 | 34 % / 75 % | 7.6 | 2.6 | 579 (307 / 272) | 16.7 | 103 | 6,044 |
| 120 s | 309 | 52 % / 68 % | 10.3 | 3.8 | 783 (441 / 342) | 16.7 | 104 | 6,607 |
| 150 s | 392 | 41 % / 67 % | 15.6 | 4.3 | 934 (495 / 440) | 16.8 | 110 | 8,032 |
| 180 s | 478 | 50 % / 84 % | **17.4** | 4.6 | 1,105 (511 / 594) | 16.8 | 112 | 8,992 |
| 210 s | 586 | 58 % / 81 % | **22.6** | 5.7 | 1,348 (664 / 683) | 16.8 | 119 | 9,560 |
| 240 s | 664 | 66 % / 56 % | 6.9 | 7.5 | 1,674 (797 / 877) | 16.7 | 122 | 10,772 |
| 270 s | 753 | 65 % / 82 % | 5.1 | 8.0 | 1,705 (764 / 941) | 16.7 | 128 | 11,680 |
| 300 s | 844 | 63 % / 81 % | 6.1 | 10.1 | 2,026 (883 / 1,143) | 16.7 | 130 | 12,077 |
| 330 s | 951 | 75 % / 67 % | 6.0 | 12.5 | 2,592 (1,073 / 1,518) | 16.8 | 125 | 12,953 |
| 359 s | 1,048 | 62 % / 78 % | 6.1 | 14.5 | 2,820 (1,132 / 1,688) | 16.7 | 109 | 13,622 |
| 385 s | 1,134 | 65 % / 70 % | 9.5 | **34.2** | 2,851 (1,130 / 1,721) | **66.6** | 104 | 14,289 |
| 402 s | 1,195 | 66 % / 62 % | **19.9** | **49.2** | 1,589 (865 / 725) | **133** | 95 | 14,498 |
| 426–489 s | 1,273–1,443 | 55–77 % / 64–82 % | 7.6–16.7 | **38.6–40.2** | 1,659–1,850 | **117** | 92–104 | 14,753–15,744 |
| ~500 s | client dropped | | | | | | | |

**Take 2 (flag on, client profile at ~1,140 pieces).**

| t | pieces | asleep (all / >20 s) | server tick p95 | worker p95 | rx KB/s (swarm / other) | frame p95 | draws p95 | display objects |
|---|---|---|---|---|---|---|---|---|
| 61 s | 115 | 23 % / 54 % | 4.3 | 1.8 | 444 (266 / 179) | 16.8 | 90 | 5,196 |
| 121 s | 288 | 46 % / 71 % | 3.2 | 3.0 | 795 (418 / 377) | 16.7 | 105 | 7,164 |
| 181 s | 439 | 49 % / 80 % | 3.2 | 3.4 | 1,297 (621 / 676) | 16.7 | 126 | 9,495 |
| 241 s | 626 | 59 % / 77 % | 3.9 | 3.8 | 1,638 (757 / 881) | 16.8 | 145 | 11,090 |
| 301 s | 816 | 62 % / 74 % | **20.3** | 10.4 | 1,928 (901 / 1,027) | 16.7 | 178 | 12,865 |
| 360 s | 1,034 | 62 % / 70 % | 8.6 | 11.1 | 2,428 (1,061 / 1,367) | 16.8 | 182 | 13,944 |
| 390 s | 1,142 | 68 % / 87 % | 6.3 | 8.0 | 2,380 (1,066 / 1,315) | 16.8 | 183 | 14,493 |
| 450 s | 1,361 | 66 % / 80 % | 7.4 | 9.0 | 2,866 (1,221 / 1,645) | 16.8 | 192 | 15,651 |
| 481 s | 1,470 | 68 % / 81 % | 7.7 | 12.7 | 3,009 (1,291 / 1,718) | 16.8 | 188 | 16,076 |
| 511 s | 1,592 | 62 % / 82 % | 7.3 | 13.9 | 2,182 (977 / 1,205) | **100** | 171 | 16,336 |
| 540 s | 1,710 | 64 % / 74 % | 6.9 | **16.3** | 1,810 (733 / 1,077) | **117** | 171 | 16,505 |
| ~545 s | client dropped | | | | | | | |

All times are in ms. "Other" rx is the msgpack messages, mostly `wrecks[]`
descriptors: 90–150 per snapshot past 1,000 pieces.

**Against the target.**

| Target | Result |
|---|---|
| 10 min without dropping the client | **No.** It dropped at ~500 s (~1,440 pieces) and ~545 s (~1,710 pieces). |
| Client frame p95 flat at ~16.7 ms | **Yes until it breaks**: up to ~1,050 pieces in take 1 and ~1,470 in take 2. Then 66–133 ms and it never recovers. |
| Server tick p95 under ~16 ms | **Mostly.** Bursts of 17–23 ms at 400–600 pieces in take 1 and at ~800 in take 2, and 20 ms at the take-1 wall. Otherwise 3–10 ms. |
| Physics worker p95 under ~16 ms | **Until ~1,100–1,700 pieces.** Take 1 crossed at ~1,130 pieces (34–49 ms after that). Take 2 crossed at ~1,710. The headless run (no browser) stayed ≤ 10 ms up to 1,434. |
| Wire rx sane | **No.** 1.0 MB/s at ~400 pieces, 2.4–3.0 MB/s at 1,000–1,500 pieces. More than half is the repeated descriptor lists, which slice 3 removes. |
| Asleep, pieces older than 20 s, ≥ 80 % | **Close, not met.** Mean from 150 s on: 73 % (take 1) and 77 % (take 2), ranging 56–88 %. The headless soak said ~83 %. |
| Draw calls / display objects | Bounded: 60–190 draws; ~10 display objects per piece. |
| How far the cap fills | **It never fills.** Pieces came at ~150–200 a minute, so the 2,000 cap would fill at ~10.5 min. The client dropped at 1,440–1,710. |

**The first wall: the client's main thread.**
- In take 2 the client broke at ~1,590 pieces while the server was healthy
  (tick p95 7 ms, worker p95 14 ms).
- In take 1 it broke at ~1,130 pieces in the same 30 s as a burst in the
  server's physics worker (p95 34–49 ms). One take can't tell whether that
  burst triggered it.
- The break is a one-way switch: frame p95 jumps from 16.7 to 66–133 ms and
  never comes back. That fits a catch-up spiral: a frame over budget makes
  the next one run more fixed steps, and each step is dearer with more
  pieces.

**Client profile** (take 2, main thread, 15 s from 1,142 pieces, while frame
p95 was still 16.8 ms; wasm folded into its JS caller):

| Main thread, 15 s at ~1,140 pieces | Share |
|---|---|
| idle | 42 % (81 % at ~480 pieces, previous section) |
| Rapier `step` in the predWorld | **23 %** (10 % at ~480) |
| of which the reconcile replay (`handleSnapshot` → `reconcile`) | 10 % |
| of which `tickPhysics` | 16 % (whole function, Rapier included) |
| the mirror post (`postMirror`: change scan `encode` 4 %) | 6 % |
| snapshot decode + `onMessage` (msgpack, zod) | ~6 % |
| `writeE2EDataset` | 3 % (webdriver-only: players don't pay it) |

So the predWorld step is again the biggest cost, and it more than doubled
between ~480 and ~1,140 pieces even with distance streaming and sleep. In
this scene the pilot idles ~1,600 u from the melee, and the debris spreads
inside the 1,500 u + 300 u streaming radius. So most pieces get a body, and
each one costs in every replayed and predicted step.

**Server worker profile** (the headless soak at 1,450 pieces, 15 s, through
the inspector's `NodeWorker` domain; one-off scratch script, not committed).
- Rapier's `stepWithEvents` takes **65 %** of the worker.
- The JS around it is small: `getAllShipStates` 3.6 %, `drainContacts`
  0.9 %, `settleStep` 1 %.
- The cost is inside Rapier's step: ~410 bodies stepped a tick (~35 % of the
  pieces awake, plus ~300 ships) and ~56 contacts a tick.
- The profiler's own cost made this window's timings meaningless (p95
  365 ms). Only the shares count.

**Count gates with the flag on** (`EQX_SUBCAP_WRECKS=1 pnpm vitest run
--config vitest.integration.config.ts tests/integration/sectorRoom/perfSceneCounts.test.ts`,
one run each, not widened):

| Budget | fleet-fight on / budget | wide-view on / budget |
|---|---|---|
| rx KB/s | **405** / 334 | **524** / 418 |
| bodies per tick | **78.1** / 63 | **100.0** / 98 |
| swarm records per tick | **77.5** / 62 | **99.4** / 93 |
| swarm bytes per tick | **2,797** / 2,088 | **3,587** / 3,142 |

These are about the same as before the fixes (415 / 80.8 and 507 / 98.9).
The gate window is the first 12.6 s, and in that window every piece is fresh
and still drifting. Settle-to-sleep can't help there.

**The full soak (30 a side)** was not run. The lite soak didn't hold, and the
full soak's ship pile-up drops its client earlier whatever the debris does.

**What to fix next (in order).**
1. **Client predWorld: give far pieces no body, or a smaller radius for
   sleeping ones.**
   - Wreck pieces stream at the structure radius (1,500 u + 300 u). The
     pilot's collisions only need pieces it can reach within the replay
     window, and its beams reach ≤ 325 u.
   - **Done (`perf/subcap-final`):** kind 4 streams at its own radius,
     `PREDWORLD_WRECK_RADIUS` = 600 u (+ the same 300 u hysteresis),
     measured as the gap between hulls (piece edge to the local hull's
     edge, so a 213 u crossguard isn't short-changed). Why 600 u is safe,
     at the shipping 2× scale: the fastest playable ship is the havok at
     850 u/s (boost adds thrust, not top speed; the cap is maxSpeed × the
     topSpeed stat), 1,232.5 u/s fully levelled (9 points × 5 %). A
     correction replays ~20 ticks (1/3 s): 283 u un-levelled, 411 u
     levelled, both well inside 600 u, and beams reach ≤ 325 u. Not covered:
     a stall that fills the 128-tick input ring (~2.1 s), and warp cruise;
     both are a rubber-band whatever the radius. Locks in
     `wreckPredCost.test.ts`: a field of pieces out to 800 u gets bodies
     only within 600 u (the piece beside the pilot always), pieces already
     in keep them to 900 u, and the fastest ship's travel in a 20-tick
     replay is ≤ 0.8 × the radius.
   - Second step: a sleeping piece needs no body in the reconcile replay
     unless the local ship's swept path reaches it.
   - Re-profile at ~1,100 pieces with the pilot inside the pile as well as
     at the spawn: inside the pile, streaming can't help.
2. **Wire: merge slice 3 (#547, `feat/wreck-wire-deltas`)** into the combined
   branch, then take sleeping pieces out of the 1 Hz full refresh ("What to
   fix", item 1). The descriptor lists are ~55 % of rx past 1,000 pieces.
3. **Server worker: fewer awake bodies in the pile.**
   - About a third of the pieces are awake at any time, and the Rapier step
     itself is the cost.
   - Measure first: the island count, the piece-piece contact pairs and the
     share of the step spent on sleeping colliders (broad phase). Only then
     choose between piece-vs-piece collision filtering for sub-cap debris
     and a lower cap.
   - Today the worker holds ≤ 16 ms up to ~1,400–1,700 pieces on a quiet
     host, and only ~1,100 under load.
4. **Sleep share:** at 73–77 % in the browser takes, it is close to 80 %. Look
   at it again after 1–3; it is not what breaks first.

A take that drops writes no series to its JSON ledger, so the tables above
(from the runner's per-sample log lines) are the record. Timings come from
a shared host and compare within this section only.

#### Soak with time dilation on vs off (2026-11-14, `perf/subcap-final`)

**Question:** there is no hard 2,000-piece cap. The game's own slowdown is
meant to be the safety valve. The earlier soaks ran in a test room with the
slowdown off. With it on, does the sector slow down as the debris grows, and
does the client stay smooth?

**Answer: the client stays smooth for the full 10 minutes in every take, with
or without dilation. The slowdown barely took part.** No take dropped the
client: up to ~1,450–1,640 pieces at the end, against drops at 1,440–1,710 in
the soak above. Frame p95 held at 16.7–16.8 ms until the last 30 s. The cost
fixes on this branch did that (the 600 u wreck prediction radius, #547 deltas
and the fixes above), not dilation. The controller only answered brief server
stalls: it slowed the sector for 8–18 s, then came back to 1×. It reached the
0.7 floor once, in the last ~15 s of take ON-2 (~1,590 pieces). That window
also had the only client trouble in that take (frame p95 33 ms, 59 hitches),
so dilation did not keep that moment smooth. One window can't say whether the
slowdown caused that trouble or only came with it.

**How it was measured.**
- New scene `fleet-fight-soak-lite-dilated` (`perfScenes.ts`): the same room
  as `fleet-fight-soak-lite` plus `autoTimeScale: true` **and
  `perfFixedLoad: false`**. Every perf room is defined with
  `perfFixedLoad: true`, which skips the slowdown controller, the cost clock
  and the load shedder. With that left on, `autoTimeScale` does nothing. So in
  this scene the room protects itself the way a real sector does, and that
  includes the load shedder (below).
- The runner now logs the sector's speed and load factor in each sample
  (`/dev/perf` `timeScale`). It also allows a dilated scene up to 1/0.7 × its
  length in wall time.
- Command: `pnpm perf:scenes --scenes fleet-fight-soak-lite-dilated
  --head-only --reps 1 --sample-ms 30000 --head-params perfcounts=1
  --head-env EQX_WAKE_CENSUS=1 --no-load-gate`, port offset 300, head
  `febef59d` plus the scene change. Sub-cap flag on through the room option.
- Three takes:
  - **OFF:** the first take, run before the `perfFixedLoad` fix. The
    controller code was skipped, so this room behaves exactly like
    `fleet-fight-soak-lite`.
  - **ON-1** and **ON-2:** dilation really on. ON-2 kept the server log, which
    records every speed change.
- Host: desktop (RTX 5070 Ti, 16 threads), 9–11 GB free, CPU 8–40 % before
  each take. Other sessions were on the host, but no suites ran during the
  takes.
- Ignore the runner's end-of-take summary line (e.g. "rx 233,256 KB/s, frame
  p95 49.9"). It reads the client after the last per-sample reset, over a few
  seconds after the scene ended. The per-sample rows below are the record.

**OFF (dilation off), one row a minute.**

| t | pieces | asleep (all / >20 s) | tick p50 / p95 | worker p95 | speed | frame p50 / p95 / p99 | hitches | rx KB/s |
|---|---|---|---|---|---|---|---|---|
| 60 s | 84 | 33 % / 35 % | 0.8 / 1.0 | 0.8 | 1 | 16.7 / 16.7 / 16.8 | 7 | 405 |
| 120 s | 225 | 38 % / 57 % | 1.5 / 1.9 | 1.4 | 1 | 16.7 / 16.7 / 16.8 | 3 | 925 |
| 180 s | 353 | 59 % / 73 % | 2.5 / 3.1 | 2.1 | 1 | 16.7 / 16.7 / 16.8 | 0 | 1,449 |
| 240 s | 499 | 59 % / 63 % | 3.8 / 4.3 | 3.2 | 1 | 16.7 / 16.8 / 16.8 | 2 | 1,884 |
| 300 s | 708 | 52 % / 65 % | 4.5 / 5.2 | 4.5 | 1 | 16.7 / 16.8 / 16.8 | 1 | 2,579 |
| 360 s | 874 | 38 % / 56 % | 5.9 / 7.6 | 8.5 | 1 | 16.7 / 16.8 / 16.8 | 0 | 3,081 |
| 420 s | 1,063 | 28 % / 41 % | 6.9 / 8.7 | 10.8 | 1 | 16.7 / 16.8 / 16.8 | 1 | 3,880 |
| 480 s | 1,238 | 42 % / 58 % | 8.1 / 9.5 | 12.2 | 1 | 16.7 / 16.8 / 16.8 | 4 | 4,377 |
| 540 s | 1,449 | 46 % / 52 % | 8.5 / 10.9 | 16.5 | 1 | 16.7 / 16.7 / 16.8 | 1 | 4,657 |
| 595 s | 1,639 | 44 % / 44 % | 8.9 / 11.7 | **23.5** | 1 | 16.7 / 16.8 / **33.4** | **20** | 5,563 |

**ON-2 (dilation on), one row a minute.** The speed column is the sector's
speed when the sample was read.

| t | pieces | asleep (all / >20 s) | tick p50 / p95 | worker p95 | speed | frame p50 / p95 / p99 | hitches | rx KB/s |
|---|---|---|---|---|---|---|---|---|
| 60 s | 97 | 23 % / 64 % | 0.8 / 1.1 | 0.9 | 1 | 16.7 / 16.8 / 16.8 | 3 | 369 |
| 120 s | 216 | 63 % / 65 % | 1.8 / 2.4 | 1.8 | 1 | 16.7 / 16.8 / 16.8 | 4 | 923 |
| 180 s | 358 | 53 % / 63 % | 2.9 / 3.6 | 2.6 | 1 | 16.7 / 16.8 / 16.8 | 3 | 1,466 |
| 240 s | 505 | 59 % / 66 % | 4.5 / 5.6 | 3.9 | 1 | 16.7 / 16.7 / 16.8 | 0 | 2,036 |
| 298 s | 635 | 49 % / 59 % | 5.6 / 7.0 (p99 29) | 5.2 | **0.80** | 16.7 / 16.8 / 16.8 | 3 | 2,524 |
| 357 s | 808 | 51 % / 63 % | 6.9 / 8.5 | 6.0 | 1 | 16.7 / 16.8 / 16.8 | 1 | 3,305 |
| 416 s | 1,043 | 32 % / 58 % | 7.6 / 9.3 | 8.7 | 1 | 16.7 / 16.7 / 16.8 | 2 | 4,004 |
| 476 s | 1,232 | 35 % / 56 % | 8.7 / 10.7 | 13.5 | 1 | 16.7 / 16.8 / 16.8 | 1 | 4,899 |
| 536 s | 1,432 | 58 % / 58 % | 8.2 / 9.9 | 11.7 | 1 | 16.7 / 16.7 / 16.8 | 0 | 5,394 |
| 594 s | 1,588 | 63 % / 59 % | 9.8 / 13.1 | **21.4** | **0.70** | 16.7 / **33.3** / 33.4 | **59** | 5,724 |

Times are in ms. ON-2's rx tracks OFF within ~10–20 % (ON-1: 4.7 MB/s at
1,312 pieces). Wreck descriptors stayed at ~1 a snapshot in every take, so the
#547 deltas work. Most of the 4–5.5 MB/s at 1,200–1,640 pieces is the msgpack
side (2.4–3.0 MB/s) plus the swarm channel (1.8–2.6 MB/s). With ~400 ships
alive at the end, it is not the descriptor lists any more.

**What the slowdown did (ON-2 server log, every speed change).**

| scene time (≈) | pieces | change | trigger |
|---|---|---|---|
| ~290 s | ~620 | 1 → 0.75, back to 1 in 5 % steps over 18 s | 25 % of a window's ticks late (tick p99 29 ms) |
| ~372 s | ~870 | 1 → 0.92, back to 1 in 16 s | 8 % late (tick p95 19.8 ms in that sample) |
| ~580 s | ~1,550 | 1 → 0.90, back to 1 in 6 s | 10 % late |
| ~595 s | ~1,590 | 1 → 0.86 → **0.70** within 1 s; still at 0.70 when the scene ended | 14 %, then 35 % late |

- **ON-1** shows the same pattern. Speed read 1 at every sample except
  t = 537 s (0.95, ~1,370 pieces). That take's server log was not kept.
- **Load shedder:** when the speed sits at the floor and ticks run over
  budget, `LoadShedder` quietly removes the drones farthest from the pilot.
  In both ON takes, ships vanished without leaving debris right where the
  speed dipped. ON-1: ~325 ships between t = 510 and 537 s, while pieces grew
  by only 60. ON-2: ~200 ships in the last 30 s. A dying ship always breaks
  into pieces, so these ships were shed, not killed; the shedder writes no
  log line, so this is inferred from the counts. In the fight this looks like
  part of a fleet disappearing. It is the existing second safety valve, not
  dilation, and it fires only at the 0.7 floor.

**Against the questions.**

| Question | Result |
|---|---|
| Does the controller slow the sector? | **Rarely and briefly.** It reacts to server lateness (late ticks). At these counts the server's tick p95 stays at 1–13 ms and the physics worker p95 at 1–16 ms until ~1,500 pieces. So it slows only on stalls: four times in ON-2, down to 0.75–0.92 for 6–18 s, then the 0.7 floor at ~1,590 pieces. |
| When the client first drops | **Never** in any take (OFF to 1,639 pieces, ON-1 to 1,449, ON-2 to 1,588). The first client trouble: frame p99 33 ms and 20 hitches in OFF's last sample (1,639 pieces); frame p95 33 ms and 59 hitches in ON-2's last sample (1,588 pieces, speed 0.7). Both coincide with the physics worker p95 passing ~20 ms. |
| Asleep share (pieces older than 20 s) | 41–73 %, mostly 52–65 %, in every take. Lower than the 73–77 % above. Dilation does not change it. |
| Bytes/s | 0.4 MB/s at ~100 pieces, ~2.5–3.0 MB/s at ~650–720, 4.4–5.9 MB/s at 1,230–1,640. About the same with dilation on and off. |

**Verdict, in plain words.** At the debris counts a 10-minute,
1,200-death fight leaves behind (up to ~1,600 pieces), the client now stays
smooth on its own. Time dilation is not what keeps it smooth: the slowdown
only answers the server falling behind, and at these counts the server
rarely does. When the server does start to fall behind (~1,550–1,650 pieces,
physics worker p95 past ~20 ms), the slowdown does kick in. But in the one
window we caught, the client already showed 33 ms frames with dilation on,
just as it did without. And at the floor, the load shedder deletes ships.
So dilation is a valve for the SERVER, not a guarantee for the client.
Whether it can hold the line past ~1,600 pieces needs a longer take (15–20
min) with the server log kept, where the speed stays at 0.7 for minutes, not
seconds. Watch the shedder in that take: whole fleets disappearing is worse
for players than slow motion.

### Switched on (2026-11-14)

**Owner decision:** "land it switched on". The capital and sub-capital
break-up are ON in every room by default.

- **Switch.** `wreckSwitchOn` (`src/server/rooms/wreckSwitch.ts`): the env
  `EQX_CAPITAL_WRECKS` / `EQX_SUBCAP_WRECKS` wins (`0` off everywhere, `1`
  on); otherwise a room opts out with `capitalWrecks: false` /
  `subcapWrecks: false`. The welcome flags follow the room, so a client
  draws the break-up wherever the server breaks ships.
- **One death effect per ship.** A kind that breaks up never also sheds
  scrap: the composite kinds (havok, the cargo pod) have profile `none` and
  keep their per-component scrap. Lock: `tests/unit/oneDeathEffectPerShip.test.ts`.
- **Arcade handling (#566) and the knock.** Arcade raised sub-cap hulls
  ×1.6–1.75, and the overkill knock reads damage ÷ max hull, so a small-arms
  hit shoved a fighter piece 8.4 u/s instead of the approved 10–25.
  `wreckKnockSpeed` now carries the kind's arcade `tough` factor (capitals
  ×1): a tougher hull makes the fight longer, not its debris heavier.
- **Count gates** (`perfSceneCounts.test.ts`, first 12 s, desktop, this
  branch; 4 runs on, 2 with both env switches `0`):

  | Count | fleet-fight on / off | wide-view on / off |
  |---|---|---|
  | bodies per tick | 74.9–77.3 / 58.3–58.4 | 98.1–99.1 / 81.6–81.9 |
  | of which wreck pieces | 14.7–17.0 / 0 | 13.3–14.8 / 0 |
  | AI agents per tick | 59.3–59.8 / 56.3–56.4 | 81.9–82.8 / 78.8–79.2 |
  | swarm records per tick | 73.5–75.5 / 56.9–57.0 | 97.5–98.6 / 81.1–81.3 |
  | swarm bytes per tick | 2,653–2,724 / 2,056–2,059 | 3,518–3,556 / 2,926–2,935 |
  | bytes per record | 36.1 / 36.1 | 36.1 / 36.1 |
  | rx KB/s (budget) | 283–287 / 248 (334) | 377–381 / 343–346 (418) |

  The rise is the pieces (every kill in the window leaves 2–3 fresh, still
  drifting bodies) plus ~3 ships still alive because the debris stops shots.
  The per-entity cost is flat. The budgets were re-set to the on max + 25 %
  (`perfBudgets.ts`, `measuredBreakUp`). The 10-minute soak above stays
  smooth to ~1,600 pieces and never drops the client.

### Reads as broken (take 9 review, 2026-11-14)

**What the review saw.** A robot-square died and its hull "stays whole, a
grey pod pops out, only a faint red cut line", then "reads as a robot
sitting still" for 13 s. An orange heavy's two pieces "drift side by side
for ~18 s, like two live ships flying together". A robot's hull "stays
whole ~1.5 s before parting".

**Cause, measured** (`buildWreckPieces` over 200 deaths per kind; the
server agreed):

| Kind | Pieces (2 / 3) | Largest piece, max (mean) | Slowest pair parts at | Gap 1 s later |
|---|---|---|---|---|
| robot-square | 193 / 7 | 73 % (61 %) | 0.61 r/s = 14.6 u/s | 0.47 r |
| robot-circle | 198 / 2 | 69 % (60 %) | 0.60 r/s = 18.1 u/s | 0.47 r |
| heavy | 170 / 30 | 85 % (65 %) | 0.56 r/s = 18.0 u/s | 0.46 r |
| fighter | 182 / 18 | 80 % (64 %) | 0.55 r/s = 13.1 u/s | 0.44 r |

- The sound primary crack only had to leave 15 % of the hull on its small
  side, so on 1 death in 3 (heavy, fighter, gunship, scout) the big piece
  was 70–85 % of the hull: a whole-looking ship with a chip off.
- The pieces parted at ~0.55–0.6 radii/s. Under damping 0.6/s that is
  about ONE radius in all, while both pieces carry the dead ship's few
  hundred u/s (that momentum is kept: the debris drifts on, then rests).
  So they flew on side by side, and the parting was too slow to see in the
  first second.
- Not decorations: a piece is its art mesh plus the 1 s glow. No turret
  cluster, text, charge ring or elite ring (sprite path is `kind === 1`
  only), no engine exhaust (`PixiRenderer.drawFxEngines` draws drones
  only), no lock (a lock key resolves ships and structures only;
  `MissileSimulation` skips kind 4), no far-zoom icon or radar contact. The
  "grey pod" is the kill's loot pod in its normal colour, beside the wreck.

**Fix** (profile data, no branch):

- `fractureHull` option `soundMinShare` (default 0.15, capitals unchanged);
  the sub-cap profile sets 0.33, so each side of the primary crack holds a
  third of the hull or more and no piece is over 70 % after the jag.
  `FRACTURE_ALGO_VERSION` 8 (sub-cap output changed; the capital golden
  hash is the same).
- `separateScale` 40 → 160: every cut opens, and every pair of piece
  centres parts, at `wreckSeparate` (1.4 % of the radius a second, #18) ×
  160 ≈ 2.2 radii/s. The halves visibly come apart in the first frames and
  drift off from each other, ~3.7 radii apart at rest. Momentum is kept
  (equal and opposite impulses), so the debris still drifts along the dead
  ship's path and sleeps.

**After** (same measure, 60 deaths per kind at 0.8 × top speed):

| Kind | Largest piece | Slowest pair parts at | Gap 1 s later (server, killed while flying) |
|---|---|---|---|
| robot-square | 68 % | 2.44 r/s = 58.7 u/s | 1.66 r |
| robot-circle | 68 % | 2.46 r/s = 73.7 u/s | 1.78 r |
| heavy | 68 % | 2.31 r/s = 73.9 u/s | 1.73 r |
| fighter | 66 % | 2.20 r/s = 52.8 u/s | 1.74 r |

Every other sub-cap kind: largest ≤ 68 %, slowest pair ≥ 2.16 r/s. The
fastest single piece drifts < 6 radii in all (a fighter ~116 u). Pieces
still sleep: a fighter at rest ~4.8 game s, at full speed and turning
~9.5 s, a missile frigate ~7.9 s, a robot hexagon ~7.7 s. Piece counts are
unchanged (2–3), and `perfSceneCounts` stays inside the
`measuredBreakUp` budgets (fleet-fight 74.8 bodies/tick, 12.9 wreck
pieces, 282 KB/s; wide-view 93.2 bodies/tick, 365 KB/s), so the budgets
are not re-set.

Locks: `wreckPieces.subcapParting.test.ts` "read as broken" (every
sub-cap kind: 2–3 pieces, largest ≤ 70 %, every pair parting ≥ 2 radii/s);
`subcapWrecks.test.ts` "stand clearly apart" (fighter, robot-square,
robot-circle, heavy, robot hexagon, missile frigate killed while flying,
narrowest gap ≥ 0.75 radii 1 game s later; 0.42–0.47 before);
`swarmSpriteUpdater.subcapWreck.test.ts` "no live-ship decorations".

**Take 10 follow-up (2026-11-14).** The review of take 10 (with the fix
above) still saw a robot-square's biggest piece (~70 %) "keep the robot's
glowing eye", read as a live robot flying with a fighter, and AI 004's
pieces "only widen ~30 → 45 px over 3 s".

- **The client draws what the server simulates.** Measured from the clip
  (npc-dogfight 16.8–20.2 s, ~0.69 px per u at that zoom): centre gap 28,
  44, 53, 65 px at +0.6, +1.2, +2.0, +2.8 s after the death; the server
  kicks (2.44 r/s for robot-square, damping 0.6/s) predict 35, 49, 62, 69
  px. Same path, no hold, no old separation: the reviewer's window was the
  tail, after damping had taken most of the parting. The look was too small,
  not wrong on the client.
- **The eye was the live bake.** A wreck piece drew its parent's LIVE art,
  so a robot's emissive core ring (`forgeShip`'s robot core) stayed on
  whichever piece held the middle. Profile flag `fx.deadArt` (sub-cap true,
  capital false): a sub-cap piece draws the parent's dead bake (BakeJob
  `ship` with `dead`, key `:D`, the forge's `scrap` look: no core,
  canopy, nozzles or running lights). Same hull, plating, paint and grid, so
  the piece UVs line up; not darkened. One extra small bake per sub-cap kind
  that dies. Locks: `src/client/render/art/wreckPieceArt.test.ts` (no
  emissive texel, same grid), `swarmSpriteUpdater.subcapWreck.test.ts`
  "draw the dead bake".
- **Bigger split, faster parting.** `soundMinShare` 0.33 → 0.43 (largest
  piece ≤ 60 %) and `separateScale` 160 → 240 (every pair parts at ≥ ~3.3
  radii/s; a robot-square ~88 u/s, ~2.75 radii apart 1 s later, ~6 at
  rest). The fastest single piece drifts < 8 radii in all.

| Kind | Largest piece (×160 → ×240) | Slowest pair parts at | Server gap at 1 s, killed while flying |
|---|---|---|---|
| robot-square | 68 % → 58 % | 58.7 → 87.9 u/s (3.66 r/s) | 1.65 → 2.23–2.25 r |
| robot-circle | 68 % → 58 % | 73.7 → 110.7 u/s (3.69 r/s) | 1.78–1.88 → 2.75–2.82 r |
| heavy | 68 % → 57 % | 73.9 → 109.2 u/s (3.41 r/s) | 1.42–1.73 → 1.97–2.88 r |
| fighter | 66 % → 57 % | 52.8 → 86.3 u/s (3.60 r/s) | 1.74–1.77 → 2.52–2.82 r |

Every sub-cap kind: largest ≤ 58 %, slowest pair ≥ 3.27 r/s. Sleep times
unchanged (fighter at rest ~5.2 game s, at full speed ~9.2 s). perfSceneCounts:
fleet-fight 73.2 bodies/tick, 12.8 wreck pieces, 295–302 KB/s (budget 334);
wide-view 98.6 bodies/tick, 13.4 pieces, 406–410 KB/s (budget 418): piece
counts unchanged, budgets not re-set. Locks tightened: "read as broken"
(largest ≤ 60 %, pairs ≥ 3 r/s) and "stand clearly apart" (≥ 1.5 radii).

### Kill cuts: beam slices and railgun channels (fracture v9, 2026-11-14)

Plan "beam slices, railgun channels, capital heavy beams", steps 2–4 (the
fracture, the wire, the server's death wiring, the instant split and the
look of a cut kill). Owner: a heavy-beam kill slices the ship along the beam's
line; a railgun kill erases a straight channel as wide as the bolt.

- **Weapon record.** `WeaponDefBase.killCut?: { kind: 'slice'; width? } |
  { kind: 'channel'; width }` (`combat/WeaponCatalogue.ts`, `width` in world
  units). The heavy beam sets `{ kind: 'slice', width: HEAVY_BEAM_WIDTH }`
  (60 u, v10), the capital railgun `{ kind: 'channel', width:
  RAILGUN_BOLT_WIDTH }`.
- **Wide slice (v10, 2026-11-15).** Owner: "the slice is too thin compared to
  the width of the beam". A slice with a width over 0 erases a straight strip
  that wide along its line through the channel's code (two straight
  `EDGE_CUT` lines at ±width/2, the strip and any part under
  `CHANNEL_SLIVER_SHARE` beside it dropped), keeping the slice's sliver slide
  and its `slice` kind on the wire (`cutKind: 'slice'`, so the client still
  tints it violet; the descriptor carries `cutW`, which the server now sends
  for any cut with a width). Its banks part like the channel's
  (`findSeams(geom, cutW)` for any cut kind). The violence table, the v10
  splinters and the straight cut edges are as for a channel. The client
  draws the heavy beam's core `HEAVY_BEAM_WIDTH` wide too
  (`HEAVY_BEAM_STYLE.width`, weapon-mounts.md "Heavy beam look"), so the gap
  and the beam that made it match. A slice with width 0 is v9's zero-width
  line. Locks: "golden: v9 kill cuts" (`wideSlice`), `wreckPieces.test.ts`
  banks part (slice), `wreckGeometryParity` "battleship wide slice",
  `beamStyles.test.ts`, `capitalWrecks.test.ts`.
- **Fracture input.** `FractureInput.cut?: { kind, dirX, dirY, width }` in the
  hull's frame. The line runs through the kill point (on the outline) along
  the direction; a zero direction is no cut.
  - **Slice:** that line IS the primary crack: no seeded tilt, no tip shift,
    no sub-capital sound-primary move. Its edges are `EDGE_CUT`, which
    `jagged()` leaves out (like `EDGE_SECTION`), so the main cut is dead
    straight while the other cracks stay jagged. The violence table and snap
    draw are unchanged. On a sub-capital the secondary crack (`extraCrack`) is
    the un-cut one, laid out from the line the hull would have cracked along
    without the cut (`crackPrimary`). A capital's secondary cracks are
    splinters off the cut (v10, next bullet).
  - **Sliver guard (slice):** where the line through the kill point would
    leave a piece under the profile minimum (capital: `PRIMARY_MIN_SIDE` 3 %;
    sub-capital: its `soundMinShare`), it slides toward the hull's centroid
    in `CUT_SLIDE_STEPS` (16) steps, keeping the shot's direction, until
    every piece clears (last resort: through the centroid).
  - **Channel:** two straight `splitByLine` passes at ±width/2, both
    `EDGE_CUT`; the strip between them is dropped, and a part under
    `CHANNEL_SLIVER_SHARE` (5 %) of the hull beside it is erased too. The
    other cracks then split what is left. A cut is never dropped by the
    piece-cap retry: with every other crack gone it stands whatever the count.
  - **Channel banks part:** the two banks face each other a channel width
    apart, so they are not a shared cut; `findSeams(geom, channelGap)` pairs
    them anyway (`EDGE_CUT` edges on the line `channelGap` out along the
    normal), so the separation pass opens the channel like any cut. Without
    it the kill push closed the channel at ~20–45 u/s while the jagged cracks
    opened (rail-channel film 2026-11-15). Lock: `wreckPieces.test.ts`
    "railgun channel banks part".
  - No new seeded draw: a fracture without a cut is byte-identical to v8 (the
    golden hashes did not move; only `FRACTURE_ALGO_VERSION` went 8 → 9).
  - **Splinters, not parallel cracks (capital, v10, 2026-11-15).** Two
    hostile film reviews (a heavy-beam slice and a railgun channel on a heavy
    cruiser) saw v9's zone cracks come out nearly straight, the full beam
    wide and PARALLEL to the cut either side, so one shot read as three cuts.
    Owner: "The main cut is dead straight. Splinter cracks stay jagged. The
    piece count follows the existing violence table." On a capital cut kill
    the zone, fan and far cracks are replaced by `cutSplinters` (own seeded
    stream `seed ^ 0x5b11e`):
    - **Count:** as many as the un-cut layout drew (zone + fan + far, after
      the profile's options), at most `SPLINTER_MAX` 4, so the count still
      follows the violence table (the sweep's mean piece count moved by
      under 0.1 against v9 on heavy cruiser, battleship and destroyer).
    - **First splinter on a side** (sides alternate, the first side seeded):
      starts ON the cut and runs into that side only (a local line whose
      region is that side), at a seeded 40–58° off the cut
      (`SPLINTER_SLOPE_*`, a slope, no trig), rooted so it meets the hull's
      edge 55–75 % of the cut's chord along the cut (`SPLINTER_REACH_*`): a
      big chunk breaks out of the cut's corner. It leans the other way if
      it would run within ~30° of the keel (`SPLINTER_KEEL_COS`; a
      quartering cut).
    - **Second on a side:** branches off the first 20–40 % of the way along
      it (`SPLINTER_BRANCH_*`), leaning back the other way, into what the
      first left; dropped if it would run down the keel.
    - **Guard:** the fan's chunky guard, with a least width of
      `SPLINTER_MIN_WIDTH_BEAMS` 0.3 beam, and no length check on a part that
      keeps at least half the section (a cut kill's end section is long by
      nature); the retry drops splinters last-first like fan cracks.
    - **Jag:** splinters jag at `SPLINTER_ROUGHNESS` 0.4 (`JAG_ROUGHNESS` is
      0.22; v9's cracks strayed ~7 % of their length, v10's ~12 %); a jag
      that breaks a piece is first redrawn at 0.22 and only straightened if
      that breaks it too.
    - A fracture without a cut, and a sub-capital's cut, is byte-identical to
      v9. Lock: `fractureHull.cutSplinters.test.ts` (every crack ≥ 25° off
      the cut, jagged, never spanning the cut's chord; mean count vs v9).
- **Wire.** `WreckDescriptor` / `WreckDescriptorSchema` / `isWreckDescriptor`
  gain optional `cutKind` ('slice' | 'channel'), `cutAng` (u16, 65536 per
  turn, hull 1× Pixi-up frame) and `cutW` (hull 1× units = world width ÷
  `shipShapeScale`). `WreckFractureInputs` carries the same three fields as
  they are, so the server and the client feed the fracture the same numbers;
  `wreckPieceGeometry` turns the angle into the direction with the shared
  `cutDirFromAngle`, which is arithmetic only (fixed Taylor series on a
  folded quarter turn, < 1e-13 off cos/sin), never trig. The server side gets
  the angle from a world direction with `hullLocalCutAngle(pose, dir)` (trig
  is fine there: only the integer reaches the fracture). The client store
  rebuilds a recycled id whose only change is the cut. The readers land
  before any server sends the fields (the welcome schema is strict).
- **Server death wiring.** `CapitalWreckSubsystem.onDeath` reads the last
  hit (`lastHit`: direction + `weaponId`); when that weapon has a `killCut`
  and the hit has a direction, it passes `cutKind`, `cutAng`
  (`hullLocalCutAngle(pose, dir)`) and, for a channel, `cutW` (world width ÷
  `shipShapeScale`) through `WreckBuildInput` into the fracture inputs, and
  the descriptor copies them (emit-when-present: an un-cut wreck's
  descriptor is unchanged). No direction (splash, ram) or no weapon ⇒ the
  normal break-up. Locks: `CapitalWreckSubsystem.test.ts` "killCut";
  `tests/integration/sectorRoom/capitalWrecks.test.ts` "killCut slice kill"
  (tests give the laser a `killCut` for the test and restore it).
- **The railgun** (plan step 7, 2026-11-14) is the first catalogue weapon
  with a `killCut`: `{ kind: 'channel', width: RAILGUN_BOLT_WIDTH }` (16 u, the
  slug's drawn bolt, ≥ 2 × its 5 u radius so it clears both halves). Its slug
  passes through what it kills at full damage and ignores wreck pieces
  ([shell-events](shell-events.md#railgun-pass-through-2026-11-14)). Lock:
  `tests/integration/sectorRoom/railgun.test.ts` (two capitals on one line:
  both cut with a channel of the bolt's width, the third stops the slug).
- **The heavy beam** (plan step 8, 2026-11-15) is the one catalogue weapon
  with `killCut: { kind: 'slice' }` (`HEAVY_BEAM_DEF`). It is a plain hitscan
  record fired through the one beam path (`fireNow` → hitscan sink →
  `laser_fired`), so its kill reaches the wreck through the same
  `applyDamage` weapon argument. Fighter and sub-cap beams (`hitscan`,
  `charge-laser`) have no `killCut` and break up normally. Lock:
  `capitalWrecks.test.ts` "a heavy_beam kill slices the wreck; a fighter beam
  or a bolt kill does not"; `WeaponCatalogue.test.ts` (only `heavy_beam`
  slices).
- **Instant split (no hold).** Owner: a cut kill splits at once. In
  `onDeath` a fracture with a `cutKind` skips the profile's crack hold
  (`holdMs`): the separating kick rides the spawn velocity (as a sub-cap's
  does), no pending kick, no rigid whole-wreck shove. No wire field: the
  client derives `WreckInfo.noHold` from the descriptor's `cutKind`, and
  `crackFrontAt` / `crackIgniteMs` take it, so every cut lights at once, no
  crack front runs and no ripples fire. The dying-hull hold
  (`dyingHullHold.ts`, `fx.dyingHoldMs`) is unchanged: it is marked on the
  death event, before the descriptor arrives, and is only the hand-over that
  keeps the hull drawn until every piece is drawable (it ends that frame),
  not a split delay. Locks: `CapitalWreckSubsystem.test.ts` and
  `wreckArt.test.ts` "a cut kill splits at once".
- **Cut glow colours (plan step 4, 2026-11-15).** `FracturePiece.cutEdges`
  (and `WreckPieceGeometry.cutEdges`) carry each edge's `EDGE_*` kind, not a
  boolean: `EDGE_HULL` (0) is falsy, so every "is it a cut" reader is
  unchanged and the goldens did not move (no version bump). `glowTintOf(kind,
  cutKind)` gives an `EDGE_CUT` edge of a slice kill `GLOW_TINT_SLICE` and
  of a channel kill `GLOW_TINT_CHANNEL`; every other edge (the jagged
  splinter cracks) keeps `GLOW_TINT_CRACK`, the molten curve, unchanged.
  Owner: the cut glows in the weapon's colour, cooling through ember to dark,
  and it is the hero line of the break-up (filmed review 2026-11-15: the
  slice read as a 1–2 px violet hairline beside white-yellow splinter cracks,
  with no violet left once the beam stopped). So a kill cut has its own
  curve in `wreckGlowAt` (`CUT_T/C/A`), never dimmer than a crack of the
  same age, ending dark at the same `WRECK_GLOW_END_S` (4.5 s):
  - **Slice:** the beam's pale core at the instant, then `HEAVY_BEAM_COLOR`
    violet at full alpha to `CUT_GLOW_HOLD_S` (1.5 s; a crack is at alpha
    ~0.65 and red by then), then burnt metal: a rose blush (0xe0507a at
    2.0 s, alpha 0.97), an orange ember (0xff6418 at 2.5 s, alpha 0.92)
    cooling to orange-red (0xd83c10 at 3.5 s, alpha 0.75), a brown scorch
    (0x5a362c at 4.0 s, alpha 0.3), dark at 4.5 s. It used to cool through a
    violet ember (0xa050e8 → 0x8834c8 → a violet-grey scorch); hostile film
    review 2026-11-15 (beam take 6): ~3.5 s after the kill the lips were
    still saturated violet, cooling straight to dark with no ember. The
    violet is the beam's light; once it is gone the metal glows as hot metal
    does, like the channel.
  - **Channel:** white-hot at full alpha to 1.5 s, then it cools like struck
    metal: yellow-white (2.0 s), an orange ember (0xff7a28, alpha 0.8 at
    2.8 s), a dull red-brown scorch (3.8 s, alpha 0.3), dark at 4.5 s.
  - **The ember is a stage of its own** (second film review 2026-11-15: the
    old ember, 0x7428a8 at 2.3 s falling to a 0.32-alpha grey-violet at
    3 s, read as dark ~2.3 s after the kill with no violet ember seen; it was
    the curve, not the clock: the glow ages on game time from first sight
    and its texture U is linear in age). On screen (alpha × brightest
    channel) the cut shows ≥ 0.45 at 2.3–3.0 s and ≥ 0.25 at 3.4 s, < 0.12
    at 4.3 s.
  - **Width:** a kill cut's core is `CUT_GLOW_WIDTH_MUL` (2.5) × a crack's;
    its halo reaches `CUT_HALO_CORE_MUL` (1.6) × its own core (a crack's: 3 ×;
    at 3 × the 2.5 × core it was a flat slab ~150 u deep on a heavy cruiser,
    filmed as four violet "bevels"), is brighter (0.45 × the core alpha, a
    crack's 0.3) and lasts with the ember (gone by 3.4 s; a crack's by 2.0 s).
  - **Chamfered ends:** a kill cut is ONE long straight edge whose two ends
    are hull corners or splinter junctions. A square strip end measured 0
    wide at an acute corner (`insideWidth`) and the strip narrowed to a
    sliver or to nothing: that was the first filmed hairline. A kill cut's
    strip ends are chamfered (`writeStrip` ratios), each end the SHORTEST
    chamfer that fits, from `CHAMFER_MIN` (1/32: all but square, for the
    ~90° hull corners of a side cut; a truly square end lies on the hull
    side and fails the inside test) doubling to `CHAMFER_MAX` (8, the 7–15°
    wedges a jagged splinter can leave). Always starting at 45° gave every
    end a long bevel, a triangle on a short edge: the "bevels". Each cut edge
    now glows along its full length (lit core ≥ a fifth of the cut core, or
    half of the piece's own thickness in a wedge, over ≥ 90 % of the drawn length of every
    `EDGE_CUT` edge of heavy-cruiser slice and channel kills). Crack strips
    keep their square ends.
  - **Incandescent, not painted** (hostile film reviews 2026-11-15, rail
    and beam take 7: the channel walls read as "flat pale-white blocky
    slabs ... like white paint or bricks, they do not glow", the slice's
    ember bars as "hard-edged flat strips with no soft glow"). Every quad
    used to sample one texel row, so each strip was a flat fill. A kill
    cut's strip now carries a gradient ACROSS its width in the same mesh:
    the texture has a block of `GLOW_ROW` rows per tint (`GLOW_ROWS_PER_TINT`
    = 6: bleed-out, bleed, edge, deep, halo, halo-out), its edge corners
    take one row and its outer corners the adjacent one, and the linear
    filter blends them. The core runs from the full curve alpha at the cut
    to `CUT_DEEP_A` (0.05 ×) inside, where it meets the halo with no hard
    line; the halo (0.45 × at the cut) fades to nothing at its outer side;
    a soft bleed (`CUT_BLEED_A` 1.2 × the halo share, `CUT_BLEED_CORE_MUL`
    0.35 × the core wide, chamfered) reaches into the gap (it uses the head
    halo's quad: a kill cut is no-hold, so it never has a head). While hot
    the colour shifts across it (`CUT_DEEP_C`, `CUT_DEEP_SHIFT` 0.65): the
    channel white-hot at the edge, yellow-orange deeper in; the slice a pale
    violet rim (`SLICE_RIM_WHITE` 0.3 toward white), deeper violet in. The
    shift is gone 0.5 s after the hold, so the ember is one hot-metal
    colour. The curve (`wreckGlowAt`) and its timing are unchanged. A
    crack's or splinter's strips keep flat rows: they look as before.
  - **On the hull as drawn.** A capital's collider `hull` is the convex
    hull of its parts, so between the side barbettes a piece's outline
    spans empty space where its art is transparent; a cut runs across it,
    and the glow strip drawn to the outline filmed as "white bars stuck
    onto the hull edge" (rail take 7). `wreckGlowStrip.ts` holds every
    glow strip to the piece's outline AND the kind's drawn parts
    (`shipParts`, the art's own source; `onDrawnHull`), and trims each cut
    edge to its longest drawn stretch (`drawnSpan`) before it is sized; a
    strip that does not fit narrows in 0.75 × steps. Polygon kinds (their
    outline is their drawing) are unchanged.
  - **Splinters read second** (owner 2026-11-15: keep the v10 splinter X,
    tone its glow down so the cut reads first; review: their orange rims were
    wider, brighter and longer than the cut). On a wreck with a `cutKind`,
    every non-`EDGE_CUT` crack is `GLOW_TINT_SPLINTER`: the crack colours at
    `SPLINTER_GLOW_ALPHA` (0.45) × the crack alpha on a short curve, dark by
    `SPLINTER_GLOW_END_S` (2.6 s), core and halo `SPLINTER_GLOW_WIDTH_MUL`
    (0.5) × a crack's (so 0.2 × the cut's core). A wreck without a cut keeps
    its cracks unchanged. Full (capital) glow only.
  - The simple (sub-capital) glow tints the same way, held to 50 % of its
    life and gone by 85 % (cracks: their own orange and red), at the same
    width multiplier; its cracks stay as they were on a cut kill too.
  Still ONE glow mesh per piece, no new draw call: the glow textures bake a
  row block per tint (`WRECK_GLOW_TEX_ROWS` = `GLOW_ROWS_PER_TINT` per tint;
  the simple texture one row per tint), a segment's tint and place across
  the strip are its V (`glowV(tint, row)` / `simpleGlowV`), and its width
  multipliers, chamfers and bleed are baked into its quads at build
  (`SEG_STRIDE` 22). Locks: `wreckArt.test.ts` "a kill cut
  glows in the weapon's colour" (violet / white-hot held ~1.5 s, never
  dimmer than a crack, the cut's core 2.5 × a crack's on real slice and
  channel pieces) and "a cut kill reads first" (splinters ≤ 0.5 × the cut's
  alpha at every age, ≤ 0.25 × its core, dark by 3 s; an un-cut wreck's
  cracks unchanged; every `EDGE_CUT` edge lit along ≥ 90 % of its drawn length; the ember
  visible at 3 s, dark at 4.5 s), "the cut glows like hot metal" (on real
  heavy-cruiser slice and channel pieces, the composited glow falls off
  from the cut edge inward, fades out at the halo's outer side, bleeds into
  the gap; channel white at the edge and yellow-orange in, slice violet)
  and "no glow strip lies outside its piece" (every glow triangle on the
  drawn hull, outside the piece only as the bleed off a cut edge);
  `swarmSpriteUpdater.wreckArt.test.ts`
  "char strip" (a cooled cut is a subtle scorch from 4 s, its halo gone by
  3.5 s);
  `fractureHull.test.ts` "cutEdges carries the edge kind".
- **Channel ash (plan step 4).** A fresh wreck with `cutKind: 'channel'`
  passes the channel line to the break-up sink (`WreckBreakSink`'s
  `channel`: from the kill point, the slug's entry, to `channelFarEnd`, the
  `EDGE_CUT` vertex farthest from it, where the slug left the hull; null for
  a slice or an un-cut kill). The renderer sends it as a `wreck-ash` burst to
  the same `WreckBreakFx` pool, whose `spawnChannelAsh` is a line emitter:
  glowing ash anywhere along the channel drifting off its walls (white-hot,
  ember, grey) and a few sparks flung on along the slug's path out of the
  far end. Tier counts `WRECK_ASH_DIAL` (high 48 + 16 … minimal 4 + 0), none
  with particles off; it plays only where the break-up plays (a capital
  profile's `breakBurst`, a fresh wreck). Lock: `WreckBreakFx.test.ts`
  "channel ash"; `wreckArt.test.ts` "a channel kill sheds ash".
- **Not yet:** channel ash on a sub-capital (its profile has no break-up
  burst, so only its glow tints). The beam fits that mount the heavy beam:
  [capital-ships](../features/capital-ships.md#weapon-fits-plan-section-9).
- Locks: `fractureHull.test.ts` "golden: v9 kill cuts" (battleship and
  fighter, side and bow, slice and channel); `fractureHull.killFocus.test.ts`
  "fracture v9" (the slice's cut is collinear with the shot through the kill
  point and covers the whole chord, side, quartering and bow shots; the
  channel leaves no vertex inside the strip and erases ≈ width × chord; the
  sliver slide); `fractureHull.subcap.test.ts` "sub-capital kill cuts";
  `wreckPieces.test.ts` "kill-cut direction";
  `tests/integration/wire/wreckGeometryParity.test.ts` (cut descriptors
  rebuild bit for bit); `wreckWire.test.ts`.

#### Far-zoom LOD for wreck pieces (2026-11-14)

With the break-up on, wide-view/high (GPU-lit) draw calls rose from 29–30 to
69–84 p95 against a budget of 32. At wide zoom ships drop to batched
far-zoom icons (`FarZoomIcons`), but each GPU-lit piece still drew one
`LitShipMesh` per hull tile, each its own draw call (custom shader), which
also broke the batch around its glow mesh.

- **When.** `wreckPieceFarLod(shipRadius, scale, was)` (`wreckArt.ts`) is the
  ships' own rule, `isIconOnly` on the PARENT hull's diameter
  (`2 · radius · zoom` < 8 px, back above 10 px). A wreck goes cheap at
  exactly the zoom its ship would have been an icon, and all its pieces
  switch together.
- **What.** `WreckPieceSprite.setFarZoom` (called by the swarm updater with
  the camera scale, before `update`) stops rendering the lit tiles
  (`renderable = false`, so the light pass skips them too) and shows one
  white-texture `Sprite` over the piece's bounding box, tinted the hull's
  piece colour (burnt for a capital). The speck, and its glow while a cut
  edge is still cooling, are attached to one `RenderLayer` (the renderer's
  `_wreckFarLayer`, between the ship container and the ship icons), so all
  specks draw as one batch. Left in place they sat between lit ships and
  rocks in the ship container and each gap opened a new batch: 30–36 draw
  calls p95 instead of 26–29. The piece is 1–4 px there, so the box reads as
  the same speck the lit piece was: no pop.
- **Scope.** GPU-lit pieces only: baked and plain pieces already batch.
  Capital wrecks (big hulls) keep their lit art at every gameplay zoom
  where the hull is above 8 px.
- **Cost.** The speck is built once, on first need; switching back and forth
  writes two flags per art part, only on a change. No per-frame allocation.
  `__eqxArtStats().wreckFarLod` counts pieces drawn as specks.
- **Measured** (`pnpm perf:counts`, desktop, SwiftShader 960×540, same
  session): see the PR; wide-view/high back within its 32 budget.
  fleet-fight/high is unchanged by this (zoom 0.45, ships are not icons
  there) and was over its 230 budget before the break-up.
- Lock: `swarmSpriteUpdater.wreckArt.test.ts` (the decision and its
  hysteresis; lit pieces at wide zoom draw no lit tile and one speck in the
  far layer, and come back at normal zoom with the layer empty).

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
  re-fractures it. *Lifted 2026-11-15 (salvage stream): the core child
  fracture and its wire contract exist (§S4 "Re-split", "Re-split on the
  wire"); server spawning follows.*
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

## Core rules reference

Moved from `src/core/CLAUDE.md` (section "Capital fracture").

- **`fractureHull({ hull, seed, killPoint, sectionCuts?, maxPieces })`** splits a hull outline into wreck pieces. Each piece has a CCW outline, `cutEdges` flags, convex parts, area and centroid. Server and clients run it from the same inputs (#15), and no geometry goes on the wire.
- **Deterministic by construction. Keep it that way:**
  - arithmetic and `Math.sqrt`/`round` only, never sin/cos/atan2/pow;
  - the mulberry32 `Rng`;
  - fixed loop order;
  - vertices quantised to `FRACTURE_QUANTUM` (1/64 u);
  - from poly-decomp, only `quickDecomp`/`makeCCW`.
- **Any change to its output bumps `FRACTURE_ALGO_VERSION`.** The golden test fails first.
- **Concave hulls go through `splitByLine`,** which traces each disjoint part separately. Plain Sutherland–Hodgman bridges them; the U-hull test catches that.
- **Jagged Voronoi cut edges** are seeded from the edge's own quantised endpoints, so both neighbours share the line. Section cuts and kill cuts (`EDGE_CUT`) stay straight.
- **Kill cuts (v9).** `FractureInput.cut` (`slice` | `channel`, a direction in the hull frame, a channel width) is optional and changes nothing when absent; v9 adds no seeded draw, and v10's capital splinters draw from their own stream. A cut's direction crosses the wire as a u16 angle and is decoded only by `cutDirFromAngle` (arithmetic, no trig) on both sides. Detail: "Kill cuts" above.
- **Wreck pieces collide with each other, and neighbours always part (owner review 2026-11-13: heavy, no overlap, no hinge).** `WRECK_COLLISION_GROUPS` (0x0004FFFF, server spawn and client twin) lets pieces bump. Their collider is `WreckPieceGeometry.colliderParts` (each part inset by `shipTuning(kind).wreckColliderInset`, so neighbours spawn a hair apart); drawing and weapon hits keep `parts`. `buildWreckPieces` gives each piece a slow kick (push `wreckPushMax/Min`, rim-speed spin) and then the least momentum-conserving pushes that open every shared cut (collinear cut edges, or cut edges that only touch at a T-junction) at `wreckSeparate` or more at both ends, spin included (#18 for all three). Tuned 2026-11-13 so the break is SEEN but heavy: `wreckSeparate` 0.014 × radius/s (~31 u/s heavy cruiser), push 0.010 / 0.004; the narrowest cut is ~31 u open 1 s after the kick, no piece over ~75 u/s (`wreckPiecesSeparate.test.ts`). The separation multiplies along chains of neighbours, so it assumes v7's few chunks. The kick is applied after `WRECK_CRACK_MS` (`shared-types/wreckTiming.ts`, game ticks; a cut kill: at once, "Kill cuts"); until then the pieces move with the dead hull. Never give pieces a velocity field that lets a neighbour close on another along their cut.
- **S2a: `wreckPieces.ts` / `wreckHits.ts`.** `buildWreckPieces` turns a death (kind, pose, kill point, damage inputs, seed) into rigid-body specs: the fracture on the 1× Pixi-up outline, pieces mapped like `shipShapeToPolygon` (x·s, −y·s, rings reversed to stay CCW), mass ∝ area, v + ω × r plus an outward push. `wreckRayHit` / `wreckSweepHit` are the one weapon-vs-wreck test (circle, then convex parts). The circle gate is `segmentNearCircle`, never `rayHitsSphere` (that returns null once the origin is inside the circle and past the centre, so shells passed through a long piece's far half; lock `wreckHits.test.ts`).
- **S2b: `wreckPieceGeometry(WreckFractureInputs)` is the one source of a piece's shape** (body-local parts, outline, cut flags, mass, radius). The server's `buildWreckPieces` places its output and the client rebuilds it from the `wrecks[]` descriptor; never compute a piece's shape another way (#15, locked bit for bit by `tests/integration/wire/wreckGeometryParity.test.ts`). `World.spawnObstacle` skips a part Rapier cannot hull (a < 1 u sliver threw inside the worker; `World.slivers.test.ts`).
- **Sub-capital profile (2026-11-13).** How a ship breaks up is `shipTuning(kind).destruction` / `destructionProfile({ type, kindId })` (`capital` | `subcap` | `none`), and every per-profile number lives in `DESTRUCTION_PROFILES` (`shared-types/shipScale/destruction.ts`), never in a branch. `wreckPieceGeometry` takes its fracture options from it; the sub-cap options (≤ 3 pieces, no fans or far crack, `chunkyPieces`: a sound primary + one extra chunk, gentle jag) must never change a capital's output: new `fractureHull` options default to the old behaviour. Lock: `fractureHull.subcap.test.ts`.

## History

Moved from `src/core/CLAUDE.md` (2026-11-14); kept for the record.

### fractureHull version trail (v2–v7)

- **v2: the last hit decides where it splits.**
  - A straight primary line runs through `killPoint`, across the keel, with a seeded tilt.
  - A seeded `snapChance` (default 0.2) snaps the hull cleanly in two along that line.
  - The piece count comes from `hullRadius`, `killBlowDamage` and `recentDamageRate` plus a seeded draw. Leave all three out to use the fixed-count mode, where the cap is the target.
  - `fracturePlan(input)` returns these decisions without building any geometry.
  - All of the plan's draws come from one stream, in a fixed order. Adding a draw changes every fracture, so bump the version.
- **v3: the kill point is on the hull outline** (owner: "Why isn't the red dot on the border of the ship?"). `projectToOutline(hull, p)` (nearest point on the edges, quantised) runs inside `fractureHull`/`fracturePlan`, so every caller gets an edge point (`fracturePlan(...).killPoint`).
- **v4: the primary line always runs ACROSS the hull** (owner review: a bow-tip hit split the ship along its keel). A bow or stern tip hit (a line through it would clip < 3 % of the hull) moves the line a seeded 15–35 % of the hull length aft of that tip, so that end breaks off as a real piece. Lock: the ±35°-of-square test over tips and every outline point.
- **v5: the shatter stays at the kill point and cuts run across a long hull** (hostile review of a filmed heavy-cruiser death). Seed density falls as 1/d⁴ over a 0.4 % floor; the Voronoi bisectors use a metric stretched 2× along the keel (`bisector`, still convex cells that tile); beyond one falloff radius seeds keep a least keel-wise spacing. Lock: `fractureHull.killFocus.test.ts`.
- **v6: cracks fan out from the kill point; the far field breaks along a few uneven, tilted cracks** (money-shot review: v5 cut a comb of even square bands and a ladder at the kill point). `crackLines` (its own seeded stream) adds fan cracks through the kill point and far cracks at seeded stations and tilts; the Voronoi seeds stay inside the fan (no far floor); cracks and the primary line are jagged, after `weldTJunctions` pairs T-junction edges. Lock: the v6 describe in `fractureHull.killFocus.test.ts` (far pieces, far tilt, radial cracks) on top of the v5 locks.
- **v7: the hull breaks only where it was hit, into a few ENORMOUS chunks** (owner review 2026-11-13: v6 sliced the far hull where no shell hit and cut a comb of slivers at the impact; "The last hit's impact sets the split"). No Voronoi seeds, no far cracks: two jagged zone cracks ~a beam either side of the primary and 0–2 fan cracks from the kill point (`LocalLine`, split only their zone half) leave 2–4 chunks at the impact and one big section each side. A very heavy blow (≥ max hull) on a long hull rarely (12 %) adds ONE far crack. Piece count still rises with size and violence, but stays ~3–7. A fan crack only splits a section where every part it leaves is chunky (≥ `FAN_MIN_WIDTH_BEAMS` 0.45 beam wide, ≤ `FAN_MAX_ASPECT` 2.6× longer than that; filmed take 2026-11-13: a long thin triangle along the port edge). Lock: the v7 describe in `fractureHull.killFocus.test.ts` (no thin sliver, no long thin piece of any size, no far cut, 2–5 near pieces, ≤ 2 sections each side).
- **v8: sub-capital pieces are never nearly the whole hull** (take 9 review 2026-11-14). The `soundMinShare` option (default 0.15); the sub-cap profile sets 0.43 (0.33 before take 10). Capital output unchanged. Lock: `wreckPieces.subcapParting.test.ts` "read as broken".
- **v10: a wide heavy-beam slice** (2026-11-15). A slice with a width erases a strip that wide like a channel; the heavy beam's is `HEAVY_BEAM_WIDTH` 60 u, its drawn core the same.
- **v10: splinters off a capital cut kill** (2026-11-15). The secondary cracks of a capital slice or channel kill branch off the cut at 40–58° and jag harder, instead of running parallel to it (film review: one shot read as three cuts). Count still from the violence table. Output without a cut unchanged. Lock: `fractureHull.cutSplinters.test.ts`, "golden: v9 kill cuts" (capital side-shot hashes).
- **v9: kill cuts** (2026-11-14). The optional `cut`: a heavy-beam `slice` is a dead-straight primary along the shot through the kill point (`EDGE_CUT`, never jagged; slid toward the centroid only off a sliver); a railgun `channel` erases a strip as wide as the bolt. Output without a cut unchanged (same golden hashes). Locks: "golden: v9 kill cuts", the "fracture v9" describe in `fractureHull.killFocus.test.ts`.
## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Capital wrecks (capital destruction S2a + S2b, 2026-11-12)

- **Switch `capitalWrecks`: ON by default since 2026-11-14** (owner: "land it switched on"). `wreckSwitchOn` (`rooms/wreckSwitch.ts`): env `EQX_CAPITAL_WRECKS=0|1` forces it for every room; otherwise room option `false` opts out. Both switches off ⇒ `SectorRoom.capitalWrecks` is null and nothing changes.
- **Hit tracking** is `CapitalWreckSubsystem.noteHit`, called from `applyDamage` before the router; pooled entries, no per-hit allocation (#14). Each entry keeps the last hit's point, direction (`dirX`, `dirY`, `hasDir`) and `weaponId` (null when unknown: ram, mine, structure turret); read it with `lastHit(id)`. Pass the hit point, direction and weapon wherever a path knows them: player beams (`PlayerFireResolver`), NPC beams (`AiFireResolver`) and projectiles (`ProjectilePipeline`, splash with no direction) all do, as plain `applyDamage` args; there is no side channel. The NPC beam's `DamageEvent` therefore reports its true impact point, like a player beam's. The death reads them for a weapon's kill cut ("Kill cuts" above).
- **`applyDamage` returns true iff that call destroyed the target** (`DamageRouter.apply` threads `out.destroyed` back; nothing recomputes it). Lock: `capitalWrecks.test.ts` "applyDamage returns true only on the call…".
- **Death hooks** (all before the dying body is despawned): drone capitals in `spawnScrapFromDrone`, active hulls in the `SHIP_DESTROYED` handler (which also despawns the dead body, slot kept), lingering hulls via the `spawnScrapFromLingeringHull` seam. Abandon is not a death: no wreck. **The dying body's DESPAWN is posted BEFORE the first piece spawn** (`onDeath(…, despawnDyingBody)`, all three hooks pass the body's slot and id): the worker handles each command as its own message and may step between two of them, so a despawn posted after the spawns left the pieces inside the old hull for a step and the push-out shoved them (2026-11-14, `subcapWrecks.test.ts` "never touch their own dying hull"). Never post a dying body's despawn after its pieces.
- **Wreck pieces are swarm kind 4** (`isWreckPiece`): immune, solid, block every weapon (`core/destruction/wreckHits.ts`). A new weapon or hit path must handle kind 4 (or the shot passes through a wall the server simulates). Persistence still skips them (S2c).
- **Heavy break-up (owner review 2026-11-13).** Pieces spawn with the dead hull's rigid motion and hold together for `WRECK_CRACK_MS` (`shared-types/wreckTiming.ts`, counted in server ticks so it follows the sector's speed); `CapitalWreckSubsystem.tick()` (every `update()`, alloc-free) then posts each live piece's slow separating kick as `WRECK_KICK`, turned by how far the piece has turned since the death. Pieces collide with each other (inset colliders); the kick guarantees every pair of neighbours parts along its shared cut. Story: capital-destruction.md "Bodies (heavy break-up)".
- **Overkill knock-back (owner request 2026-11-13).** A shot landing on a piece shoves it: `applyDamage(…, hitX, hitY, dirX, dirY)` → `CapitalWreckSubsystem.onWreckHit` → `WRECK_IMPULSE` at the hit point along the shot (so off-centre hits turn it). J = damage ÷ max hull × hull mass × `shipTuning(kind).wreckKnockSpeed`, speed change capped at `wreckKnockMax` (#18). Wired: `ProjectilePipeline` direct hits (shell velocity), `PlayerFireResolver` beams, NPC beams (`noteBeamImpact(x, y, dx, dy)`). A new weapon path that can hit a wreck should pass its direction too, or the piece won't move. Missiles push via their splash impulse already. No client path (#12: the predWorld twin re-anchors each snapshot). Alloc-free: reused command, scalar args. **During the crack hold** (`serverTick < deathTick + wreckCrackTicks()`, the rest of the salvo) the hit goes to the WHOLE wreck instead: `WRECK_RIGID_IMPULSE` with the wreck's piece ids (`LiveWreck.ids`, built once at death) → `World.applyRigidGroupImpulse` (Δv = J ÷ M, Δω = (r × J) ÷ I, every piece v_com + ω × r_i), so the hull never bends before it splits; cap `wreckKnockMax` × wreck mass. The kick at the end of the hold adds to that motion. Locks: `tests/integration/sectorRoom/wreckOverkillKnockback.test.ts`, `wreckRigidHold.test.ts`.
- **S2b — on the wire.** Kind 4 rides the binary swarm wire (v5, `wreckId` u16 at +34). Each wreck has one `WreckDescriptor` (fracture inputs) in `CapitalWreckSubsystem.descriptors()`. **Slice 3 (wire at volume):** the full set rides the WELCOME (`wreckWelcomeFields`); snapshots carry only deltas from `WreckWireDeltas` (stepped once per broadcast, diffs only when `version` moves): `wreckAdds` / `wreckRemoves` for `WRECK_DELTA_WINDOW` (18) counters = 6 snapshots per recipient (an id is never in both), plus `wreckSync` (`WRECK_RESYNC_CHUNK` descriptors, "ids in [lo, hi) are exactly these") on one snapshot per recipient in `WRECK_RESYNC_EVERY` (2 Hz), walking the id space so a missed add or remove converges (#16). Bytes stay flat as wrecks accumulate (~4 KB/s per recipient at 3 deaths/s, any live count). Never put the whole list back on the snapshot. Any path that removes a wreck piece must reach `pieceGone` (`evictSwarmEntity` does), or its descriptor outlives it. Never put vertices on the wire: the client rebuilds them with `wreckPieceGeometry` (#15). The 768-piece cap stays until S2c. Locks: `SnapshotBroadcaster.wreckDeltas.test.ts`, `tests/unit/wreckWireConvergence.test.ts`, `wreckLateJoiner.test.ts`.
- **Sub-capital wrecks (sub-cap break-up slice 2, 2026-11-13).** Switch `subcapWrecks` (room option / `EQX_SUBCAP_WRECKS=0|1`), ON by default since 2026-11-14, same rule as `capitalWrecks`. The SAME subsystem (`CapitalWreckSubsystem`, alias `WreckSubsystem`; name and the room's `capitalWrecks` field kept so the descriptor-transport slice merges) exists when either flag is on; `SectorRoom.wreckKindAllowed(kind)` says which kinds break, from `shipTuning(kind).destruction`: `capital` needs `capitalWrecks`, `subcap` needs `subcapWrecks` and a polygon kind (composite havok keeps its scrap), `none` never. Every difference comes from `DESTRUCTION_PROFILES`, never a branch: `holdMs` 0 ⇒ the separating kick rides the spawn velocity (no pending kick, no rigid hold, so knock-back shoves single pieces at once); `pushScale`; `wreckBodyParams(kind)` (core, shared with the client twin, #15) gives the damping (`dampingScale` ×10: a fighter killed at full speed sleeps in ~15 game s) and the collision groups (`SUBCAP_WRECK_COLLISION_GROUPS`: sub-cap pieces ignore each other but block ships and shots). Pieces are permanent; their own FIFO (`MAX_LIVE_SUBCAP_WRECK_PIECES` 2000) never evicts a capital piece (768). Same death hooks (drone, active hull, lingering hull; abandon is still not a death), same `wrecks[]` descriptors, welcome `subcapWrecks: true`. Lock: `tests/integration/sectorRoom/subcapWrecks.test.ts` (2-3 pieces from a real shot, sleep within 20 game s for fighter / frigate / robot, cap, flag off, havok scrap). Seams: `_internals.swarmSleeping` / `wreckCounts` / `setSubcapWreckCap`.
- **Settled bodies are cheap in the worker.** A body asleep since before this tick and already flagged `FLAG_SLEEPING` (and not a pilot-input slot) is in the worker's `quietIds`: `getAllShipStates(quietIds)` skips its Rapier reads and allocation, and its SAB record (the resting pose) is left as is. Anything that moves a body must wake it (every `World` mutation passes `wakeUp = true`); a woken body is written again on the next tick.
- **Test trigger:** testMode `test_kill_capitals` (every capital NPC takes a lethal hit, re-hit through a shield); room `wreck-test`.

### Server rules in full (moved from src/server/CLAUDE.md)

The zone `CLAUDE.md` keeps a condensed form of these rules; this is the full wording with its lock tests.

#### Capital wrecks

- **Break-up ON by default** (`capitalWrecks` / `subcapWrecks`, owner 2026-11-14): a room opts out with `false`, env `EQX_*_WRECKS=0` forces it off (`wreckSwitchOn`); one death effect per ship (a breaking kind never sheds scrap). Hit tracking is pooled (#14). Test trigger: `test_kill_capitals`, room `wreck-test`.
- **Wreck pieces (kind 4) block every weapon but the railgun slug and a heavy-beam kill follow-through (`isDebris`):** a new weapon or hit path must handle kind 4 and pass its shot direction (knock-back). Locks: `wreckOverkillKnockback.test.ts`, `wreckRigidHold.test.ts`.
- **Snapshots carry wreck deltas only:** never the whole list, never vertices; every piece removal reaches `pieceGone`. Locks: `SnapshotBroadcaster.wreckDeltas.test.ts`, `wreckWireConvergence.test.ts`, `wreckLateJoiner.test.ts`.
- Detail: [capital-destruction.md](../../docs/architecture/capital-destruction.md#server-implementation-notes).

## Core rules reference

Moved from `src/core/CLAUDE.md` (section "Capital fracture").

- **`fractureHull({ hull, seed, killPoint, sectionCuts?, maxPieces })`** splits a hull outline into wreck pieces. Each piece has a CCW outline, `cutEdges` flags, convex parts, area and centroid. Server and clients run it from the same inputs (#15), and no geometry goes on the wire.
- **Deterministic by construction. Keep it that way:**
  - arithmetic and `Math.sqrt`/`round` only, never sin/cos/atan2/pow;
  - the mulberry32 `Rng`;
  - fixed loop order;
  - vertices quantised to `FRACTURE_QUANTUM` (1/64 u);
  - from poly-decomp, only `quickDecomp`/`makeCCW`.
- **Any change to its output bumps `FRACTURE_ALGO_VERSION`.** The golden test fails first.
- **Concave hulls go through `splitByLine`,** which traces each disjoint part separately. Plain Sutherland–Hodgman bridges them; the U-hull test catches that.
- **Jagged Voronoi cut edges** are seeded from the edge's own quantised endpoints, so both neighbours share the line. Section cuts and kill cuts (`EDGE_CUT`) stay straight.
- **Kill cuts (v9).** `FractureInput.cut` (`slice` | `channel`, a direction in the hull frame, a channel width) is optional and changes nothing when absent; v9 adds no seeded draw, and v10's capital splinters draw from their own stream. A cut's direction crosses the wire as a u16 angle and is decoded only by `cutDirFromAngle` (arithmetic, no trig) on both sides. Detail: "Kill cuts" above.
- **Wreck pieces collide with each other, and neighbours always part (owner review 2026-11-13: heavy, no overlap, no hinge).** `WRECK_COLLISION_GROUPS` (0x0004FFFF, server spawn and client twin) lets pieces bump. Their collider is `WreckPieceGeometry.colliderParts` (each part inset by `shipTuning(kind).wreckColliderInset`, so neighbours spawn a hair apart); drawing and weapon hits keep `parts`. `buildWreckPieces` gives each piece a slow kick (push `wreckPushMax/Min`, rim-speed spin) and then the least momentum-conserving pushes that open every shared cut (collinear cut edges, or cut edges that only touch at a T-junction) at `wreckSeparate` or more at both ends, spin included (#18 for all three). Tuned 2026-11-13 so the break is SEEN but heavy: `wreckSeparate` 0.014 × radius/s (~31 u/s heavy cruiser), push 0.010 / 0.004; the narrowest cut is ~31 u open 1 s after the kick, no piece over ~75 u/s (`wreckPiecesSeparate.test.ts`). The separation multiplies along chains of neighbours, so it assumes v7's few chunks. The kick is applied after `WRECK_CRACK_MS` (`shared-types/wreckTiming.ts`, game ticks); until then the pieces move with the dead hull. Never give pieces a velocity field that lets a neighbour close on another along their cut.
- **S2a: `wreckPieces.ts` / `wreckHits.ts`.** `buildWreckPieces` turns a death (kind, pose, kill point, damage inputs, seed) into rigid-body specs: the fracture on the 1× Pixi-up outline, pieces mapped like `shipShapeToPolygon` (x·s, −y·s, rings reversed to stay CCW), mass ∝ area, v + ω × r plus an outward push. `wreckRayHit` / `wreckSweepHit` are the one weapon-vs-wreck test (circle, then convex parts). The circle gate is `segmentNearCircle`, never `rayHitsSphere` (that returns null once the origin is inside the circle and past the centre, so shells passed through a long piece's far half; lock `wreckHits.test.ts`).
- **S2b: `wreckPieceGeometry(WreckFractureInputs)` is the one source of a piece's shape** (body-local parts, outline, cut flags, mass, radius). The server's `buildWreckPieces` places its output and the client rebuilds it from the `wrecks[]` descriptor; never compute a piece's shape another way (#15, locked bit for bit by `tests/integration/wire/wreckGeometryParity.test.ts`). `World.spawnObstacle` skips a part Rapier cannot hull (a < 1 u sliver threw inside the worker; `World.slivers.test.ts`).
- **Sub-capital profile (2026-11-13).** How a ship breaks up is `shipTuning(kind).destruction` / `destructionProfile({ type, kindId })` (`capital` | `subcap` | `none`), and every per-profile number lives in `DESTRUCTION_PROFILES` (`shared-types/shipScale/destruction.ts`), never in a branch. `wreckPieceGeometry` takes its fracture options from it; the sub-cap options (≤ 3 pieces, no fans or far crack, `chunkyPieces`: a sound primary + one extra chunk, gentle jag) must never change a capital's output: new `fractureHull` options default to the old behaviour. Lock: `fractureHull.subcap.test.ts`.

## History

Moved from `src/core/CLAUDE.md` (2026-11-14); kept for the record.

### fractureHull version trail (v2–v7)

- **v2: the last hit decides where it splits.**
  - A straight primary line runs through `killPoint`, across the keel, with a seeded tilt.
  - A seeded `snapChance` (default 0.2) snaps the hull cleanly in two along that line.
  - The piece count comes from `hullRadius`, `killBlowDamage` and `recentDamageRate` plus a seeded draw. Leave all three out to use the fixed-count mode, where the cap is the target.
  - `fracturePlan(input)` returns these decisions without building any geometry.
  - All of the plan's draws come from one stream, in a fixed order. Adding a draw changes every fracture, so bump the version.
- **v3: the kill point is on the hull outline** (owner: "Why isn't the red dot on the border of the ship?"). `projectToOutline(hull, p)` (nearest point on the edges, quantised) runs inside `fractureHull`/`fracturePlan`, so every caller gets an edge point (`fracturePlan(...).killPoint`).
- **v4: the primary line always runs ACROSS the hull** (owner review: a bow-tip hit split the ship along its keel). A bow or stern tip hit (a line through it would clip < 3 % of the hull) moves the line a seeded 15–35 % of the hull length aft of that tip, so that end breaks off as a real piece. Lock: the ±35°-of-square test over tips and every outline point.
- **v5: the shatter stays at the kill point and cuts run across a long hull** (hostile review of a filmed heavy-cruiser death). Seed density falls as 1/d⁴ over a 0.4 % floor; the Voronoi bisectors use a metric stretched 2× along the keel (`bisector`, still convex cells that tile); beyond one falloff radius seeds keep a least keel-wise spacing. Lock: `fractureHull.killFocus.test.ts`.
- **v6: cracks fan out from the kill point; the far field breaks along a few uneven, tilted cracks** (money-shot review: v5 cut a comb of even square bands and a ladder at the kill point). `crackLines` (its own seeded stream) adds fan cracks through the kill point and far cracks at seeded stations and tilts; the Voronoi seeds stay inside the fan (no far floor); cracks and the primary line are jagged, after `weldTJunctions` pairs T-junction edges. Lock: the v6 describe in `fractureHull.killFocus.test.ts` (far pieces, far tilt, radial cracks) on top of the v5 locks.
- **v7: the hull breaks only where it was hit, into a few ENORMOUS chunks** (owner review 2026-11-13: v6 sliced the far hull where no shell hit and cut a comb of slivers at the impact; "The last hit's impact sets the split"). No Voronoi seeds, no far cracks: two jagged zone cracks ~a beam either side of the primary and 0–2 fan cracks from the kill point (`LocalLine`, split only their zone half) leave 2–4 chunks at the impact and one big section each side. A very heavy blow (≥ max hull) on a long hull rarely (12 %) adds ONE far crack. Piece count still rises with size and violence, but stays ~3–7. A fan crack only splits a section where every part it leaves is chunky (≥ `FAN_MIN_WIDTH_BEAMS` 0.45 beam wide, ≤ `FAN_MAX_ASPECT` 2.6× longer than that; filmed take 2026-11-13: a long thin triangle along the port edge). Lock: the v7 describe in `fractureHull.killFocus.test.ts` (no thin sliver, no long thin piece of any size, no far cut, 2–5 near pieces, ≤ 2 sections each side).
