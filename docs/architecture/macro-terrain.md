# Macro terrain: asteroid fields, wreck fields, nebulae (design, 2026-11-15)

<!-- showcase-exempt: Stage 0 harness only; the terrain-stress shot lands in slice 0d -->

Status: **plan v2 (the cut field) approved 2026-11-15; slices 0a, 1a, A1 and A2 done.** The plan file is `tender-humming-whisper.md` in the plans folder.

## Why

The game has no macro terrain. A sector holds a few small rock layouts, nebulae are scenery only, and AI pilots fly straight lines that ignore rocks, walls and wrecks. The owner wants:

- **Asteroid fields** spanning hundreds of km, with giant blockers and hundreds of thousands of small rocks. Each field has capital lanes, an open core, pockets, and rich mining outposts.
- **Old-battle wreck fields.**
- **Nebulae** spanning several sectors, which slow target locks.
- **One route-finder** for AI pilots and the player autopilot.

Look and feel, and performance, are the guiding stars. Measurements set the limits, never numbers invented in advance.

## The cut field (plan v2)

After look tests with the owner (2026-11-15), a field is no longer thousands of placed rocks: evenly scattered rocks "read like a pattern". A field is **one giant convex shape cut up like a cake** (a fracture), in `src/core/terrain/fieldLayout.ts` (`slicedField`):

1. **Lanes first.** One or two straight strips run end to end. Their walls are the first cuts, and the strip is removed, so lanes have clean walls.
2. **Recursive cuts.** Each piece is cut across its longest dimension, at a seeded point 35–65 % along it, with a little angle jitter. That avoids slivers.
3. **Where cutting stops.** A piece stops when it is rock-sized (4–20 fighter lengths, seeded), or rarely at 1–2 battleship lengths (the rare big rocks).
4. **Streets.** Each piece shrinks toward its centre, leaving streets about two fighter widths wide at the core. Streets widen toward the rim, where pieces also drop out, giving a slow thinning from core to edge.
5. **The core.** The middle is a hole.
6. **Shape.** Edges are roughened by midpoint displacement, then one smooth two-scale warp bends every outline. Neighbours bend together, so streets curve.

**Look and size.** The field is about 300 km across, which is never fully on screen at any zoom. The full field is 113,881 rocks; cutting it all in one go takes about 8 s.

**Determinism and laziness.**
- Every cut is seeded by the piece's path in the cut tree. A child's path mixes the parent's path with the depth and the side (`childPath`), so paths never collide.
- Any region can be cut on its own: pieces outside a view box stop early. The box is padded by the warp amplitude (`cutFieldPad`), so a rock whose final outline reaches into the view is never dropped.
- The code is arithmetic only (no sin/cos/atan2/pow/hypot or `**`), with `FIELD_LAYOUT_VERSION`, so every browser cuts the server's rocks. Saved rock records are keyed by that version.
- Locks: `fieldLayout.test.ts` (same seed gives same rocks; unique paths; a sub-area cut equals the same rocks in a full cut, none missing) and `tests/unit/fieldLayoutArithmeticOnly.test.ts`.

### Chunks and rock keys (A2)

The field is split into a fixed grid of square chunks (`CHUNK_SIZE` = 4096 u, about 4 km).

- **Membership.** A rock belongs to the chunk holding its **pre-warp centre**, half-open, so every rock has exactly one chunk.
- **The key.** A rock's key is `(chunk x, chunk y, index)`, packed into one u32 (8 + 8 + 16 bits; `rockKey`, `unpackRockKey`). The index is the rock's rank by cut path within its chunk, so a rock has the same name whether one chunk or the whole field is cut, in any order.
- **Cutting one chunk.** `rocksInChunk(field, cx, cy)` cuts one chunk at full detail. It is generation-time code: the client runs it off the frame and the server on wake.
- **Measured on the full field** (seed `look`): 114,628 rocks in 3,924 chunks; a median of 21 rocks per chunk, p99 90, max 99.
- **Rule.** Changing `CHUNK_SIZE` renames every rock, so it bumps `FIELD_LAYOUT_VERSION`.
- **Locks** (`fieldLayout.test.ts`):
  - every rock of a full cut lands in exactly one chunk, and chunk cuts equal the full cut;
  - keys are unique and unpack to their chunk and index;
  - cutting a neighbour first changes nothing;
  - negative chunk coordinates pack correctly.

### In the game (behind the `cutField` room option)

Only test and showcase rooms set `cutField: { seed }`; live sectors never do until the owner has seen a fly-through.

- **Shared streamer.** `CutFieldStreamer` (`core/terrain/chunkStreamer.ts`) loads the chunks near each ship and unloads them after a linger; the server and the client both run it, so both hold the same rocks (#15). Field rocks never ride the wire; the welcome carries only the seed (#16).
- **Server:** loaded rocks are Rapier FIXED bodies (`World.fixBody`, the worker's `staticBody: 'fixed'`), not locked dynamic ones; the wire and saves skip them. Cut pieces touch along their cuts, and as locked dynamic bodies the solver worked every rock–rock contact while they were awake (see Measurements). The streamer cuts at most 2 chunks per 250 ms step on the room's main thread.
- **Chunk cuts** (`rocksInChunk`) pass `own` = the chunk, so pieces that can't hold a member rock are dropped before they are cut or finished; same rocks as cutting the padded view and filtering.
- **Client:** `net/CutFieldClient.ts` loads one chunk per 125 ms (7 × 7 chunks, ~28 km). The cutting runs in the page's art bake pool (`ArtService` `pageBakeRunner().cutChunk`, `bake.worker.ts`), at most 2 cuts out at once and ahead of queued bakes; the streamer's `cutChunk` hook returns null until a cut lands, and loads it on the next step. Without workers the pool cuts inline. On a phone the renderer shares that main thread, so a cut there dropped frames (see Measurements). The client adds predWorld bodies only near the ship, and hands chunk outlines to the renderer through `RenderMirror.pendingFieldChunks` → `render/field/CutFieldLayer.ts` (flat-coloured rocks).
- **Spectating** streams around the own parked hull (spectate moves it to `lingeringShips`).
- **Test room** `showcase-cut-field` (seed `look`); shots in `showcase/shots/cutField.ts`. Lane poses come from `slicedFieldLanes`.

**Follow-ups:**
- A free-flying spectator camera doesn't bring rocks with it: the camera pose lives in the renderer, and feeding it back means a new `RendererFeedback` field (phase-gate review).
- Concave outlines use one convex hull on both sides; poly-decomp later.
- The client draws only the loaded 7 × 7 chunks, so far zoom shows a square edge; a far-zoom view of the whole field is open.
- Collision E2E: `tests/e2e/cut-field-collision.spec.ts` (room `cut-field-test`) rams a field rock: the server logs `field:` contacts and the rendered ship stays outside the rock's collider.
- Still to measure: a valid (quiet-host) desktop run; the phone GPU's draw cost (phone-proxy throttles the CPU only).
- Server chunk cuts still run on the room's main thread (~4 ms each, 2 per step at most); move them to a worker if a busy sector shows tick spikes.

Next (plan v2 stages A3–F): owner shape tuning, cross-browser parity, chunk meshes with the procedural rock shader, then wake/deep sleep, the wire and the terrain store.

## The core idea

A rock that nobody has touched is not data. Server and client recompute it from its field's seed with shared, arithmetic-only code. Only changes become records: a moved, mined or destroyed rock, or a battle wreck piece.

Every rock and wreck piece sits at one of three sleep levels in the same swarm registry:

- **Awake:** body plus slot.
- **Asleep:** body plus slot, `FLAG_SLEEPING`.
- **Deep asleep:** no body, no slot, just its saved record. A rock nobody has touched has no record at all.

## Stage 0: the stress harness

Before any feature, three perf scenes measure what a rock field costs today. They run only when named (`soak: true`), for example `pnpm perf:scenes --scenes rock-field-1k,rock-field-4500`.

| Scene | What it is |
|---|---|
| `rock-field-1k` | 1,000 still rocks in a 9 km disc, pilot idle in the middle |
| `rock-field-4500` | 4,500 still rocks in a 19 km disc (same density), near the 5,120-slot cap |
| `rock-field-fight` | a reinforced 10-a-side fight inside 4,000 still rocks (rocks woken by hits) |

**How the field is built:** the bulk seed (`SwarmSpawner.seed`) with:

- `swarmRatio: 1`: rocks only;
- `swarmAtRest: true`: no drift, and the real asteroid mass, so the rocks settle into physics sleep.

The density is one rock per ~250,000 u² (about 500 u apart).

**What gets measured,** each against body count and the asleep share: server tick, worker step, wire KB/s per client, client frame p95/p99, draw calls, heap, and slots used.

`tests/integration/sectorRoom/rockFieldScenes.test.ts` checks that a scene builds exactly the rocks it names and that they all fall asleep. The asleep-vs-awake comparison is only valid if they do.

### Measurements

Pending: slice 0c fills in the rock-field scenes from desktop and `--device phone-proxy` runs.

**Cut field (2026-11-15, desktop, Ryzen 7 9800X3D; host busy, so the runner marked the runs INVALID: compare, don't quote as budgets).**

| What | Before | After |
|---|---|---|
| Perf scene `cut-field` (941 field rocks loaded, pilot idle): physics worker step p95 | ~20 ms | ~1.0 ms |
| Same: server tick p95 / sim ticks behind | 0.76 ms / 15 of 1,249 | 0.58 ms / 0 of 1,235 |
| Same: client frame p95 / render p95 | 16.8 / 0.2 ms | 16.8 / 0.3 ms |
| Physics step, 941 rocks, isolated: while awake | ~12 ms for the first 120 ticks after a load (locked dynamic) | 0.1–0.2 ms from tick 1 (fixed) |
| Physics step, 941 rocks, isolated: asleep | 0.09 ms | 0.09 ms |
| `rocksInChunk`, 169 chunks around lane 1 (avg 55 rocks, max 99) | p50 10.8 / p95 13.9 ms | p50 3.8 / p95 6.1 ms |

**Phone-proxy, 6× CPU, flying down lane 1 (`cut-field-run`), busy host:** idle 0–6 hitches/min; flying 14–20 hitches/min (frame p99 33 ms) with the chunk cut on the main thread, and still 12–33 with it in the bake pool. So the cut is not the main per-chunk cost on a phone: the drawing of a new chunk or its predWorld bodies is the next suspect (unmeasured).

Server tick, client frame and render barely notice an idle field; the cost was the physics worker solving touching locked bodies, and the chunk cut finishing rocks outside its chunk.

## Stage 1: deep sleep

### 1a: a rock's shape comes from its stable id

A rock must keep its outline when it leaves the world and comes back (deep sleep), so its shape cannot depend on its wire id, which is reused.

- **Seed:** each rock's shape seed is `asteroidShapeSeed(rec.id)`, a u16 hash of its stable registry id. It is computed once at spawn (`SwarmSpawner`) and kept on the record as `rec.shapeSeed`.
- **Wire:** the seed rides the swarm wire in the u16 at +34 (`SWARM_REC_SHAPE_SEED_OFF`), the same bytes a wreck piece uses for its `wreckId` and that a rock left empty. Because the meaning of those bytes changed for rocks, `SWARM_WIRE_VERSION` went 5 → 6: an old client would have drawn the wrong outlines.
- **Client:** the decoder keeps the seed on the mirror entry, and the prediction collider, the sprite and the baked art all build from it. `FORGE_VERSION` bumped, so rock art re-bakes.
- **Determinism:** `generateAsteroidVertices` uses arithmetic only.
  - Directions come from `unitDirFromSteps` (`core/geometry/unitDir.ts`). This is the Taylor-series helper the capital fracture already used, moved there so there is one copy.
  - `Math.sin`/`Math.cos` are not bit-exact across JS engines. Field rocks will be derived on the client, so every browser must produce the server's vertices.
- **Decoder fix:** an asteroid record now clears a stale `asteroidResource` when a plain rock reuses a wire id.
- **Locks:**
  - `SwarmSpawner.test.ts`: an outline survives a different wire id.
  - `tests/unit/swarmWireRoundTrip.test.ts`: the seed round-trips, and a reused id keeps no old seed or resource.
  - `unitDir.test.ts`: within 1e-12 of cos/sin at every step.

## History

- 2026-11-15: plan approved; slice 0a adds the terrain stress scenes and the `swarmAtRest` bulk-seed option. The first desktop timing run was invalid throughout (other sessions kept the host at 30–100 % CPU); timings wait for a quiet host.
- 2026-11-15: slice 1a, rock shapes seeded by the stable id, swarm wire v6.
- 2026-11-15: look tests with the owner replaced placed rocks with the cut field (plan v2); slice A1 lands the generator, A2 the chunks and rock keys.
