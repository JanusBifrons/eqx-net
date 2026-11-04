# Art direction: the Machined look

R&D record for plan soft-leaping-truffle v5 (branch `rnd/art-direction`). It
covers the research, the decision, the measurements and what is left before
the look reaches the game. The lab is dev-only; nothing here touches the live
renderer yet.

## The decision

Round 1 (2026-11-03) showed the same scenes three ways: today's flat vector
look, a realistic **Machined** look and a **Lit pixel** look. The user's verdict:
Machined, "in a landslide". Lit pixel and the "hi-bit" in-between are dropped.

Results page (stills, clips, costs): https://claude.ai/artifact/BQckTi3aK3XWpouXgPSzU5

## How Machined works

Nothing is drawn by hand. All art is generated from data the game already
has, so a new ship or structure kind gets art automatically.

1. **Shape.** A ship starts from its catalogue polygon or composite parts (the
   same outline the collider uses, via `shipParts`); a structure starts from its
   `structureVisuals` draw plan. The forge never changes a silhouette, so art
   and hitbox cannot disagree (`artLabForge.test.ts` checks this to within one
   texel).
2. **Form** (`src/client/render/art/fields.ts`). A distance transform of the outline gives a
   bevelled edge plus a raised spine. Panel seams follow the distance contours
   (at most ~5 bands across any hull) and transverse cuts, mirrored by
   construction. Then a canopy, mirrored greebles, vents, nozzles and nav
   lights. Structure rects become blocks: big steel is tall, saturated rects are
   painted plating, translucent ones are lit windows, lights are lamps. Each
   kind is seeded by its id, so it always comes out the same.
3. **Light** (`src/client/render/art/shade.ts`). Lit once at load: sun, sky fill, rim light,
   specular per material, cavity occlusion, and a soft height-field shadow
   toward the sun. Tone-mapped (ACES fit) to sRGB through a lookup table.
4. **Play** (`src/client/render/art/atlas.ts`; the lab's `__art-lab__/assets.ts` and `main.ts`). All frames go into shared 4096² atlas
   pages. A ship is two sprites cross-fading the two nearest of 16 pre-lit sun
   angles, so the hull rotates freely and the light never jumps. A structure
   is one sprite (it never rotates), plus a half-resolution unlit copy that
   explosions add on top in their own colour. Engines, nav lights, beams,
   bolts, impacts and shield rims are additive glow sprites created up front
   and only mutated per frame (invariant #14).

Faction colour only changes the paint channel. Metal, glass and trim stay
shared, so every fleet looks like it belongs to the same universe.

## Measurements

The bench base has 40 ships and 150 structures, at 1280×720, in headless Chrome
on the desktop GPU. Frame time is update plus draw, waiting for the GPU (`gl.finish`).

| | Frame p50 / p95 | 4× slower CPU p50 / p95 | Bake | Texture memory |
|---|---|---|---|---|
| Today (live `Graphics`) | 1.0 / 1.4 ms | 6.5 / 15.5 ms | none | none |
| Machined, round 1 | 1.3 / 2.1 ms | 6.4 / 15.3 ms | 39 s | 181 MB |
| Machined, round 2 | 0.9 / 1.7 ms | 4.7 / 11.2 ms | 1.3 s first visit, 0.11 s after | 30 MB |

**On a real phone** (2026-11-04: an 8-core Android phone in Chrome, 90 Hz, rendering at DPR 2.6, via `phone.html`), every test held 90 fps. The 40-ship / 150-structure base drew in 3.2 / 5.2 ms (p50 / p95), against 3.3 / 4.7 ms for today's look. The base bakes in 1.5 s on a first visit and 0.12 s when cached.

Drawing was never the problem; loading was. Round 2 fixed it as follows:

- **Forge 10–30× faster.** The noise function allocated two closures per call
  inside the per-texel loop. Grime now runs once per texel, not once per layer.
- **Light pass about 3× faster.** Tone and sRGB conversion use a lookup table
  instead of three `Math.pow` calls per texel. The blur is a sliding window
  (O(1) per texel at any radius). The shadow march runs at half resolution in
  world-sized steps. The normals pass has an interior fast path.
- **Sharing.** At most 3 seed variants per structure kind
  (`STRUCT_SEED_VARIANTS`). Resolution scales with size: 2 texels per unit,
  longest side capped at 1024 for structures and 512 for ships, so small kinds
  stay sharp up close and huge kinds stay affordable.
- **Off the main thread.** Up to 4 workers bake in parallel
  (`src/client/render/art/bake.worker.ts`); the main thread only packs the atlas (18 ms).
- **Kept between sessions.** Bakes are stored in IndexedDB, keyed by
  `FORGE_VERSION` plus the bake key plus the light rig (`src/client/render/art/bakeStore.ts`).
  **Bump `FORGE_VERSION` whenever forge output changes**, or players see stale art.

`scripts/art-lab/bake-cost.ts` prints the bake cost per structure kind.
`scripts/art-lab/persist-check.ts` proves the between-session cache works.

## In the game

**On by default for players** (A5): `?art=classic` or Settings → Graphics → Detailed art (off) brings back today's look; automated browsers default to classic unless they pass `?art=machined`. Showcase shot: `machined-art`.

The renderer reaches the art through `src/client/render/art/ArtService.ts` (plan iridescent-seeking-rainbow):

- **Handles.** A request returns a reused handle at once; the sprite draws today's look until the handle is ready, so nothing waits on a bake.
- **Bakes.** They run on a worker pool (inline if workers are unavailable) and come from the device cache when possible.
- **Packing.** Finished bakes go into the atlas within a per-frame budget (3 ms).
- **Memory budget.** Pages are counted at their full GPU cost. Phones get up to 6 pages of 2048² (about 125 MB with mipmaps); desktop up to 4 of 4096² (about 340 MB). Art that doesn't fit fails, and that sprite keeps today's look.
- **Sun.** Each sector gets its own sun direction, hashed from its key and kept above the screen (`sunRig.ts`).
- **Turns.** Structures bake per quarter turn, so turning one never turns its sunlight.

## Rejected options

- **Lit pixel.** It worked: palette ramps in OKLCh with cool shadows and warm
  highlights, Bayer dither between light bands only, an outline, a true pixel
  grid with zoom bands and sub-pixel camera restore. The user preferred Machined.
  The code is still in the lab (`src/client/__art-lab__/pixel.ts`) for reference.
- **Runtime normal-mapped lighting** (`pixijs-light2d`, `pixi-lights`). Normal
  maps must rotate with each sprite, which fights batching, and full-screen
  passes are what heat phones (`fxKillSwitches.ts`). Pre-lit sprites cost no
  shader passes. A deferred "high" tier is still possible later, but it must
  visibly earn its cost.
- **Sprite stacking.** It shows little depth seen straight down, and is hard to light.

## Known gaps (next)

- Very large hulls (the Crossguard and El test ships) and the two huge pads
  (large teleporter, alien gate) come out flat. They need a recipe for big
  surfaces.
- Ships casting shadows on decks, and the nebula baked per sector. (Scrap pieces and asteroids are now baked: `forgeScrap`, `forgeRock`.)
- Integration into `PixiRenderer` needs its own plan: the worker render path,
  `EffectsBudget` tiers, the fallback to today's look while bakes are pending,
  and the cache budget on low-storage devices.

## Phone run

`pnpm tsx scripts/art-lab/phone-server.ts` serves the lab on the LAN (port 5374) and collects results (port 5375) into `diag/art-lab/phone/`. On the phone, open `http://<pc-ip>:5374/__art-lab__/phone.html` and tap Start. When sharing the link in chat, put it in a code block, or Markdown turns the `__` into bold and breaks it. To rehearse on the PC first: `scripts/art-lab/phone-dryrun.ts`.

## Running the lab

`pnpm dev:client`, then open
`/__art-lab__/index.html?style=machined&scene=base`. Scenes: `ships`,
`factions`, `structures`, `base`, `explosion`, `sweep`, `combat`, `fleet`,
`capitals`, `industry`, `mega`, `bench`. Capture with
`pnpm tsx scripts/art-lab/capture.ts --only stills|clips|bench --styles machined [--clip id] [--still id,…]`.
It boots its own Vite on port 5374. On an 8 GB machine, run clips one at a
time: a long background capture was once stopped by Claude Code for low memory.

## Effects and backdrop (plan iridescent-seeking-rainbow v3)

Round 2 applied the same idea to everything that isn't a hull: weapons, shield
hits, explosions, the starfield, nebulae and environment props. The expensive
looks (fireball and shield-hit flipbooks, hex shields, folded-noise nebulae,
star tiles with colour temperature) are generated once by
`render/art/fx/fxTextures.ts` and drawn every frame as batched sprites; the
per-frame maths (`fxMath.ts`: flipbook frames, envelopes, backdrop depth,
`ShieldHits`, `ShieldContacts`, `TrailRing`) is pure and allocation-free.

- **R&D results.** Artifact: https://claude.ai/artifact/Dcp1xwrMZUGaAqZRNhH52w.
  On the phone (Android, 90 Hz) every scene held 90 fps; the new starfield
  costs 0.8 ms against 3.3 ms today; the battle effects cost slightly more than
  today's in the lab (4.4 vs 4.0 ms at 12 a side), which the game version
  offsets by skipping off-screen and finished effects.
- **Choices.** Shield hits use the baked flipbook (not the shader in
  `shieldShader.ts`, kept in the lab for comparison). All three
  nebula types (emission fainter). A laser on a shield is a **held contact**,
  not a stream of hits (`ShieldContacts`): one steady lit patch per beam, close
  beams share a brighter one, at most four per shield, bolt ripples separate.
- **Pipeline (B1).** Each texture is an `fx` bake job (`bake.ts`), cached in
  IndexedDB under `FX_VERSION` (locked by `fxTextures.lock.test.ts`: bump it
  with any generator change). Wrapping textures (star tiles, nebula, dust, the
  beam flow) get a texture of their own (`Atlas.standalone`); the rest share
  the art atlas, and flipbook sheets are cut into cells (`flipCells`). The
  renderer asks with `ArtService.fx(id, variant?, seed?)`. Switch: `?fx=new`
  (needs Machined art; default off until the rollout's last PR); with it the
  warm-up bakes `FX_WARM` first.
- **Lab.** `/__art-lab__/fx.html?fx=today|new&scene=weapons|shield|shield-beams|explosions|zoom|nebula|environment|battle`
  (`shield=sprite|shader`, `neb=emission|reflection|dark|none`, `contact=0` for
  round 1's flickering beams). Capture: `pnpm tsx scripts/art-lab/capture-fx.ts
  --only stills|clips|bench [--clip id]` (outputs `diag/art-lab/fx-r1/`).
  Phone: `phone.html?set=fx`.
