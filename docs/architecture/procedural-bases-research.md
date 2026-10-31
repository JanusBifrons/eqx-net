# Procedural bases — research and chosen methods

> Plan: `soft-leaping-truffle`, Phase 1. This document fixes the method for each
> archetype and the runtime technique **before** generator code. Budgets live in
> [`src/shared-types/baseBudgets.ts`](../../src/shared-types/baseBudgets.ts);
> the measurements behind them are in
> [`procedural-bases.md`](procedural-bases.md). Every choice here must fit
> those budgets. Where a choice is unmeasured, it says what will measure it.

## 1. Constraints the method must satisfy

| Constraint | Source | Consequence for generation |
|---|---|---|
| Same layout on server worker, client predWorld and render worker | Invariant #15 | The generator is pure `src/core`, seeded, integer-unit. Send **seed + version**, never geometry. |
| ≤ 4000 pieces per base, ≤ 8000 per sector | bench (trimesh per chunk) | Generators emit **merged** rectangles, not tiles. Detail is visual-only. |
| Static geometry = one trimesh per 1024 u chunk | bench: per-piece colliders ~10× dearer | Pieces are bucketed by chunk; a destroy rebuilds one chunk. |
| Every corridor clears the largest flyable ship | `baseBudgets.test.ts` | A validator checks clearance; failing layouts are re-seeded. |
| Every region reachable from a gate | design | Flood-fill validator on a coarse grid. |
| No tunnelling | soft CCD (#175) | Walls can be thin (≥ 16 u visual floor). |
| Roaming squads don't avoid obstacles yet | `FORMATION_DEST_RANGE` ring | Galaxy bases ≤ 3200 u until PR-N (obstacle-aware roaming). |

## 2. Networked determinism

A shared seed with per-generator RNG streams is the standard way to keep
procedural content identical across clients without sending it
([seeds and determinism](https://abratabia.com/procedural-generation/seeds-and-determinism.php);
[multiplayer-safe random generation](https://uefncentral.com/cs/blog/how-to-build-multiplayer-safe-random-generation-in)).
Seeding at the wrong moment, or sharing one global RNG, is the classic desync.
Floating-point differences across platforms are the other frequent bug source.

**Chosen rules:**

1. **One RNG per sub-generator.** `rng.ts` promotes the repo's `mulberry32`
   (`src/core/swarm/asteroidShape.ts`) and FNV-1a (`livingworld/population.ts`)
   into one module. Every sub-generator gets its own stream, derived from
   `hash(seed, streamName)`, so adding a step never shifts another step's
   numbers.
2. **Integer units, no trig.** All coordinates and sizes are integers. Rotations
   are multiples of 90° only. Non-axis shapes (octagonal bastions, ring
   segments) use **precomputed integer vertex tables**, never `Math.sin`/`cos`
   at generation time: trig results can differ in the last bit between JS engines.
3. **Stable ordering.** Use stable sorts with explicit tie-breaks on integer
   keys. Never iterate a `Map` built from an unordered source.
4. **Version lock.** A `BASE_GENERATOR_VERSION` constant is part of the
   descriptor. A test hashes the generator's output for a fixed seed set, so
   any change to output must bump the version. This mirrors the append-only
   catalogue rule (Invariant #11).
5. **Generate, then curate.** Validators reject a layout, and the generator
   re-seeds deterministically (`seed' = hash(seed, attempt)`) up to a fixed cap.
   This is the standard "detect the dead end and restart" safeguard
   ([procedural generation guidance](https://skills.sh/thedivergentai/gd-agentic-skills/procedural-generation)).

## 3. Layout methods by archetype

### 3.1 Warehouse — aisle carving on a block grid

A 2024 warehouse-layout framework models the floor as a discrete grid with
masks for walls and doors. It starts with everything as storage and carves
aisles by sliding horizontal and vertical aisle templates. Layouts that break
efficiency rules are filtered out: overly wide aisles, single-item block
stores, and two-sided access with fewer than two rows
([Shahroudnejad et al., Frontiers in AI 2024](https://frontiersin.org/articles/10.3389/frai.2024.1465186/full)).

**Chosen:** the same idea, made deterministic and cheap. No beam search is
needed, since we want variety, not optimal storage density.

1. Footprint rectangle, divided into a perimeter wall with 2–4 gates.
2. Zones are split by seeded main cross-aisles (≥ 2× corridor width).
3. In each zone, rack rows run along the zone's long axis, with
   corridor-width aisles between them and secondary cross-aisles at a seeded
   pitch.
4. Loading bays (open rectangles) attach at the gates; container stacks fill
   bay edges.
5. **Greedy rectangle merge**: consecutive rack segments in a row merge into
   one long rectangle. The visual keeps segment detail, but physics sees one
   piece. This is what makes "endless rows" fit 4000 pieces.

### 3.2 City — street network → blocks → lots → buildings

The literature's main options:

- **L-system road growth.** Parish & Müller 2001 is the classic. Lots are
  subdivided by repeatedly splitting the largest lot through the middle of its
  longer side until it falls below a threshold, then discarding lots without
  road access ([Parish–Müller overview](https://phiresky.github.io/procedural-cities/presentation.html)).
- **Tensor-field streets.** Chen et al. 2008 steer street tracing with an
  editable tensor field ([Interactive Procedural Street Modeling](https://www.sci.utah.edu/~chengu/street_sig08/street_project.htm)).
- **Categorized subdivision.** This gives lots that are not all the same size
  ([generative urban design](https://arxiv.org/pdf/2212.06783)).

**Chosen: grid-blend streets + categorized recursive subdivision.**

- **Why not full tensor-field tracing.** It is the most organic option, but it
  needs floating-point streamline integration (a determinism risk) and gives no
  structural guarantee of corridor width.
- **Streets.** Instead we blend 2–3 seeded street *directions*: a main grid
  angle, a 90° cross grid, and an optional radial ring set around a plaza. We
  lay **avenues** (≥ 3× corridor width, the fly-through spines) and
  **streets** (≥ 1× corridor width) on an integer lattice.
- **Blocks and lots.** Blocks are subdivided Parish–Müller style with
  categorized size classes. Lots without frontage are dropped (they become
  courtyards, i.e. negative space).
- **Buildings.** Each lot's footprint is inset by a seeded margin. Building
  class follows lot size and distance to the plaza: towers near the centre,
  habitat blocks mid-ring, low industrial at the edge. One **landmark** (spire
  or dome) sits per plaza.

### 3.3 Military — rings, bastions, coverage-placed turrets, roadmap patrols

**Turret siting** is an art-gallery / set-cover problem. McGill's guard and
camera placement work starts from Fisk's minimal polygon cover (triangulate,
then 3-colour the vertices) and treats placement as set cover
([Xu et al., generative guard placement](https://www.sable.mcgill.ca/~clump/papers/xu-14-generative.pdf)).
Practical base-building AIs score tower sites by coverage, and use flood fill
to check that areas are sealed
([Screeps automatic base building](https://wiki.screepspl.us/Automatic_base_building)).

**Patrol routes** come from a roadmap built over the free space; specific
patrol behaviours are then layered onto it (same McGill line of work).

**Chosen:**

1. **Concentric rings.** An outer ring wall with bastions (integer octagon
   tables) and 2–4 gated approaches, an inner keep ring, and hangars and
   landing pads between them.
2. **Turret sites by greedy set cover.** Sample approach points along each gate
   corridor and the ring gaps. Candidate sites are the bastion tips and keep
   corners. Each site covers the sample points within weapon range with clear
   line of sight (a segment test against the coarse occupancy grid). Greedily
   pick sites until coverage ≥ the target or the Tier B budget is used up.
   This costs O(sites × samples) once, at generation time. It is deterministic
   and capped by `MAX_TIER_B_PER_BASE`.
3. **Shield generators** cover the gate approaches (reusing pylon-wall spans
   across gates) plus the new area-shield kind (PR-M).
4. **Patrols.** The roadmap is the centre-lines of the ring corridors. Each
   patrol wing gets a closed polyline loop, which is fed to a polyline
   `ScriptedPathBehaviour` (server-only).
5. **A hostile-DPS lock per approach**: a reference ship must survive N seconds
   at the gate, so the defence stays playable rather than a death wall.

### 3.4 Considered and not chosen (for v1)

- **Wave Function Collapse / model synthesis.** Excellent for tile-level
  variety, and used for modular ship interiors
  ([procedural spaceships with WFC](https://bodenmchalewebsite.pages.dev/blog/procedural-spaceships.html)).
  But it needs contradiction detection and backtracking or restarts, its
  runtime is less predictable, and it tends to emit many small tiles. That
  works against the piece budget. It is a candidate later for *visual-only*
  interior detail inside a chunk.
- **Graph grammars for station modules.** These are general
  ([Merrell, example-based graph grammars](https://katalog.lib.cas.cz/KNAV/EdsRecord/edsarx,edsarx.2309.00275)).
  A simpler "core module, then expand connections" scheme (as in
  [StarMade's station generator discussion](https://starmadedock.net/threads/procedurally-generated-modular-stations.1969/))
  covers what we need for hangar clusters inside the military archetype.

## 4. Runtime technique

### 4.1 Physics

- **One trimesh collider per 1024 u chunk, from merged rectangles.** This is
  measured (see `procedural-bases.md`). Each piece also keeps its own
  triangle-index range, so a destroyed piece rebuilds just its chunk's mesh.
- **Ghost collisions at internal seams.** A body sliding across seams between
  adjacent static pieces can snag on internal edges
  ([Godot-Rapier docs](https://godot.rapier.rs/docs/documentation/rigidbodies)).
  Rapier ≥ 0.19 has an opt-in `TriMeshFlags.FIX_INTERNAL_EDGES` for this; its
  2D examples use it
  ([Rapier v0.19](https://git.nea.moe/github/rapier.git/commit/?h=v0.19.0),
  [rapier#625](https://github.com/dimforge/rapier/pull/625)). It is present in
  our installed `rapier2d-compat`.
  - **Chosen:** greedy rectangle merging (fewer seams in the first place) plus
    `FIX_INTERNAL_EDGES`.
  - **New lock (PR-V):** a ship sliding along a long merged rack row, and
    along a row of unmerged neighbours, must keep its speed (no snag).
- **`lengthUnit`.** Rapier's tolerances scale with
  `IntegrationParameters.lengthUnit` (PR #625 adds it for pixel-scale 2D). This
  repo runs at ~1 u ≈ 1 px with the default unit. Changing it is a global
  physics change and is **out of scope**. The vertical slice measures snagging
  and contact quality at the default unit first.
- **CCD.** Soft CCD (#175) is already on for every dynamic body.

### 4.2 Weapon hits

The server has no live Rapier world on its main thread; every fire path is an
analytic loop. Base pieces therefore get a **coarse uniform cell grid**:
cell = 128 u, one `Uint16Array` of piece ids per cell, built once per chunk.
`rayFirstPiece` / `segmentBlocked` walk it with a DDA traversal. That is
allocation-free, with an op-count lock (cells and pieces visited per worst-case
ray), and it is wired next to the existing shield-wall hooks in all six fire
paths.

### 4.3 Rendering (Pixi v8)

- **Retained `Graphics` per chunk, culled by camera bounds.** Pixi v8 culling
  is opt-in (`CullerPlugin`); culling per chunk rather than per sprite is far
  cheaper ([Pixi v8 culling](https://dev.to/fur-gaming/optimizing-rendering-with-pixijs-v8-a-deep-dive-into-the-new-culling-api-e52)).
  We toggle `visible` ourselves from the camera bounds (one pass over ≤ 64
  chunk rects), which works identically in the worker.
- **No `cacheAsTexture` for chunks.** It flattens a container to a texture
  and is meant for static content, with a GPU size limit around 4096²
  ([Pixi cache-as-texture](https://pixijs.com/8.x/guides/advanced/cache-as-texture)).
  - **Memory.** A 1024 u chunk at our max zoom of 3 is 3072² px × 4 B ≈ 36 MB
    per chunk.
  - **Blur.** At lower texture resolution it blurs when zoomed in.
  - **Verdict.** Retained vector geometry is both smaller and sharp.
- **LOD.** Below `BASE_LOD_ZOOM` (0.4) one silhouette `Graphics` per base
  replaces the chunks, so the 8k-wide establishing shot costs one object.
- **Redraws.** A chunk is redrawn only when its destroy mask changes.

### 4.4 Memory

- **Layout storage.** Flat typed arrays of ~20 B per piece (budget: ≤ 128 KB
  per base). There are no per-piece objects on either side.
- **Client geometry.** The client predWorld holds only the chunks within
  `PREDWORLD_ACTIVE_RADIUS` (budget: ≤ 2000 pieces).

## 5. Making it beautiful (and readable)

- **Readability first.** Top-down readability comes from distinctive
  silhouettes, which ships and vehicles have by nature
  ([Cryptark's 2D sci-fi visual design](https://gamedeveloper.com/design/game-design-deep-dive-visualizing-i-cryptark-s-i-2d-sci-fi-world)).
  So each archetype gets its own **silhouette grammar**:
  - warehouses read as long parallel bars;
  - cities read as varied blocks around bright plazas;
  - fortresses read as rings and pointed bastions.
- **Lighting without gradients.** Cryptark paints lighting in two tones with no
  gradients (same source). Endless Sky recommends a key light, a dim fill and a
  rim light to accent the silhouette
  ([Endless Sky sprite design](https://endless-sky.github.io/2016/09/08/designing-ship-sprites.html)).
  - **Chosen:** each piece is drawn as a base fill, a lit edge (top/left) and a
    shadow edge (bottom/right). That is three flat tones, a cheap retained
    vector.
- **Functional greebles only.** Starsector's developer argues that greebles
  without purpose cheapen a design
  ([The Trouble With Greebles](https://fractalsoftworks.com/tag/greebling)).
  - **Chosen:** detail marks function: rack slots, hangar mouths, landing-pad
    markings, window rows on habitats, conduits along walls.
- **Weathering.** Clean looks fake (Endless Sky). A deterministic hash per piece
  picks small tone variations and grime patches, which also breaks tiling
  repetition, a known problem for procedural levels (Cryptark).
- **Light points.** Nav lights, window glints and gate beacons are tiny circles
  whose alpha pulses on a shared clock (one alpha update per chunk per frame,
  no allocation). They make a dark base read as alive at a distance.
- **Negative space.** Plazas, courtyards, cross-aisles and the ring gap between
  walls are deliberate. They are both the fly-through space and what makes the
  silhouette legible.
- **Palette.** One palette per faction/archetype, drawn from the existing
  render palette; the military palette has the hostile accent.

## 6. Decisions → budgets → locks

| Decision | Budget it protects | Lock |
|---|---|---|
| Merged rectangles + trimesh per chunk | step/replay overhead, piece count | generator sweep counts + bench |
| `FIX_INTERNAL_EDGES` + merging | contact quality (no snag) | slide-along-row physics test (PR-V) |
| Integer + 90°/table geometry, per-stream RNG | Invariant #15 | layout-hash version lock + server/client collider-hash parity |
| Coarse cell grid for weapon hits | server tick | op-count + heap-delta + bench |
| Retained per-chunk Graphics + LOD, no texture cache | frame p99, memory | visible-chunk count + heap slope (perf arm) |
| Greedy set-cover turrets ≤ Tier B budget | entity pool, slice bytes | Tier B count + hostile-DPS-per-approach lock |
| Validators (clearance, reachability) | playability | generator sweep: 100% pass after ≤ N re-seeds |
