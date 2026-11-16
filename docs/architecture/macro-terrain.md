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
- **Client:** `net/CutFieldClient.ts` loads one chunk per 125 ms (7 × 7 chunks, ~28 km). The cutting runs in the page's art bake pool (`ArtService` `pageBakeRunner().cutChunk`, `bake.worker.ts`), at most 2 cuts out at once and ahead of queued bakes; the streamer's `cutChunk` hook returns null until a cut lands, and loads it on the next step. Without workers the pool cuts inline. The worker also packs the chunk (`core/terrain/packedChunk.ts`: keys, draw outlines, ore per vertex, and each rock's `fieldRockBody` in float64) and transfers the buffers, so a landing cut costs the main thread no structured clone and no per-rock work; a rock's body is unpacked only when it gets a predWorld collider or wakes (`packedChunk.test.ts` locks it equal to the server's `fieldRockBody`, #15). On a phone the renderer shares that main thread, so a cut there dropped frames (see Measurements). The client adds predWorld bodies only near the ship, and hands chunk outlines to the renderer through `RenderMirror.pendingFieldChunks` → `render/field/CutFieldLayer.ts`: one Mesh per chunk, each rock a fan from its centre, drawn with the owner-approved procedural rock shader (`render/field/fieldRockShader.ts`, from `exp/terrain-look`: dome, fBm, craters, cracks, lit by the sector sun, detail cut at ~2 px from the camera zoom). No triangulation; the mesh is built once per chunk.
- **Waking (C2/C3).** A ship ramming a field rock wakes it: in the contact batch, `CutFieldSubsystem.onContact` posts `UNFIX_BODY` (`World.unfixBody`: Fixed → Dynamic, awake), at most `FIELD_WAKES_PER_TICK` (4) a tick. Anything else that must wake one (a mining laser about to cut it) calls `CutFieldSubsystem.wakeRock(id, by, tick)`: same cap, false when it is hit (retry next tick). A fixed rock never wakes a fixed neighbour (the cut pieces touch); an AWAKE rock driven into a fixed one at a closing speed of at least `FIELD_CHAIN_WAKE_SPEED` (20 u/s) wakes it (chain wake, `fieldRockWakes`), so a capital ploughs on instead of pinning its first woken rock against a still-fixed wall. Mass is `fieldRockMass(radius)` = a battleship's mass × (radius / battleship radius)², so a battleship-sized rock weighs a battleship. An awake rock rides the swarm wire (v7) as an asteroid with flag `SWARM_RECORD_FLAG_FIELD_ROCK` and its rock key in bytes 32–35 (chunk x, chunk y, index) instead of the resource byte and shape seed. The client asteroid leaf spawns its body from the cut outline (`CutFieldClient.wakeFieldRock`, which also drops the fixed body; a client without that chunk falls back to a generated rock), and the sprite updater draws it with the same shader as its own Mesh (`CutFieldLayer.buildRockSprite`) while its fan in the chunk mesh collapses onto its centre. A woken rock unseen on the wire for 2 s (client) / 120 frames (renderer) counts as asleep again (its server chunk unloaded and will re-cut it in place).
- **Spectating** streams around the own parked hull (spectate moves it to `lingeringShips`).
- **Test room** `showcase-cut-field` (seed `look`); shots in `showcase/shots/cutField.ts`. Lane poses come from `slicedFieldLanes`.

**Follow-ups:**
- A free-flying spectator camera doesn't bring rocks with it: the camera pose lives in the renderer, and feeding it back means a new `RendererFeedback` field (phase-gate review).
- **Colliders follow the dents (plan C1).** `fieldRockBody` splits a rock's outline into convex parts (`convexParts` in `geometry/shipHullDecomp.ts`, poly-decomp), and both sides build the body from them through `World.spawnObstacle`'s existing multi-part path (the one gates and wreck pieces use). Before splitting, the outline is smoothed: bumps and dents shallower than `FIELD_COLLIDER_SIMPLIFY` (6 %) × the radius of a circle with the rock's area go. Without that a rough rock splits into about 25 parts; with it about 4.5 (at most 9), area within 4.8 % (644 rocks, two seeds). A rock whose outline crosses itself (about 10 %, a cut-shape bug still to fix) keeps one convex hull. The client splits in the bake worker (`packChunk` packs `partStarts` / `parts`), so a phone's main thread never runs poly-decomp; the server splits during its chunk cut. Weapons hit the same parts (C1b): the server sets the rock record's `wreckParts`, and every swarm hit site (player beam, projectiles, missiles, NPC/turret beams) tests `wreckParts` before the kind checks through `wreckRayHit` / `wreckSweepHit`; wreck-only rules (railgun slug, heavy-beam follow-through) still test `isWreckPiece`. The client's drawn beam already ends on the predWorld body, which is built from the same parts. Lock: `tests/integration/sectorRoom/cutFieldRockHits.test.ts` (a beam from inside a dent crosses it before hitting rock). Locks: `shipHullDecomp.test.ts` (convexParts), `packedChunk.test.ts` (parts and the dent spot), `tests/e2e/cut-field-collision.spec.ts` (a ship parked in a dent is not shoved out; the ram never goes deeper into an outline than the smoothing).
- The client draws only the loaded 7 × 7 chunks, so far zoom shows a square edge; a far-zoom view of the whole field is open.
- Collision E2E: `tests/e2e/cut-field-collision.spec.ts` (room `cut-field-test`) rams a field rock: the server logs `field:` contacts and `field_rock_woke`, the woken rock reaches the client (`cutFieldStats.awake`), and the rendered ship stays outside the rock's collider.
- Chain wake: `tests/integration/sectorRoom/cutFieldRam.test.ts` drives a battleship into a lane wall and waits for a rock woken by another rock.
- A woken rock stays tied to the chunk it was cut in: it unloads with that chunk wherever it drifted, and comes back at its cut pose when the chunk reloads (keeping a moved rock's pose in the terrain store is still to come; C4 saves only ore left and broken-up rocks).
- The chunk mesh uses 32-bit indices (WebGL2 or `OES_element_index_uint`); gate it if an old phone lacks both.
- Weapons don't damage field rocks (they only block shots), so only a ram wakes one.
- Still to measure: a valid (quiet-host) desktop run; the phone GPU's draw cost (phone-proxy throttles the CPU only).
- Server chunk cuts still run on the room's main thread (~4 ms each, 2 per step at most); move them to a worker if a busy sector shows tick spikes.

Next (plan v2 stages A3–F): owner shape tuning, cross-browser parity, deep sleep, and the terrain store (moved rocks persist).

### Ore (F1)

Ore is a map over space, not a label on a rock (owner): the piece a mining laser cuts off yields what lay where that piece sat. `core/terrain/fieldOre.ts` gives the ice and crystal concentration (0..1 each, 0 = plain rock) at any rest-frame point.

- **Loot table** (`ORE_TABLE`):
  - The field is cut into `ORE_CELL` cells (8192 u), and each cell rolls its own hotspots from `(seed, cell)`.
  - Small ice and crystal **pockets** (a few hundred u to about 1400 u) can turn up in any cell.
  - Huge, rich **lodes** (2400–6000 u, peak 0.8–1) roll at full chance inside `ORE_CORE_SHARE` (0.35) of the field radius. The chance falls to none at `ORE_RIM_SHARE` (0.75).
  - Measured on seed `look`: within 0.2 R, about 25 % of points hold ice and 12 % crystal. Past 0.7 R, 2 % hold ice and under 1 % crystal.
- **Falloff:** `hotspotConc` is a smoothstep from the peak at the centre to 0 at the edge. The edge is roughened by `vnoise` (±`ORE_EDGE_DEPTH`). Where hotspots of one resource overlap, the strongest wins. No hotspot reaches past the 3×3 cells `oreAt` reads (tested).
- **Rest frame:** ore is fixed to the rock, so a shoved or split rock carries it. Callers map a world point back through the rock's pose. Cut-field rocks spawn at angle 0.
- **Deterministic and cheap:**
  - Arithmetic only, seeded from `ore:<seed>`, a separate stream from the cuts.
  - `ORE_VERSION` bumps on any change.
  - `oreAt` allocates nothing, because the mining laser samples it on every hit (#14).
  - Nothing rides the wire: a joiner rebuilds the map from the welcome seed (#16).
- **Yield:** `oreRow(conc)` (`shared-types/asteroidResources.ts`) turns concentrations into a yield row: ice and crystal take their share of every 10 units mined, minerals the rest. Every extractor splits mined units by ONE function, `yieldInto(row, drawn, out)` (the grid Miner, robot harvesters via `OreDraw.mine`, the mining laser); a scattered rock's row is `ASTEROID_YIELD[kind]`. The Miner reads a rock's row through the `asteroidYieldOf` hook.
- **By hit point (F1b):** a mining-laser hit on a field rock samples the ore where it landed. `OreDraw.onHit` gets the hit point, and `CutFieldSubsystem.oreAtHit` maps it into the rock's rest frame (`toRestFrame`, from the record's `restX/restY` and its live SAB pose once it is awake) and calls `oreAt`. The ore owed per shooter per rock keeps the unit-weighted mean concentration; the 1 Hz pulse pays it through `mine(…, oreRow(mean))`. The pool stays size-based. Lock: `tests/integration/sectorRoom/cutFieldOreYield.test.ts` (a rich spot pays ore, a plain spot minerals).
- **Change record (C4, saved across restarts):** `CutFieldSubsystem` keeps, by rock key, only rocks somebody changed. `minedPool` holds what is left in a mined rock when its chunk unloads, and the re-cut spawns it with that pool, so flying away and back never refills a rock. `markConsumed(key)` / `isConsumed(key)` mark a rock that was broken up (salvage rock cut; its pieces are live wrecks), and the streamer's spawn refuses it from then on.
  - **The save:** each change is one `TERRAIN_RECORD_PUT` on the CRITICAL lane, an absolute upsert into the `terrain_records` table keyed on (field key, rock key), where the field key is `<sectorKey>|<seed>` so a sector re-seeded with another field never reads the old field's records with the `FIELD_LAYOUT_VERSION` it was cut under, the pool left (NULL for none) and the consumed flag. It is written on `markConsumed` and when a mined rock's chunk unloads with a pool different from the one recorded, never per tick. SQL lives in `src/server/db/terrainSql.ts`, shared by the DB worker and `SyncSinkAdapter`.
  - **The load:** once, when the subsystem starts, through the main thread's read-only connection (`terrainRecordStoreFor(sectorKey)` in `PersistenceWorker.ts`, handed in as the `records` hook). Loaded consumed keys go straight into the consumed set, so the welcome's `cutField.consumed` carries them to every joiner. Rows cut under another `FIELD_LAYOUT_VERSION` name other rocks: they are ignored with one warning (count) and overwritten if the same key is written again. A failed SELECT loads nothing and warns.
  - **Who saves:** only a room with a sector key that persists its sector (`persistSector`, the same gate as the sector snapshot). Engineering rooms and test rooms with `persistSector: false` pass no `records` hook and keep the record in memory only.
  - **One store:** field rocks are never in the sector snapshot's `swarm[]` (`SectorPersistence.persist()` skips `rec.fieldRock`), so rock state lives only here.
  - Locks: `CutFieldSubsystem.test.ts` (writes, a restart from a save, stale layout rows), `src/server/db/terrainSql.test.ts` (upsert round trip), `dbWorker.integration.test.ts` (the worker's statement), `tests/integration/sectorRoom/cutFieldConsumed.test.ts` (a galaxy room enqueues the write; an engineering room does not).
- **Placement sees unloaded rocks (C5):** structure placement refuses a footprint on a field rock whose chunk is not loaded, as if the rock were there. `StructurePlacementSubsystem.place` passes the footprint box to the room's `getObstacles(near)` hook; with `near` the room adds `CutFieldSubsystem.dormantObstacles(box, out)`, which cuts the rocks reaching that box from the layout (`fieldRocksInBox`: `slicedField` with the box as its view, so a big rock owned by a far chunk is found, then `rocksInChunk` of each found rock's chunk for its key) and pushes each one that is neither consumed nor live in the registry (a live rock is already there, at its current pose) as its bounding circle (`fieldRockCircle`, the same x, y, radius `fieldRockBody` gives the live body) plus its real shape. **Real shape, not the circle (C5b):** a cut-field rock is big and irregular (radius up to ~8.9 km), so the circle alone refused footprints kilometres from its outline. A `GridObstacle` may carry `parts` (convex polygons relative to its centre) and an `angle`; `placementRejection` uses the circle as the broad phase and then refuses only a footprint box that overlaps a part (separating-axis box vs convex polygon; touching is legal, no extra margin, as for the circle). Dormant rocks carry the parts their collider would have (`fieldRockBody(rock).parts`, at rest, angle 0; parts null ⇒ the outline's convex hull, as Rapier builds it). Live rocks (`SectorRoom.gatherStructureObstacles`) carry `rec.wreckParts` (the field rock's collider parts) else `rec.vertices` (an ordinary asteroid's convex outline; a field rock with no parts gives its raw outline, which the separating-axis test treats as at least its convex hull) at the live SAB pose, so a woken, turned rock is tested where it is. Line of sight still uses the circle's box. Measured about 1–3 ms a call on a desktop (printed by `chunkStreamer.test.ts`), so no chunk cache. Generated bases place through the same `place`, so they skip slots on dormant rocks too; no cut-field room seeds bases today, and `seedNpcBases` runs before the `CutFieldSubsystem` exists in `onCreate`, so one that did would not see dormant rocks yet. Not covered yet: connector line of sight (auto-connect still sees live rocks only); the client ghost runs no obstacle check of its own. Locks: `chunkStreamer.test.ts`, `CutFieldSubsystem.test.ts` (dormantObstacles), `placementRules.test.ts` (convex parts), `tests/integration/sectorRoom/cutFieldPlacement.test.ts`, `structurePlacementValidation.test.ts` (live rock outline).
- **Consumed keys on the wire (C3):** the consumed set only grows, and breaks are rare, so it is not a snapshot delta. The welcome carries the whole set (`cutField.consumed`, capped at `MAX_WELCOME_CONSUMED_ROCKS`), and each new break sends one reliable `field_consumed {k}` to the room (`FieldConsumedSchema`). Both travel in order on the same socket, so welcome + messages = the set (#16). A reconnect's welcome replaces it, even with the same seed. The client (`CutFieldClient`) gives a consumed rock no body. In the draw, it flattens the rock's fan onto its centre (`collapsePackedRock`) instead of leaving it out: `CutFieldLayer` finds a rock by its index in the chunk, so the count and order must not change. A break in a loaded chunk re-sends that chunk's outlines once. Locks: `CutFieldClient.test.ts` (consumed rocks), `packedChunk.test.ts`, `tests/integration/sectorRoom/cutFieldConsumed.test.ts`.
- **Look (F1c):** the rock surface shows the ore where the map has it. `oreForOutlines` samples `[ice, crystal]` at every fan vertex when a chunk loads (client, main thread); it rides `pendingFieldChunks[].ore` into the `aOre` attribute, and `fieldRockShader` draws it by style: `?ore=off|tint|veins|seams` (veins by default, the owner's pick; `?ore=off` shows bare rock; shot `cut-field-ore`). A woken rock keeps its own vertices' ore.

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

**Found (2026-11-16, CPU profiles of `cut-field-run`, phone-proxy 6×, load gate off, so compare only):** the hitches are the start-up fill (13 in the first 6 s, ~0 once the 7 × 7 ring is loaded), and the main-thread cost was the cut result landing, not the cut: the structured clone of a `ChunkRock[]` (thousands of `{x, y}` objects; 98 ms of the long frames), `oreForOutlines` + `fieldRockBody` per chunk, and `syncPred`'s `Math.hypot` over every loaded rock each step (38 ms). The worker now packs and transfers the chunk (`packedChunk.ts`) and bodies unpack lazily:

| `cut-field-run`, phone-proxy 6× | Before | After |
|---|---|---|
| Hitches in the first 6 s | 13 | 1 |
| Main-thread busy runs over 12 ms / worst | 103 / 136 ms | 46 / 52 ms |
| Cut-field code inside those runs | ~220 ms | ~6 ms |

What is left in the long frames is garbage collection and the general frame loop. Profile with `--cpu-profile <file> --cpu-profile-ms 15000` (the scene is ~28 s and sampling starts at the first sample).

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
- 2026-11-15: slice 1a, rock shapes seeded by the stable id, swarm wire v6. Chain wake: a woken rock driven into a fixed one wakes it.
- 2026-11-15: field rocks drawn with the procedural rock shader; a rammed field rock wakes and rides the swarm wire with its rock key (wire v7).
- 2026-11-15: look tests with the owner replaced placed rocks with the cut field (plan v2); slice A1 lands the generator, A2 the chunks and rock keys.
