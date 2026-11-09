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
  renderer asks with `ArtService.fx(id, variant?, seed?)`. Switch: on for players
  whenever the art is Machined (since B6; the Settings "Detailed art" switch
  covers both), off for automated browsers, `?fx=new|classic` to override;
  with it the warm-up bakes `FX_WARM` first.
- **Backdrop (B2).** `art/fx/Backdrop.ts` replaces today's starfield once its star tiles are baked (until then `StarfieldBackground` keeps drawing). Layers: three star tiles, the sector's nebula, galaxies, spike stars, the sun along the hull light, and dust in front of the world on high quality only. Depth is `backdropXf` (far layers pan and grow less). The nebula comes from the sector key (`sectorNebula`: type and one of 12 seeds; emission kept faint; a dark-dust sector is a faint blue glow crossed by dark lanes, since dust only reads as dark against something bright). The sector reaches the renderer through `IRenderer.setSector` (main thread) or the existing `SET_CURRENT_SECTOR` (worker). The sun still uses the default light direction until per-sector sun is wired for the hull bakes too.
- **Weapons (B3).** `FxBeams` adds the halo, the flowing energy strip, the fading tail and the muzzle and hit flares over today's beam pools, so the range contract and the beam-origin test hooks are untouched. Bolts and tracers are pooled sprite views (`FxProjectiles`); impact sparks become soft glow sprites. Missile smoke trails come with the explosions (B4).
- **Explosions (B4).** `FxExplosions` plays every death (ships, drones, structures; blast radius from the dying sprite) and every missile detonation as a pooled burst: flash, fireball flipbook, secondary fireballs on big blasts, a shock ring, cooling embers and lingering smoke. Missiles trail a smoke ribbon (`FxMissileTrails`). Fresh wreckage glows: each scrap piece starts hot orange and cools to its own colour over 5 s (`scrapHeatTint` in `swarmSpriteUpdater.ts`, at the one per-frame tint site; loot pods excluded).
- **Shields and fences (B5).** A ship's shield is invisible at rest; a hit plays the baked ripple facing where it landed, a laser is a held contact, and the shield going down flashes and throws shards. Fences are a thin flowing energy line with glowing posts that grows in when raised, flickers out and sparks when it loses power, and pulls back into the posts when a gate opens. Fences don't react to hits yet: that needs a server event for a shot stopped by a fence.
- **Round 2 sky (C1).** Seven depths instead of three, so motion and zoom read as depth (round 1's far layers barely moved at boost). Planets, gas giants and moons drift past as you travel and every sector has its own sky. The landmarks sit on an endless grid seeded from the sector key, one chance per cell, so the sky never runs out and looks equally full in a small or a huge sector (sector sizes are arbitrary and expected to grow). R&D: the artifact's Round 2 sections; phone 90 fps (1.4 ms).
- **Nebulae you can fly into (C2).** Nebula regions sit on an endless world-space grid (one chance per 9000 u cell, radius 1400–2800 u, seeded from the sector key), so a sector of any size keeps having them. Each nearby region draws as wisp slices: two behind the world (parallax 0.6, 0.85) and two in front (1.2, 1.5). The front slices fade out near the screen centre, where the camera keeps your ship, so they never hide it. Inside a region the stars dim (by up to 55 %) and a faint colour grade tints the view. Medium quality drops the nearest front slice, low drops both, minimal draws none. They are scenery only: no gameplay effect. The regions are in GAME space (Y up); the renderer's camera centre is Pixi space (Y down), so the backdrop flips Y before looking them up (the first cut forgot and put every nebula at its mirror point; the unit test made the same mistake and passed).
- **Speed effects (C3), at the "large" strength the user chose.** When you fly fast the dust motes stretch along the motion and brighten, and the view zooms out by up to 20 %. The speed is the camera's own motion, eased over about 0.6 s (`stepSpeedFx`; a jump such as a respawn or a hitch doesn't count). The zoom-out is a factor on top of the player's zoom (`Camera.setSpeedZoom`): every camera tick takes it off, runs the usual zoom and follow, then puts it back round the screen centre, so the wheel, pinch and glide never see it and the player's chosen zoom comes back exactly. Picking uses the drawn scale. The cinematic director is never speed-zoomed. Settings → Graphics → "Speed effects" turns it off (per device, `eqxSpeedFx`, read at load; `?speedfx=0|1` for tests). Showcase shot: `crossing-sector` (a boosted run through a nebula past the landmarks, on the follow camera so the speed zoom shows).
- **Engine exhaust (2026-11-05, picked "both" in the engine lab).** Today's exhaust was particle dots shot astern at 200 u/s from one point behind the ship; ships fly 450–950 u/s, so the dots landed about 16 u apart and the plume read as a dotted line with nothing hot at the nozzle (missiles looked better because their smoke is one continuous ribbon). Now every ship (players, remote players and NPC drones) gets a baked flame with a white-hot core at each Machined nozzle, plus a short hot ribbon through the nozzle's last quarter second (`art/fx/FxEngines.ts`, textures `flame` / `flameCore` / `exhaustTrail` in `engineFx.ts`). Thrust lengthens the flame, boost lengthens it again and shifts it from orange to blue; idle keeps a small pilot flame. Players use their real thrust/boost input; drones have none on the wire, so their engines follow their speed against the kind's top speed. Speed comes from the sprite's own movement, so a teleport resets the ribbon instead of drawing it across the gap. Low and minimal quality keep the flames and drop the ribbons. Ships it draws skip the old particle emitter, which stays as the classic look and the fallback until the art is baked. Cost with 24 ships: 0.9 ms per frame against 1.6 ms for the old particles (lab bench, desktop), and the old emitter's 300-particle cap no longer starves big fights. Lab: `/__art-lab__/engines.html?arm=today|flame|ribbon|both&scene=flight|close|swarm` (branch `rnd/engine-fx`). Locks: `FxEngines.test.ts` (+ `.heapDelta`), `engineFx.test.ts`, `tests/e2e/fx-engines.spec.ts`.
- **Machined turrets (2026-11-05, turret lab round 2; rollout T1–T3).** Barrels used to be flat 2.4 × 20 u bars in the ship colour, the last vector-looking part of a Machined hull, with nothing happening when they fired. Now, with the new effects on:
  - **Built into the hull.** Each turret mount is a ring cut into the hull or deck bake (`stampTurretRing`: a recessed seat, a raised collar and a groove, lit and shadowed with the plating). The turning gun is forged and lit through the same fields as a hull (`forgeTurretGun`: a cap in the hull's own paint, a bare-metal barrel with seams, and per weapon a muzzle brake, lens, coils or a two-tube rack), with two sun frames cross-faded by the gun's own world rotation. Round 1's separate flat textures were rejected (they didn't share the hulls' look and read as stuck on).
  - **One layout.** `render/art/turretLayout.ts` places and sizes ring and gun from one function. Fixed centre guns (fighter, heavy, drones) become a short chin barrel whose tip is the old muzzle point. Structure defences scale with their footprint. Sizes are capped so capital hulls get turrets, not cannons. Miner drills are not turrets.
  - **Firing.** A bolt or missile first seen near a gun tip kicks that gun back (`recoilAt`) and flashes (`muzzleFlash` flipbook), and the tip heats under sustained fire; a held beam lights its emitter. Driven from data already in the render mirror, no wire change. Low and minimal quality drop the flash and heat.
  - **Shots leave the barrel tip** on both sides of the wire (T3, `core/combat/muzzle.ts`, #15). The gunship's two mounts were also moved to the nose and tail (they had been swapped).
  - **Aim guides** show only for the local ship's active weapon while a hostile is in range.
  - Lab: `/__art-lab__/turrets.html?arm=today|new&scene=lineup|sizes|defence|swarm` (branch `rnd/turrets`). Showcase shot: `machined-turrets`. Locks: `MountVisualManager.machined.test.ts` / `.reactions.test.ts` (+ heap-delta), `turretLayout.test.ts`, `tests/unit/muzzleParity.test.ts`, `tests/e2e/fx-turrets.spec.ts`.
- **Lab.** `/__art-lab__/fx.html?fx=today|new&scene=weapons|shield|shield-beams|explosions|zoom|nebula|environment|battle`
  (`shield=sprite|shader`, `neb=emission|reflection|dark|none`, `contact=0` for
  round 1's flickering beams). Capture: `pnpm tsx scripts/art-lab/capture-fx.ts
  --only stills|clips|bench [--clip id]` (outputs `diag/art-lab/fx-r1/`).
  Phone: `phone.html?set=fx`.
