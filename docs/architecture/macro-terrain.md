# Macro terrain: asteroid fields, wreck fields, nebulae (design, 2026-11-15)

<!-- showcase-exempt: Stage 0 harness only; the terrain-stress shot lands in slice 0d -->

Status: **Stage 0 (stress harness) in progress; slice 1a (shape seed) done.** Plan approved by the owner on 2026-11-15; the plan file is `tender-humming-whisper.md` in the plans folder.

## Why

The game has no macro terrain. A sector holds a few small rock layouts, nebulae are scenery only, and AI pilots fly straight lines that ignore rocks, walls and wrecks. The owner wants:

- **Asteroid fields** spanning hundreds of km, with giant blockers and hundreds of thousands of small rocks. Each field has capital lanes, an open core, pockets, and rich mining outposts.
- **Old-battle wreck fields.**
- **Nebulae** spanning several sectors, which slow target locks.
- **One route-finder** for AI pilots and the player autopilot.

Look and feel, and performance, are the guiding stars. Measurements set the limits, never numbers invented in advance.

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

Pending: slice 0c fills this in from desktop and `--device phone-proxy` runs.

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
