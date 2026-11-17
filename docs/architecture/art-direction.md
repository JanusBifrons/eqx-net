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
- **Capital wrecks (capital destruction S3, 2026-11-12).** A broken capital's pieces wear the dead ship's own baked art, cut out of it at each piece's original place on the hull, so the pieces fit together like a jigsaw (one batched mesh per hull tile, no new bake or texture), tinted burnt and darkest where the killing blow landed. The new cut edges glow white-orange at the moment of death, are a dull ember by 4 s and dark by 9 s; the original hull outline never glows. The break-up itself is a white flash at the kill point (bigger for a clean snap) with dust and hot shards flung outward, scaled to the wreck and capped by the effects tier. Details: [capital-destruction.md](capital-destruction.md) "S3".
- **Shields and fences (B5).** A ship's shield is invisible at rest; a hit plays the baked ripple facing where it landed, a laser is a held contact, and the shield going down flashes and throws shards. Fences are a thin flowing energy line with glowing posts that grows in when raised, flickers out and sparks when it loses power, and pulls back into the posts when a gate opens. Fences don't react to hits yet: that needs a server event for a shot stopped by a fence.
- **Round 2 sky (C1).** Seven depths instead of three, so motion and zoom read as depth (round 1's far layers barely moved at boost). Planets, gas giants and moons drift past as you travel and every sector has its own sky. The landmarks sit on an endless grid seeded from the sector key, one chance per cell, so the sky never runs out and looks equally full in a small or a huge sector (sector sizes are arbitrary and expected to grow). R&D: the artifact's Round 2 sections; phone 90 fps (1.4 ms).
- **Nebulae in the galaxy (Nebulae stream, 2026-11-16).** Nebulae sit where the galaxy map has a `nebula` mark (`core/galaxy/nebulaField.ts`, shared by every side). Each mark is one soft cloud centred on its sector in galaxy space (each sector's centre at its map hex centre, neighbours one sector width apart, game axes); touching marks merge, so an edge sector is thick toward its nebula neighbours and thins toward open space, and a lone mark is full at the centre, about half at the edges and wisps in the corners. Sectors without a mark have no fly-through cloud, only their far haze tile (`sectorNebula`), which fades out as the nebula thickens. `nebulaDensity(sectorKey, x, y, thin?)` is the one answer to "how deep in a nebula is this point"; `thin` circles (`{x, y, r, taken}`, density times `exp(-taken)` at the centre) are the hook for future gas extractors: thin but never empty, so yield has diminishing returns. Nothing stores circles yet. The backdrop builds the volume below for a sector whose `sectorNebulaPeak` is above 0, seeded per sector (`nebulaStyle('blend', hashKey('nebula:<key>'))`, so the look changes across a big nebula), and scales everything by the density at the camera. Its art is baked ahead of the queue (it is on screen the moment the sector loads). Parallax holds at every zoom, the command view included: front puffs slide past at a fixed 1.06-1.2x the world (`frontPuffShift`, screen speed `p * zoom`), and the far layers and knots are capped below the world's speed (`backLayerParallax`, `BACK_MAX_SPEED`), because their `zoomPow` growth otherwise made far gas outrun the ships when zoomed out (owner: "near-field parallaxing was too extreme, particularly on command mode"; `nebulaVolume.test.ts`). The old C2 wisp regions (an endless 9000 u grid of small clouds in every sector) are gone: the owner chose "clear sectors: faint far-off haze only". Locks: `nebulaField.test.ts`, the nebula cases in `Backdrop.sky.test.ts` (Y flip included) and `Backdrop.heapDelta.test.ts`, the nebula cases in `machined-art.spec.ts`. Not yet: slower locks inside, the HUD note, the map cloud (plan `nebulae-galaxy-regions`, parked).
- **Dense nebula look (Nebulae stream, look signed off 2026-11-16).** The nebula volume drawn in nebula sectors (above); `?neblook=blend&nebseed=N` (or `fog` / `rainbow` / `storm` for the three corner looks) forces one look everywhere at full depth for look R&D. It is still drawn by `Backdrop` into its `nebBack`/`nebFront` containers (not a second renderer). One seeded `NebulaStyle` (`art/fx/nebulaLook.ts`) sets colours (one hue, two hues or a rainbow sweep), thickness, glow, turbulence, dust, star knots and lightning; `blendWeights` makes most nebulae almost entirely one look (fog half the time, rainbow or storm a quarter each; about one in four a real mix), with brightness held at fog level so a fight always reads over the cloud. `NebulaVolume` (`art/fx/nebulaVolume.ts`) draws six tiling cloud layers at increasing parallax that drift slowly, a dark dust layer, glowing star knots, lightning flashes and three slices of puffs in front of the world that clear round the screen centre. A layer is never smaller on screen than `minView` screens, so a capital's far zoom shows big cloud, not a repeating wallpaper. Bakes are fx ids `nebLayer` / `nebPuff` (variant `<look>:<seed>.L<n>|.P<n>|.D`). Quality: medium drops two layers and keeps one front slice, low keeps two layers and no front, minimal one. Locks: `nebulaLook.test.ts`, the `?neblook` case in `Backdrop.heapDelta.test.ts`.
- **Speed effects (C3), at the "large" strength the user chose.** When you fly fast the dust motes stretch along the motion and brighten, and the view zooms out by up to 20 %. The speed is the followed ship's drawn motion, eased over about 0.6 s (`stepSpeedFx`; a jump such as a respawn or a hitch doesn't count). Command view's free camera has none: a pan or a wheel zoom round the cursor is not flight (it zoomed the view out mid-pan, "stutters like it thinks I've still got a ship travelling fast", owner 2026-11-14; lock `tests/e2e/command-view-camera.spec.ts`). The zoom-out is a factor on top of the player's zoom (`Camera.setSpeedZoom`): every camera tick takes it off, runs the usual zoom and follow, then puts it back round the screen centre, so the wheel, pinch and glide never see it and the player's chosen zoom comes back exactly. Picking uses the drawn scale. The cinematic director is never speed-zoomed. Settings → Graphics → "Speed effects" turns it off (per device, `eqxSpeedFx`, read at load; `?speedfx=0|1` for tests). Showcase shot: `crossing-sector` (a boosted run through a nebula past the landmarks, on the follow camera so the speed zoom shows).
- **Engine exhaust (2026-11-05, picked "both" in the engine lab).** Today's exhaust was particle dots shot astern at 200 u/s from one point behind the ship; ships fly 450–950 u/s, so the dots landed about 16 u apart and the plume read as a dotted line with nothing hot at the nozzle (missiles looked better because their smoke is one continuous ribbon). Now every ship (players, remote players and NPC drones) gets a baked flame with a white-hot core at each Machined nozzle, plus a short hot ribbon through the nozzle's last quarter second (`art/fx/FxEngines.ts`, textures `flame` / `flameCore` / `exhaustTrail` in `engineFx.ts`). Thrust lengthens the flame, boost lengthens it again and shifts it from orange to blue; idle keeps a small pilot flame. Players use their real thrust/boost input; drones have none on the wire, so their engines follow their speed against the kind's top speed. Speed comes from the sprite's own movement, so a teleport resets the ribbon instead of drawing it across the gap. Low and minimal quality keep the flames and drop the ribbons. Ships it draws skip the old particle emitter, which stays as the classic look and the fallback until the art is baked. Cost with 24 ships: 0.9 ms per frame against 1.6 ms for the old particles (lab bench, desktop), and the old emitter's 300-particle cap no longer starves big fights. Lab: `/__art-lab__/engines.html?arm=today|flame|ribbon|both&scene=flight|close|swarm` (branch `rnd/engine-fx`). Locks: `FxEngines.test.ts` (+ `.heapDelta`), `engineFx.test.ts`, `tests/e2e/fx-engines.spec.ts`.
- **Machined turrets (2026-11-05, turret lab round 2; rollout T1–T3).** Barrels used to be flat 2.4 × 20 u bars in the ship colour, the last vector-looking part of a Machined hull, with nothing happening when they fired. Now, with the new effects on:
  - **Built into the hull.** Each turret mount is a ring cut into the hull or deck bake (`stampTurretRing`: a recessed seat, a raised collar and a groove, lit and shadowed with the plating). The turning gun is forged and lit through the same fields as a hull (`forgeTurretGun`: a cap in the hull's own paint, a bare-metal barrel with seams, and per weapon a muzzle brake, lens, coils or a two-tube rack), with two sun frames cross-faded by the gun's own world rotation. Round 1's separate flat textures were rejected (they didn't share the hulls' look and read as stuck on).
  - **One layout.** `render/art/turretLayout.ts` places and sizes ring and gun from one function. Fixed centre guns (fighter, heavy, drones) become a short chin barrel whose tip is the old muzzle point. Structure defences scale with their footprint. Sizes are capped so capital hulls get turrets, not cannons. Miner drills are not turrets.
  - **Firing.** A bolt or missile first seen near a gun tip kicks that gun back (`recoilAt`) and flashes (`muzzleFlash` flipbook), and the tip heats under sustained fire; a held beam lights its emitter. Driven from data already in the render mirror, no wire change. Low and minimal quality drop the flash and heat.
  - **Shots leave the barrel tip** on both sides of the wire (T3, `core/combat/muzzle.ts`, #15). The gunship's two mounts were also moved to the nose and tail (they had been swapped).
  - **Aim guides** show only for the local ship's active weapon while a hostile is in range.
  - Lab: `/__art-lab__/turrets.html?arm=today|new&scene=lineup|sizes|defence|swarm` (branch `rnd/turrets`). Showcase shot: `machined-turrets`. Locks: `MountVisualManager.machined.test.ts` / `.reactions.test.ts` (+ heap-delta), `turretLayout.test.ts`, `tests/unit/muzzleParity.test.ts`, `tests/e2e/fx-turrets.spec.ts`.
- **Capital bows (2026-11-12, owner decision).** A close-up showed the battleship's bow as a plain grey wedge: the warship generator puts its parts amidships and the forge only plated the bow. `render/art/bowDetail.ts` now plans a forecastle for every capital kind (all classes, styles A/B/C) from the hull outline and the turret layout: hawse pipes and anchors near the edges, chain runs to a windlass and wildcats, a V breakwater ahead of turret A, bollards, fairleads, ventilators, hatches, a jackstaff at the stem, transverse and longitudinal plating seams, and a forward director with its rangefinder (on open deck before the bridge, or on the bridge's forward step when the forward turrets leave no gap, as on the A-style battleship). Sizes are fractions of the beam and the local half-breadth (#18). Nothing goes inside a turret's keep-out (its ring, or its gunhouse's swept circle, whichever is bigger) or on a superstructure, stack or engine part; a fitting that would is moved along its row or dropped. The plan is seeded by the kind id. `forgeShip` stamps it into height, material and albedo (`stampBowFeatures`), so baked frames and GPU-lit maps (normals from height) both carry it; no new textures or display objects. `FORGE_VERSION` r2.5. Lock: `bowDetail.test.ts`.
- **Lab.** `/__art-lab__/fx.html?fx=today|new&scene=weapons|shield|shield-beams|explosions|zoom|nebula|environment|battle`
  (`shield=sprite|shader`, `neb=emission|reflection|dark|none`, `contact=0` for
  round 1's flickering beams). Capture: `pnpm tsx scripts/art-lab/capture-fx.ts
  --only stills|clips|bench [--clip id]` (outputs `diag/art-lab/fx-r1/`).
  Phone: `phone.html?set=fx`.

## Ship livery

Every Machined ship wears a **livery**: a neutral grey hull with its owner
faction's colour painted only in chosen sections, so a fleet reads by owner
at a glance and the hulls still read as one universe. It is on by default
(treatment `b8`); classic art is untouched.

**Who owns a hull.** The owner is a faction id: a player's own id (each
player is their own faction), an NPC faction from the owner string, else the
kind's allegiance (drones, robots, traders). Wrecks and lingering hulls keep
their owner's livery: a capital wreck's descriptor names its owner, and with
none its pieces resolve the owner as the live hull did (faction, else the
kind's allegiance), so they reuse the hull's bake and never wait on a new
one (capital-destruction.md S3). Cargo pods are never liveried. The renderer resolves it in
`art/shipArtSprites.ts` (`ownerLivery`, cached per owner; `shipHandleFor`
compares scalars only, so a frame allocates nothing) from three pure
functions in `shared-types/factions.ts`:

- `teamColorOf`: an NPC faction's own colour; a player gets one of 12
  `PLAYER_LIVERY` hues by a hash of their id.
- `teamSigilOf`: a 16-bit seed for the faction's procedural sigil
  (`sigilDesign`, mirror-symmetric; no six-pointed bursts).
- `teamEdgeOf`: the shape of the painted section's edge. Fixed factions own
  one (`FactionDef.liveryEdge`): **swept** chevron (sides reach further) for
  Drones, Sol Dominion and The Ancients; **tooth** (dog-tooth) for Robots and
  Verdant Reach; **tongue** (centreline reaches further) for Traders, Crimson
  Expanse and Azure Deep. Minor factions take the three shapes in turn within
  each region, so a region shows all three. Players get one by a hash of
  their id.

**What gets painted** (`forgeShip`, `fields.ts`; paint is `MAT.LIVERY`, the
hull grey comes from `liveryHullGrey` / `LIVERY_SHADES.b8`):

- **Capitals:** solid painted sections across hull and deck at the bow (a
  fifth of the length) and stern, with a broken, mirror-symmetric edge in the
  faction's shape. The paint is tinted by the hull's own tone underneath, so
  it shades like the hull; the superstructure stays grey. Each turret base
  keeps a grey barbette ring (a widened keep-out round the turret, so paint
  never shows as a sliver between guns). Two clean deck sigils in the team
  colour. Weathered (`weatherLivery`): mottle and sun-fade toward the grey,
  fore-aft grime streaks, clustered dark-primer chips, chalky patches,
  scratches to bare metal and flaking where paint meets grey hull; the bow
  section wears about half of it so it still reads in colour at line-up zoom.
- **Small ships:** flashes on the nose, the wingtips and the tail, none under
  a turret's keep-out (`TURRET_COVER_REACH` × max(ring, cap) via
  `turretCoverOf`). A hull whose visible paint is too small grows worn tail
  flashes until the paint covers a set share of the hull: every hull shows
  its colour. The same weathering family, finer grained.
- **Robots:** painted bow and stern sections like the capitals', with
  bolder edge shapes (square dog-teeth) so they read at combat zoom (~75 px
  across), stopping short of the glowing core. Crisp edges, no turret
  keep-out, no flaking, and a light wear only.
- Running lights and the tail beacon stay the bright team colour.

**Flag.** `?livery=` is read once on the main thread (`readLivery`,
`art/artMode.ts`) and reaches the worker on BOOT. Absent or unknown =
`DEFAULT_LIVERY` (`b8`); `off` = no livery, the pre-livery paint (byte
identical to before the livery: `fields.livery.test.ts`). Other values are
look-R&D overrides: `a` (rim band), `b` (nose, tips, bow fade), `c` (canopy
ring, collars, sigils), `b2`/`b3` (shade experiments), `b4` (straight
sections), `b5`/`b6`/`b7` (every faction forced to swept / tongue / tooth).
The default livery is drawn on Machined art only and never changes the art
mode; a livery named in the URL implies Machined unless `?art=` says
otherwise. Showcase shots film the player's look, so they show the livery
(`ship-gallery`, `capital-lineup`, `robots`).

**Bake key and cache.** A liveried ship bake's key ends with
`:L<treatment><team hex>:<sigil hex>[:<edge>]` (`bake.ts` `liveryTag`), so
each faction is its own bake. Any change to the livery's forge output bumps
`FORGE_VERSION` (`bakeStore.ts`; the `-lvN` suffix), or players' caches
serve stale paint.

Locks: `artMode.test.ts`, `fields.livery.test.ts`, `shipLivery.test.ts`,
`shipSpriteUpdater.livery.test.ts`, `factions.livery.test.ts`,
`tests/unit/machinedArt.test.ts`.

**History.**
- 2026-11-14: owner approved the experiment: grey hulls with owner-faction
  spots behind `?livery=a|b|c`, filmed as options.
- 2026-11-15: owner on `b`: capital paint "looks additive", "capitals are
  key... sections of the hull which are more distinct... important it's
  weathered"; small ships must keep visible colour with turrets fitted
  (`b4`); "the straight lines look bad" (shaped edges `b5`..`b7`, then
  `b8`: each faction its own edge); "all hulls should be painted"; on robots
  "the weathering is too extreme" (light wear).
- 2026-11-15: owner: "Land it with flag on". `b8` is the default;
  `?livery=off` turns it off.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Art budget follows the device and each sector visit.** Touch devices get atlas pages by `navigator.deviceMemory` (`atlasOptsFor`: 4–14 pages; desktop 16 × 2048²). `setSector` starts a new art visit (`ArtService.newVisit`): new lit art packs into that visit's pages, and `PixiRenderer.collectUnusedArt` (every ~2 s) frees a past visit's pages once no sprite or gun holds or shows its art. When the budget is tight, art still in use is re-packed from the bake cache into the current visit (a copy that won't fit leaves the original in place). Sprite helpers re-acquire a handle marked `stale`; guns switch to `handle.next` when it is ready. Effect textures (group 0) are never freed. Lock: `tests/unit/artSectorCollect.test.ts`.

### Machined art (plan iridescent-seeking-rainbow)

- **Where it lives.** `render/art/` generates the Machined look from the ship and structure catalogue at load time: `fields` (shape), `shade` (light), `bake` (whole bakes as plain data), `bake.worker` (off-thread), `bakeStore` (IndexedDB cache), `atlas`. It is pure and DOM-free except `atlas`. The dev-only lab (`__art-lab__/`) is its visual test bench. Story: [docs/architecture/art-direction.md](art-direction.md).
- **Bump `FORGE_VERSION` whenever the forge's output changes.** Players' devices cache baked art under it; a change without a bump serves stale art. `tests/unit/machinedArt.test.ts` pins a reference-bake hash to the version and fails until both are updated together.
- **`ArtService` is how the renderer gets art** (A2). Ask by kind, get a reused handle back at once (`pending` → `ready` | `failed`); keep the handle and check it per frame (no allocation). Bakes run on a worker pool (inline if workers can't start), come from the IndexedDB cache when possible, and are packed into the atlas within a per-frame budget (`tick()`). A `failed` handle (bake error, or over the texture budget) means the sprite keeps today's look. Phones get 2048² pages, budget 6; desktop 4096², budget 4. Structures bake per quarter turn (`rot`), so turning one never turns its sunlight. Which look draws is resolved ONCE on the main thread (`resolveArtMode`, `art/artMode.ts`): `?art=classic|machined` wins, then the player's per-device choice (Settings → Graphics, localStorage `eqxArtStyle`), then automated browsers (`navigator.webdriver`) get classic (so CI bakes never skew the netgate or slow the suite, the WebRTC precedent), else **Machined** (the default since A5). The result reaches the renderer through its constructor and the worker through BOOT (`artMode`/`artDelayMs`). Specs that test the look must pass `?art=machined`. Locks: `tests/unit/artService.test.ts`.
- **Ships (A3).** Player ships, drones and lingering hulls go through `art/shipArtSprites.ts` (`shipHandleFor` / `shipArtSwap` / `buildArtShipSprite` / `updateArtShipLight`), the ONE place a ship sprite switches between today's `Graphics` and a `MachinedShipSprite` (two Sprites cross-fading the two nearest baked sun frames, `machinedShipLight.ts`). The swap decision is the pure `decideArtSwap` (`spriteUpdateDecisions.ts`). Sprite maps are `Map<string, Container>`: never assume a ship sprite is a `Graphics`. A patrol bakes its faction paint, so a Machined patrol is never tinted (damage flash still is). The render worker gets the page query string on BOOT (`search`), because it has no `window`. DEV hook `__eqxArtStats` (`?worker=0`) is re-assigned every frame so it follows the LIVE renderer (a dev StrictMode remount leaves a disposed one). Test trigger: `?artDelayMs=` holds bakes back. Locks: `swarmSpriteUpdater.machinedArt.test.ts`, `machinedShipLight.test.ts` (+ `.heapDelta`), `decideArtSwap` cases, `tests/e2e/machined-art.spec.ts`.
- **Structures and scrap (A4).** Same helper module: `structHandleFor` (bakes the quarter turn, so the sun stays put when a structure is rotated), `scrapHandleFor` (one bake per `(parentKind, componentIndex)`, from `shipScrapGroups`; tumbles, so ship-style cross-faded frames). Structures draw a `MachinedFlatSprite` (one lit frame); their children (readouts, rings, barrels) are rebuilt on it by the create path. Asteroids no longer bake: placed rocks and their cut pieces draw the field rock shader ([macro-terrain](macro-terrain.md), "Placed rocks and their cut pieces").
- **Warm-up.** When the art service starts (on the galaxy map, before a sector is joined) the renderer queues `warmUpJobs()` (`art/warmUp.ts`: every regular ship kind, then the common structures). Warm-up bakes are LOW priority: anything a sprite asks for goes to the front of the worker queue, and a queued warm-up bake is promoted when a sprite asks for it. Packing (`ArtService.tick`) runs from the Pixi ticker, not `update()`, so it also runs on the galaxy map and warp screens where `update()` doesn't.
- **New effects and backdrop (plan iridescent-seeking-rainbow v3).** Effect textures are `fx` bake jobs (`art/fx/fxTextures.ts` registry `FX_SPECS`), asked for with `ArtService.fx(id, variant?, seed?)`. **Bump `FX_VERSION` with any generator change** (lock: `fxTextures.lock.test.ts`). Wrapping textures get their own texture (`Atlas.standalone`), the rest share the atlas; flipbooks are cut with `flipCells`. Switch: `resolveFxMode` (B6): ON for players whenever the art is Machined (the one "Detailed art" setting covers both), OFF for automated browsers (`navigator.webdriver`), `?fx=new|classic` wins; carried to the worker on BOOT (`fx`). Specs that test the effects pass `?fx=new`. Per-frame effect maths lives in `art/fx/fxMath.ts` (pure, heap-delta locked). A laser on a shield is a held contact (`ShieldContacts`), never a stream of hits. **Backdrop (B2):** `art/fx/Backdrop.ts` takes over from `StarfieldBackground` once its star tiles are ready (the old field is the fallback, never removed while `?fx=new` is off); its nebula follows `IRenderer.setSector` (worker: `SET_CURRENT_SECTOR` also calls `renderer.setSector`). **Weapons (B3):** `art/fx/FxWeapons.ts`: `FxBeams` draws glow + flowing strip + muzzle/hit flares OVER today's beam pools (which stay the core and keep the solid-then-fade contract and the drawn-origin feedback); remote beams pass their `hit` flags. `FxProjectiles` replaces bolt/tracer Graphics with pooled sprite views (released by generation stamp; pulse orbs and beams keep today's shapes). Impact sparks become glow sprites via `EffectStageRefs.fxGlow`. **Explosions (B4):** `art/fx/FxExplosions.ts` `FxExplosions` (pooled bursts, max 24: flash, fireball flipbook, sub-fireballs on big blasts, ring, embers, smoke; low quality drops smoke) replaces the destruction particle burst + shock filter for every death in `explodingShips` (radius from the dying sprite, `blastRadiusFor`) and the missile detonation Graphics; `FxMissileTrails` gives each missile a pooled smoke `MeshRope` fed by a `TrailRing`. Both reset on sector handoff. Hot-glowing scrap is not done yet. **Shields + fences (B5):** `art/fx/FxShields.ts`. `FxShields` is invisible at rest: shield-layer impact triggers play the hit flipbook facing the hit (angle from `hitX/hitY` vs the sprite), beams that land on a shielded target (remote `laser.hit && targetId`, live `hitId`) are held contacts, and a shield missing from the frame plays its break. The frame opens before the beam code (`begin`) and closes in `syncShieldAuraEffects` (`end`); `ShieldAura` is hidden (`setShieldAuraHidden`) while it draws. `FxFences` takes over both wall layers in `ConnectorRenderer` once ready (readiness is folded into the static signature so the old rails are rebuilt away); it tracks each wall key's up / down / open state to play raise, power-loss and gate animations. **Fence hits (fix 2026-11-04):** a fence stopping a bolt or missile broadcasts `wall_hit {x,y,kind}` (`WallHitEventSchema`, the point from `ShieldWallManager.lastHitX/Y`) → a `wall-hit` effect trigger → `FxFences.hitAt` ripple (today's look: shield-tinted impact sparks). A beam stopped by a fence is `laser_fired` with `hit && !targetId` (remote) or a `predwall-` `hitId` (local) → a held fence contact, buffered one frame because the fence layout runs before the beams. Locks: `tests/integration/sectorRoom/fenceHits.test.ts`, `tests/e2e/fence-hits.spec.ts`, `FxShields.test.ts`. Locks: `FxWeapons.test.ts` (+ `.heapDelta`), `tests/e2e/fx-weapons.spec.ts`. **Round 2 sky (C1):** the backdrop uses the depth ladder (`art/fx/depth.ts` `DEPTH_LADDER`: stars at 0.03 / 0.08 / 0.18, dust motes at 0.4 and 1.3) and landmarks (planets, gas giants, moons, far nebula patches, galaxies) on an ENDLESS cell grid per sky layer, seeded from the sector key (`SKY_LAYERS`, `skyCell`, `visitSkyLayer`). Never lay the sky out for a sector size: sizes are arbitrary and will grow, so density is defined per screen, not per sector. Landmarks draw from a fixed sprite pool per layer with pre-acquired texture variants (no per-frame allocation). Dark nebula colours must be dark in sRGB, not linear (a linear 0.05 shows as grey fog). Locks: `tests/unit/fxArtService.test.ts`, `Backdrop.test.ts`, the fx and backdrop cases in `tests/e2e/machined-art.spec.ts`. **Nebulae:** the galaxy's nebula sectors (`core/galaxy/nebulaField.ts` `nebulaDensity`) drawn by `NebulaVolume` behind (`nebBack`) and in front (`nebFront`, with a clear hole round the screen centre) of the world, plus star dimming and a grade sprite; `__eqxArtStats().backdrop.density` is the hook. (The C2 wisp grid it replaced is gone.) **Anything in the backdrop that must line up with GAME coordinates must flip Y: `cam.center` is Pixi space (`pixiY = -gameY`).** Landmarks don't care (pure scenery); nebula density does. Unit tests must pass `cam(x, -gameY)`. Locks: `Backdrop.sky.test.ts` (points off y = 0 in a sector whose cloud is lopsided, so a flip mistake fails) + the nebula cases in `machined-art.spec.ts`. **Speed effects (C3):** the backdrop eases the camera's own motion (`depth.ts` `stepSpeedFx`, ignores jumps > 6000 u/s and gaps > 250 ms), streaks the dust motes along it, and asks for a zoom-out (`speedZoom()`, up to 20 % at "large"); `PixiRenderer.update` hands that to `Camera.setSpeedZoom` every frame (1 while the backdrop is baking). **The Camera holds the DRAWN scale between ticks** (picking, `toScreen`, counter-scaling all read it) and the player's zoom inside each tick: `tick` takes the factor off, runs the old logic (`tickInner`), puts it back round the screen centre; pinch starts from `scale / speedApplied` and `setZoom` multiplies by it. Anything new that SETS the camera scale must do the same, or it bakes the speed factor into the player's zoom. `playerScale()` reads the player's zoom. Setting: `eqxSpeedFx` (`loadSpeedFxPreference`, default on, `?speedfx=`), carried to the worker as BOOT `speedFxOff`. Locks: `Camera.speedZoom.test.ts` (+ `.heapDelta`), the speed cases in `depth.test.ts` / `Backdrop.sky.test.ts`, `SettingsTab.art.test.tsx`, the C3 case in `machined-art.spec.ts`. **Engine exhaust:** `art/fx/FxEngines.ts` draws a flame + ribbon at every Machined nozzle for EVERY ship sprite with ship art (players by `thrustingShips`/`boostingShips`, `swarm-*` drones by speed; lingering hulls and scrap skipped), reading the sprite's resolved pose; `syncEngineContinuousEffects` skips the old `EngineEmitter` for any ship it drew (`drew(id)`), so a ship never gets both. `__eqxArtStats().fxEngines` (ships drawn, -1 = off) and `.engineParticles` are the hooks. Locks: `FxEngines.test.ts` (+ `.heapDelta`), `tests/e2e/fx-engines.spec.ts`. **Machined turrets (plan T1):** with new effects on (`ShipArtCtx.turrets`), hulls and decks with turret mounts bake with turret RINGS (`rings` job flag, `fields.ts` `stampTurretRing`), and `MountVisualManager` puts a baked gun (`turret` bake job, `forgeTurretGun`, lit by its own world rotation via `applySunBlend`) on a pivot at `art/turretLayout.ts`'s spot; today's bar draws until the gun is baked. `turretLayout` is the ONE place ring and gun are placed and sized, so they always line up; a fixed centre gun is a chin gun whose tip is today's muzzle point. Miner drills are not turrets. Rotation still has one path (`applyMountAngles`, invariant #12). Aim guides in the new look show only for the local ship's active-weapon mounts while a hostile is in range (`RenderMirror.localAimMountIds`, set by `ColyseusClient` in the fire block, so only while auto-fire is on or fire is held). Hook: `__eqxArtStats().turrets` (-1 = off). Locks: `MountVisualManager.machined.test.ts` (+ `.heapDelta`), `turretLayout.test.ts`, `tests/e2e/fx-turrets.spec.ts`. **Firing reactions (T2):** `PixiRenderer.noteTurretShots` feeds `MountVisualManager` from data already in the mirror (no wire change): held beams by mount id (`liveBeams`, `remoteLasers`), and every projectile / missile the frame it is FIRST seen (generation stamp), matched to its owner's nearest gun tip within 60 u (`noteShotNear`). The gun then recoils (`recoilAt`), flashes (the `muzzleFlash` fx flipbook) and heats (`heatAfter`); a held beam lights the emitter. Low / minimal quality drop the flash and heat, never the recoil. Shooter ids map to sprite keys as-is, structures as `swarm-<id>` (cached). Hook: `__eqxArtStats().turretShots`. **Muzzle points (T3):** every shot leaves the drawn barrel tip — `core/combat/muzzle.ts` is the ONE source for the server fire resolvers, structure turrets, `ColyseusClient.localMuzzle` (ghosts + live beam), the `PixiRenderer` remote-beam origins and `turretLayout` (`TurretPlace.muzzle`). Chin guns keep the old clearance. Turret sizes are capped (barrel ≤ 40 u) so capital hulls get turrets, not cannons. Never hardcode a 20 u muzzle again; `tests/unit/muzzleParity.test.ts` fails if a site stops calling the shared function. Locks: `MountVisualManager.reactions.test.ts`, the heap-delta lock, the firing case in `fx-turrets.spec.ts` (it warms the bakes on a first join: a hostile drone dies before a cold bake finishes). Story: docs/architecture/art-direction.md "Effects and backdrop".
- **The silhouette is the collider.** The forge never changes an outline (locked to within one texel). Size art from the drawn outline (`shipExtent`), never from `ShipKind.radius`.
