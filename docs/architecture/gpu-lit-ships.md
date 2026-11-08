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

Both perf scenes GREEN. Typical frames and renderer CPU are unchanged; the fleet fight drops about one more frame every 2 s (p99 16.8 → 33.4 ms). The CPU side is the lighting pass (~0.9 ms a frame at 50 ships, mostly light picking) plus one draw call per lit mesh. Next: a custom batcher (plan R3) and the phone run. Ledger: `perf/ledger/gpu-light-ab.json`.

## Status and next steps

Plan `prancy-squishing-donut`, R2 (branch `rnd/gpu-lit-ingame`). Open: R3 batcher, phone measurement, per-device presets in Settings, the gunhouse recoiling with its barrels (one sprite, same in baked art).
