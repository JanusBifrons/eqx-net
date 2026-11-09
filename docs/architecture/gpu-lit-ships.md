# GPU-lit art

Before this, every ship was baked 16 times (capitals 4), fully lit, once per sun angle, and the sprite cross-faded between the two nearest frames. GPU-lit art keeps the **unlit inputs** of that light pass instead and lets the GPU light them every frame.

## Levels (Settings → Graphics → Lighting)

| Level | What | Default for |
|---|---|---|
| High | The night side: long sharp shadows on ships (real length on structures), fill light, 8 point lights, engines as lights, capital shadows and bounce | desktop |
| Medium | High with 48 shadow steps and 4 point lights | phones |
| Low | 16 shadow steps, 4 point lights, no engine lights, fill or capital effects | phones reporting < 4 GB |
| Baked | Today's baked frames (the old look) | automated browsers (tests, netgate, showcase) |

Precedence: `?shiplight=gpu|high|medium|low|baked` > the saved level (per device, `eqxShipLight`) > the device default (`defaultLightingPreset`). A change applies on the next load. Automated browsers stay on Baked unless the URL asks, so tests are unchanged.

## Why

- **Memory.** One frame of three map slices replaces 16 lit frames: a fighter takes 0.19× of today's texels, a battleship about 0.75× of its 4 frames. In the battleship duel room the art atlas went from 205 MB (8 pages) to 133 MB (5 pages). Phones ran out of atlas pages in base-heavy sectors; this is the real fix.
- **Light.** Smooth sun at every angle, sharp cast shadows, and light from the world: engines, weapons fire, muzzle flashes, explosions, capitals shading ships beside them.
- **One bake for every sector.** The maps don't depend on the sun, so their cache key has no sun in it.

## How it fits together

| Piece | Where | What |
|---|---|---|
| Maps | `render/art/litMaps.ts` | Slice A: albedo + coverage. B: normal x/y, height, cavity. C: emission + material. Side by side, `LIT_GUTTER` (32) apart. |
| Bake | `render/art/bake.ts` | `BakeJob.lit` → one map frame (capitals tiled along rows) + `LitMeta`. Keys start with `L`; `bakeStore.storeKey` drops the sun. |
| Atlas | `render/art/atlas.ts` | **Data pages**: bytes copied as-is and uploaded without premultiplication (a canvas page wipes the colour of alpha-0 texels and destroys slices B and C). Ordinary and lit atlases share one `PageBudget`. |
| Shader | `render/art/litShipShader.ts` | The bake's light pass per pixel (mirrored line for line by `shadeLitTexel`, parity-tested), plus fill light, point lights and capital occluders, each compiled in only when switched on. |
| Pass | `render/art/litPass.ts` | Every lit mesh registers; once a frame (`PixiRenderer` ticker, before render) poses come from the world container, capitals become occluders, then each mesh takes the sun and its strongest lights. |
| Settings | `render/art/lightingSettings.ts` | Looks (`baked`, `f`, `real`, `night`, `all`) and per-feature switches; `?shiplight=gpu` resolves them once on the main thread (`artMode.ts`) and BOOT carries them to the render worker. |

Lit sprites: `MachinedShipSprite` (one mesh per capital tile), `MachinedFlatSprite` (structures, rocks), turret guns and AA barrels (`MountVisualManager.gunLayers`).

Lights come from the game's own effects: engine plumes (`FxEngines.thrustOf`), bolts and shells by calibre, missiles, beams, explosions (`PixiRenderer.feedLitScene`) and muzzle flashes pinned to each gun's flash sprite (`litPass.attachLight`).

## Rules learned building it

- **A box doesn't shade what is on top of it.** A capital's occluder skipped only its first tile, so the rest of the hull and every gun sat in their own capital's shadow (the battleship rendered black).
- **Light where the effect is drawn, not where the data first appears.** Flash lights placed at a shell's first-seen position sat past the barrels; they are pinned to the flash sprite now.
- **Lights are ranked at the hull's rectangle, fade to zero at their reach, and a hull's own engines sit in their plume.** A circle round a long hull let escorts' engines crowd a blast off its deck; a slow falloff let engines light ships 150 u away like the sun.
- **Mip levels and gutters go together.** Slices sit side by side, so a mip level wider than the gutter blends them. Pixi compiles GLSL ES 1 (no `textureLod`, no derivatives), so each mesh's level is worked out on the CPU and a bias caps it at `LIT_MAX_LOD` = log2(gutter). Too low a cap under-filters thin barrels into beads.
- **Look R&D happens in the game behind a flag**, not in a parallel renderer (the art lab lacked turrets, the game's effects, shields, fences and sky).

## Cost (laptop, same build, `pnpm perf:scenes --base <sha> --head-params shiplight=gpu`)

**Correction (2026-11-08): these A/Bs were inconclusive, not GREEN.** Every GPU-lighting A/B behind #344–#346 ran 3 reps per arm: `gpu-light-ab.json`, `gpu-light-ab2.json`, the `hitch-*.json` investigation and the phone-proxy A/B (`phone-proxy-ab.json`, CPU ×2) behind the phone defaults. At 3 v 3 the exact Mann-Whitney test's smallest possible p is 0.10, so none of them could have gone RED, whatever the cost (`docs/LESSONS.md`, 2026-11-08, "A 3-rep exact Mann-Whitney can never reject at 0.05"; #352). Under today's verdict (`perf/verdict.ts`) each reads INCONCLUSIVE. The medians below are observations, not a verdict:

- typical frames and renderer CPU looked unchanged;
- the fleet fight dropped about one more frame every 2 s (p99 16.8 → 33.4 ms), and hitches roughly doubled against baked (10 → 20 a minute after geometry sharing, p = 0.7), inside this laptop's same-code spread (×2 on hitches);
- the CPU side is the lighting pass (~0.9 ms a frame at 50 ships, mostly light picking) plus one draw call per lit mesh.

So GPU lighting is on by default without evidence that it is free on weak hardware. See the open question below. Ledger: `perf/ledger/gpu-light-ab.json`.

## Open question: cost on weak hardware

Does GPU lighting (Medium on phones, Low on phones under 4 GB) cost frames or hitches on a phone? Unanswered (2026-11-08). The phone defaults (`defaultLightingPreset`) rest on the 3-rep phone-proxy A/B above, which could not have failed. Two lanes settle it, neither needs the desktop (the desktop is not a target platform and is not always on):

**1. The real phone** (`pnpm perf:phone`, [perf-scenes.md](perf-scenes.md#the-phone-lane-pnpm-perfphone)). Run on the laptop with the phone plugged in by USB, USB debugging on, unlocked, screen timeout long, Chrome's `chrome://flags/#enable-command-line-on-non-rooted-devices` Enabled, and nothing else running on the laptop:

```
pnpm perf:phone --scenes fleet-fight,wide-view --reps 8 --base HEAD --base-params shiplight=baked --head-params shiplight=medium --noise-check
pnpm perf:phone --scenes fleet-fight,wide-view --reps 8 --base HEAD --base-params shiplight=baked --head-params shiplight=low --noise-check
```

**2. The laptop's phone proxy** (no phone: Chrome on the laptop with its CPU throttled ×2, a phone-sized screen at DPR 2.625, touch):

```
pnpm perf:scenes --device phone-proxy --cpu-rate 2 --scenes fleet-fight,wide-view --reps 8 --base HEAD --base-params shiplight=baked --head-params shiplight=medium --noise-check
pnpm perf:scenes --device phone-proxy --cpu-rate 2 --scenes fleet-fight,wide-view --reps 8 --base HEAD --base-params shiplight=baked --head-params shiplight=low --noise-check
```

Notes:
- `--base HEAD` with only the params differing measures the switch on one build. Both arms pin `shiplight`: an arm without it runs the device's saved level or its default (Medium on a phone), not baked.
- `--noise-check` adds the A/A arm (baked against baked), so a move smaller than the host's own same-code spread can't read RED. Each command is 3 arms × 8 reps × 2 scenes: roughly an hour (more on the phone, which reloads the art each run). To split one into chunks, re-run the same command with `--append <ledger>` and `--reps 2` (or 4); the reps add up and the verdict is re-judged over all of them.
- Exit code: 0 GREEN, 1 RED or INVALID, 3 INCONCLUSIVE (`perf:phone` also 4 = no usable phone, with what to fix).
- Read `clientFrameP95`, `clientHitchesPerMin` and `renderP95`. If the laptop proxy and the phone disagree, the phone wins: the proxy throttles CPU only, and its GPU is the laptop's.

**Decision rule.** RED on the phone at Medium → phones default to Low (or baked) until a batcher (plan R3) fixes it. RED at Low too → phones default to baked. GREEN on both → the defaults stand, with evidence this time. INCONCLUSIVE → more reps (`--append`), not a decision.

**Result:** not yet run. Record each verdict here with its ledger file name.

## Memory (wrap-up W3, 2026-11-09)

The phone-proxy A/B read GPU lighting as **+33 % heap**. That reading was taken without a garbage collection, so it counts uncollected garbage (the same trap as the galaxy soak, LESSONS 2026-11-08). Measured properly, with fleet-fight, desktop Chrome, a forced collection (CDP `HeapProfiler.collectGarbage`) and a 20 s sampling profile:

| | GPU lighting | Baked |
|---|---|---|
| Live heap after collection | 45.1 MB | 43.3 MB |
| Everything allocated in 20 s (collected included) | 76.8 MB | 65.3 MB |

- **Retained memory:** +4 %. No growth to fix.
- **Garbage:** GPU lighting allocates about 18 % more (+0.6 MB/s), mostly in Pixi's per-mesh uniform update (`uni.update()`, once per lit mesh per frame). Our own lighting code (`fillScene`, `strongestLightsInto`, `addLight`) writes only into typed arrays and caches.
- **If GC pauses ever show on a phone:** update a mesh's uniforms only when its lighting changed.
- **The data atlas pages' CPU copies** (16 MB per 2048² page) live outside the JS heap. Freeing them is the parked atlas-release idea in `docs/SHELF.md`; it needs a context-loss path that re-packs from the bake cache.

## Status and next steps

Plan `prancy-squishing-donut`, R2 (branch `rnd/gpu-lit-ingame`). Open: R3 batcher, phone measurement, per-device presets in Settings, the gunhouse recoiling with its barrels (one sprite, same in baked art).
