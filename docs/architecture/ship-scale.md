# Ship scale — one model for every size-dependent number

**Status:** R&D on `rnd/ship-scale` (plan `iridescent-seeking-rainbow`, ship-scale section). The default is 1×, which plays exactly like the old game.

## Why

Ships were too small to carry detail (turret R&D, 2026-11). Making them bigger
showed the real problem: about a dozen numbers depend on a ship's size but were
fixed constants, among them the muzzle clearance 20, the missile hit radius 12,
the shield pad 10, loot pickup 80, spawn clearance 120, flocking 220/150 and
the bake texture cap. Scale a hull without them and shots spawn inside it,
missiles pass through it, and ships spawn on top of each other. Capital ships,
which come next, will be many times bigger again, so this is infrastructure:
size is a knob, and the tests stop size bugs at any value.

## The model (`src/shared-types/shipScale/`)

| File | What |
|---|---|
| `config.ts` | `SHIP_SCALE` + `SHIP_TUNING` (combat profile A/B), read once at module load, the same way in every context. `AT_AUTHORED_SHIP_SCALE` gates tests that lock 1× sizes. |
| `tuning.ts` | `scaleShipKind` (geometry + motion), `shipTuning(kind)` (every other size-dependent number), `CLASS_TUNING` (per size class), `MOUNT_SIZE_TUNING`, `combatDistanceScale`, `startZoomForScale`. |
| `defineShipKind.ts` | What every catalogue family file calls instead of `ShipKindSchema.parse`: parse, then scale by `effectiveScale(kind)` = `SHIP_SCALE × sizeScale`. Engineering-only kinds stay at 1×. |
| `lookup.ts` | `tuningFor(id)` / `GLOBAL_SHIP_TUNING` for sites that only have a kind id, or none. |

**The rule:** a size-dependent number comes from `shipTuning`, never a constant.
At scale 1 every derived value equals the old constant exactly.

### How the scale reaches every context

- **Server and tests:** env `EQX_SHIP_SCALE` / `EQX_SHIP_TUNING`.
- **Page:** `?shipScale=` / `?shipTuning=`. An inline script in `index.html`
  sets `globalThis.__EQX_SHIP_SCALE__` before any module loads.
- **Workers (renderer, bake):** the worker `name`
  (`shipScaleWorkerName()`), which can be read at module load.
- **Join check:** the welcome carries `shipScale`/`shipTuning` only when they
  aren't the defaults. A client at another scale logs `ship_scale_mismatch`.
  Mixed scales would desync physics, because the catalogue is built from the
  local config.
- **Bake keys:** they get an `@s{scale}` tag when the scale isn't 1, so cached
  1× textures are never reused at 2×.

### Motion follows size

"Motion not depending on size is a smell": a bigger hull is heavier, and its
engines are bigger to move it. `motionFactors(s, engines)`:

- mass ∝ s³ (volume). `massOf(kind, fallback)` is the one place mass is read
  (World, the drone client leaf, SwarmSpawner, SectorRoom);
- thrust ∝ s² × engines (nozzle area × count; an authored `thrusters` count
  and size set `engines`, the default is 1);
- linear accel = thrust / mass ⇒ top speed ∝ accel^0.5;
- turn rate = (torque / inertia)^0.5;
- linear damping is scaled by accel / speed, so the terminal speed lands on the
  speed factor (otherwise damping, not engines, sets it).

So at 2× with stock engines a ship is slower to accelerate and turn. A capital
with 8 big thrusters can still move. The exponents live in `MOTION`.

### Size classes

`sizeClass` (`fighter | frigate | cruiser | capital`) selects a `CLASS_TUNING`
row:

- **Fighters, frigates and cruisers:** the multipliers are 1, so they follow the
  ship scale alone.
- **Capitals:**
  - doubled geometry (turrets, nozzles, muzzle);
  - doubled spacing (spawn, pickup, flocking);
  - a 1024 bake cap and L mounts;
  - `clearHull`, so every clearance also reaches past the hull: muzzle ≥ r × 1.05,
    spawn ≥ r × 2, flock separation ≥ r × 2.2, follow distance ≥ r × 3.3,
    pickup ≥ r × 1.3.

  A fighter-relative rule alone would put a 600 u capital's chin gun inside its hull.

### Combat profiles

- **A — the world as is:** weapon ranges and splash unchanged. Only ship-bound
  numbers follow the ships.
- **B — scaled combat:** reach × (1 + (s − 1) / 2), splash × s, applied in
  `WeaponCatalogue` (`scaleWeaponDef`).
- **Naval guns are exempt from both.** Capital hulls are built unscaled, so the
  `naval_*` guns are authored in absolute units
  (`shared-types/combat/navalGuns.ts`, the shipped 2× B numbers) and read the
  same under every profile and scale. Lock: `tests/unit/navalGunsAbsolute.test.ts`.

### Camera

The world isn't scaled, so the zoom-out floor (0.15) still frames the same
space and the starfield coverage rule holds. The start zoom is
`base / s^0.5`: at 2× ships draw about 1.4× bigger on screen while the spawn
view still shows more space.

**Zoom-in cap: the whole hull fits (owner decision 2026-11-12).** "You can't
zoom in past the point where your whole hull fits on screen." The cap is
`zoomCeilingForView(kind, viewW, viewH, floor)` =
`min(3, (min(viewW, viewH) / 2) / (radius × 1.05))`, never below the zoom-out
floor; `zoomRangeForKind` returns it as `maxScale` and clamps the start zoom to
it. `PixiRenderer.applyZoomCap` pushes it to `Camera.setMaxScale` on a ship
change, on every resize and on leaving spectator. A lowered cap eases the
current zoom down through the wheel-zoom ease round the screen centre (no
snap). Fighters keep 3 on every ordinary screen; a battleship (radius
~2,876 u) caps at ~0.18 on 1920×1080, about 1/17 of a fighter's, and on a
390-px phone its start zoom drops to the cap. Spectator (possibly no ship)
keeps 3, the galaxy map's camera is a separate instance, and the cinematic
director keeps the constructor's limit of 3. Why: the follow camera has no
look-ahead and the hull is balanced fore and aft, so the "stern slides off the
screen" report was the flat cap of 3 letting a capital's hull overflow the
view. Lock: `tests/unit/hullZoomCeiling.test.ts`.

## Tests

- `tests/unit/shipScaleInvariants.test.ts` builds every kind at 1/2/4× plus a
  synthetic capital (radius 600, 8 thrusters) and checks:
  - muzzles clear the hull (chin-gun kinds; four drone kinds are known
    exceptions, listed by name);
  - spawn, flock and pickup reach past the hull;
  - mass, thrust, turn and terminal speed follow the motion model;
  - gates fit a playable class;
  - the camera start zoom stays above the floor.
- `muzzleParity.test.ts` locks every fire site, server and client, to the
  shared muzzle (no hardcoded `?? 16|20`).
- Tests that lock authored 1× numbers use
  `describe.runIf(AT_AUTHORED_SHIP_SCALE)`; the sweep covers other scales. Run
  the suite at another scale with `EQX_SHIP_SCALE=4 pnpm test`. The default is
  2× B, so `pnpm test` skips the authored-1× locks; `pnpm test:authored-scale`
  (also a CI step) runs them at 1×, profile A.

## Filming another scale

`EQX_SHIP_SCALE=2 EQX_SHIP_TUNING=B pnpm showcase --shot pack-battle --out showcase-out/2b`.
The capture servers inherit the env, and the recorder adds the matching URL
params.

## Not done yet

- **Mount size:** `MOUNT_SIZE_TUNING` (S/M/L/XL) and `mountSizeOf` exist, but
  nothing in the fire paths reads them yet. That's planned for the capital-ship
  plan, where L/XL batteries first appear.
- **Gameplay values:** the shipping default is **2× B** (picked 2026-11-05
  from the comparison footage). Per-class tuning for capitals comes with the
  capital-ship plan.
