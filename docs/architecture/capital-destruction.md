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
  it (≥ 0.72 s visible on the filmed heavy cruiser, was ~0.5 s). The
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
  them: `pushScale` 30, `separateScale` 40, `dampingScale` 10. The push runs
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

Behind the `subcapWrecks` room option (`EQX_SUBCAP_WRECKS=1`), off by
default. There is still one wreck system: the capitals' subsystem
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
