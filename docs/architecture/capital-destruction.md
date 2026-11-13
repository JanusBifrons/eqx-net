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
    later shells (a follow-up) supplies the violence.
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
  - Locks: `tests/integration/sectorRoom/wreckPiecesSeparate.test.ts` (no
    overlap, neighbours never approach, crack delay holds, slow speed and
    spin, a shoved piece bumps its neighbour), `wreckPieces.test.ts` (every
    seam opens at both ends), `CapitalWreckSubsystem.test.ts` (crack delay).
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
    (`snapshotCoalesce.test.ts`). The DataChannel path coalesces raw bytes
    and still has this gap (follow-up).
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
  the wreck lives. This is invariant #16: a late joiner rebuilds the geometry
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
  (0.165 × the wreck radius: the side blasts; the main fireball and its
  secondaries reach 0.14) for ~1.5 s. Paced evenly over distance, the front
  spent about half its run under them: the take showed the first crack
  ~0.8 s after the kill and the rest "spanning the hull in ~0.1 s". The
  front now crosses the covered stretch (`crackHidden`) in
  `WRECK_FRONT_HIDDEN_SHARE` (20 %) of its time and spends the rest outside
  it (≥ 0.65 s visible on the filmed heavy cruiser, was ~0.5 s). The
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
  kill blast is 0.12). A late joiner gets none; one whose moment passed
  before its piece was drawn is dropped. `artStats().wreckRipples` counts
  them.
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
  0.8–1 s with ≥ 0.65 s outside the kill blast and a head running, both
  sides of a crack together, 3+ ripples outside the blast in sequence, glow
  under 0.6 alpha by 3 s, no glow outside its piece, pieces never fade).
- **The "thin sliver that faded" (v7 take, 2026-11-13) was no piece.** Two
  bright lines ~40–50 u apart with a dark streaky strip between them, gone
  by ~4 s: one crack opening at ~31 u/s after the hold, with each piece's
  glow centred on its edge, so both halos and cores spilled over the gap
  and read as a strip that "faded" with the glow. v7 never cuts two
  near-parallel cracks closer than ~0.56 beams (`fractureHull.killFocus.test.ts`
  "no two cracks run near-parallel"), and every piece keeps its art. Fixed
  by drawing each piece's glow on its own side only (above).

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
