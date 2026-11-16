# Graphics quality: edge smoothing, render sharpness, texture softening

<!-- showcase-exempt: per-device picture settings; a showcase clip is encoded at one resolution and cannot show the difference -->

Three optional picture settings, under **Settings → Graphics**. They are cosmetic only: none of them changes gameplay, collision, the network or any number the server sees. Each is saved per device (localStorage key `eqxGfxQuality`) and applies the next time the game loads. A URL parameter overrides the saved choice for that load.

| Setting | URL | Choices | What it does |
| --- | --- | --- | --- |
| Edge smoothing | `?aa=` | `off`, `msaa` (Standard, default), `fxaa` (Post), `max` | Standard is the canvas's 4× multisampling: smooth shape outlines. Post is one FXAA pass over the game world: it also smooths lines painted inside textures, slightly softer. Max is both. |
| Render sharpness | `?renderscale=` | `0.75` (Saver), `1` (default), `1.5`, `2` | Multiplies the drawing buffer against the screen's pixel density. Above 1 is supersampling; the buffer side is capped at 4096 px (`MAX_BUFFER_SIDE`), so a phone gets about 1.9× at `2`. |
| Texture softening | `?texsoft=` | `0` (default), `0.5`, `1` | A mip LOD bias on GPU-lit hulls (`uLodBias`, clamped to the last level), so fine panel lines on small or far ships stop crawling as they turn. Needs live lighting; no effect on baked art. |

The default (`msaa`, `1`, `0`) is the pre-existing look.

## How it works

- `render/graphicsQuality.ts` reads the URL and the saved preference (`resolveGraphicsQuality`: URL, else saved, else default) and computes the renderer resolution (`renderResolution`). `gameSurfaceBootstrap` resolves it once into `ArtOptions.quality`, which reaches the worker renderer in the BOOT message like the other art options.
- Post (`render/pixi/FxaaFilter.ts`) is a `Filter` on an **unmoved host container** around `world`, with `filterArea = app.screen`. It is not on `world` itself: Pixi maps `filterArea` through the container's own transform, and the camera moves and scales `world`, so the screen rect lands off screen and Pixi skips the pass. It is not on `app.stage` either: the destruction effects own the stage's filters.
- Texture softening is `litShipShader.setScreenScale(pxPerUnit, soften)`, fed from `litPass`.

## Why the default needed a fix

Any filter on `app.stage` renders the whole frame into a filter texture without multisampling, so Standard smoothing silently stops working. The old shader warp chain (May 2026) stayed attached to the stage after the join curtain, so desktop players had no edge smoothing at all. That chain is now removed; only the load curtain remains (`LoadCurtain`, no filter). See [warp-visual](../architecture/warp-visual.md).

## Costs

Not yet measured. A `pnpm perf:scenes` A/B (`--base HEAD --head-params aa=fxaa`, then `renderscale=2`, `aa=off`) on 2026-11-16 came back INVALID because the host was busy. Until there is a measurement, nothing here claims a cost. Structurally: Post adds one full-screen pass over the world; render sharpness 2 draws about four times the pixels; texture softening picks a smaller copy of an existing texture.

Screen filters are switched off by default on touch devices (`fxKillSwitches`). Post is an explicit player choice and is not affected by that switch.

## Future

- A one-pixel soft edge baked into the generated ship and rock art (free per frame, helps phones).
- A minimum on-screen width for thin lines (grid, lock and aim lines).
- Multisampling inside the destruction shockwave filter.
- An "Auto" choice per device, once there are timings.

## History

- 2026-11-16: added (branch `exp/antialias`), with the stage-filter MSAA fix and the removal of the old shader warp chain.
