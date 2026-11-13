# On the shelf

Design work deliberately parked, to revisit. Each entry says what we found,
why it waits, and what doing it properly involves. Remove an entry in the PR
that picks it up.

## How violently a capital breaks: a weighted roll (parked 2026-11-13)

**Owner (2026-11-13), after the v3 break-up films** (both normal-speed takes of
one shot snapped cleanly in two): "It should take into account the factors I
said. Speed of damage, violence of last shot and whatever the third one was. So
a quick violent death breaks the ship more. But it's a dice roll regardless,
just weighted. So it's dynamic but informed by the situation. But this is too
much detail for this feature ... shelve this as a note to pick up later as
polish."

- **The rule (2026-11-12, [capital-destruction.md](architecture/capital-destruction.md) §6):**
  the piece count and the clean-snap chance follow hull size, the killing blow
  and the recent damage rate.
- **What to check when picking it up:** whether fracture v7 actually responds
  to those inputs as the owner means. A quick, violent death should break the
  ship into more chunks; a slow grind should usually leave a few big pieces.
  The clean snap (`FRACTURE_SNAP_CHANCE`, a flat 0.2 today) should be a
  weighted roll that a violent death makes rarer.
- **Film more than one seed:** the `capital-breakup` shot appears to land on
  the same fracture each run. Film a spread of kills, e.g. through
  `setWreckSeed`, so the owner judges the variety, not one roll.

## Capital damage model: zones, armour, systems (parked 2026-11-12)

**Owner (2026-11-12):** "keep the damage model as an idea for now", while the
ship splitting itself is built ([capital-destruction.md](architecture/capital-destruction.md)).
The owner's idea, given "with a pinch of salt":

- **Zones.** Hulls have zones/sections with armour that must be breached
  before internal systems take damage: engines, steering, turrets, fire
  control/sensors, gas stores.
- **Gas.** Gas powers teleportation; a breached gas store is a magazine hit.
- **Shape stays.** The collision shape never changes while the ship is alive.
- **Visible damage.** Damage shows through decals, venting, fire and system
  effects; repairs clear them.
- **Destruction is a sequence:**
  1. mission kill;
  2. crippled hulk (adrift, salvage);
  3. broken in two (midships);
  4. catastrophic (gas-store detonation, rare, damages nearby ships).
- **Wrecks.** Most capitals end as wrecks that become terrain (cover,
  blocking, salvage) rather than vanishing.

**Today:** a capital has one hull pool and one shield; it dies at 0 and
explodes. The fracture work (S1 onwards) gives it wreck pieces; it does not add
zones or systems.

**Why it waits:** it is a combat-balance pass on its own: per-zone armour and
HP, which weapons breach what, what each lost system does, and how the
client shows it (decals, vents, fire). Damage stats and balance are out of
scope for the fracture work.

**To revive:**
- Zones as hull-local regions; the section lines the fracture already accepts
  are a natural fit.
- A per-zone armour/HP record in the ship catalogue.
- Server hit resolution maps a hit point to a zone.
- System effects on the existing subsystems (thrust, turn rate, mounts,
  lock range).
- The destruction sequence drives which fracture runs (midships cut vs
  catastrophic).

## Friendly fire for every shot (STARTED 2026-11-10)

**Done (slice 1, owner decision 2026-11-10: "Fire hits all, but we need NPCs
to be aware of this and not fire when blocked ... For now I don't mind them
just being dumb and killing each other"):** every shot hits the first thing in
its path, the shooter's own side included: bolts, naval shells, NPC beams,
structure turret beams (its owner's own ship too), missiles, player shots. The
allegiances-P0 rule 6 pass-through is gone. Physical skips stay: a shot never
hits its own shooter, and a capital turret never fires along its own deck
(`mountLineClear`). An accidental hit from the victim's own side does its
damage but marks nothing hostile (`SectorRoom.isFriendlyFire`), so packs don't
civil-war. See docs/architecture/allegiances.md "Fire paths".

**Done (slice 2): NPCs hold fire when a friendly is in the way.** Before a
drone's slot fires, a capital turret fires or a structure turret fires, the
room checks the shot's line from the muzzle to the target for a FRIENDLY body
(`LineOfFireGate`, a per-tick broadphase); if one is there the gun holds this
tick, keeps aiming and keeps its lock. Players are never gated. A player's
turret holds on its owner's own ship and structures. Cost is gated as a COUNT
(`LINE_OF_FIRE_BUDGET`). See docs/architecture/allegiances.md "Line of fire".

**Still to do: formations.** NPCs now hold rather than shoot through an ally,
but a pack that flies in a clump still spends fire time holding. Escorts and
flocks need spacing that keeps them out of each other's lines of fire
(flocking separation radii, capital escort stations off the broadsides), and a
held drone could side-step to clear its line.

## Radar settings saved per account, and a radar settings window (dropped 2026-11-08)

**Was:** the last two steps of the ring-radar plan (`sparkling-wondering-rose`,
Wave 2): **PR 3b** stored radar settings per user, player and ship on the
server (a settings table, a `SettingsStore`, an `/auth/settings` route); **PR 4**
added a radar config window to edit them.

**Today:** the edge radar shipped (Wave 2 PR 2: `render/halo/edgeRadar.ts`,
settings shape in `shared-types/settings/radar.ts`, `tests/e2e/radar-sandbox.spec.ts`)
and the in-game id is bound to the account (PR 3a, #171). Settings use their
defaults; there is no per-account storage and no window.

**Why dropped (user, 2026-11-08):** the edge radar works as it is; the
settings plumbing wasn't worth building now.

**To revive:** PR 3b first (server table + store + route, client fetch at
login, defaults when absent), then PR 4 (MUI dialog over the settings shape,
live preview in the radar sandbox room). The plan file has the full design.

## Ship weapons using up ammunition (not now, 2026-11-08)

**Was:** economy v2 (`peppy-jumping-pinwheel`): ship missiles and autocannons
draw `munitions` from the ship's hold, the way base turrets already do.

**Today:** only base structures spend munitions: missile and autocannon
turrets (`SectorRoom` `takeMunition`) and the Mine Layer. Ship weapons fire
for free (energy only).

**Why not now (user, 2026-11-08):** leave ships free to fire; revisit with an
economy pass.

**To revive:** a per-weapon munition cost in `WeaponCatalogue`, a hold check
in the server fire path and the client's predicted fire gate (both sides,
invariant #15), an "out of ammo" HUD state, and how NPC ships resupply.

## Blind perf-threshold test (parked 2026-11-08)

**Was:** perf plan step P3b: serve the same scene 4 times with a hidden
slowdown (none / small / medium / large) in random order on desktop and
phone; the user rates each, and the levels they notice set the absolute
budgets.

**Today:** real-device readings exist (perf lab, `perf/ledger/devices/`), and
an unattended phone-class proxy (`pnpm perf:scenes --device phone-proxy`).
Absolute budgets are set from measured ledgers instead.

**Why parked (2026-11-08):** it needs the user to rate clips by hand, and the
user asked for no more manual tests.

**To revive:** a hidden-slowdown switch in the perf lab (`perfburn` already
injects client cost), a rating page that records answers, and budgets derived
from the noticed levels.

## Freeing the CPU copy of finished atlas pages (from PR #330, 2026-11-08)

**Was:** PR #330 freed a sealed atlas page's packing canvas once its texture
was on the GPU (one tab 1.45 GB → 1.02 GB on the old shelf packer).

**Today:** pages pack first-fit across a sector visit's group (skyline,
#341) and are freed per visit (#339), so no page is "sealed": any page can
still receive frames, and a freed canvas could be written to again. #330
was closed as superseded.

**To revive:** mark a page full when the skyline can't take the smallest
common frame, then release its canvas (or a data page's byte buffer) after
the first upload, with texture GC off for it; handle WebGL context loss
(re-bake from the bake cache). Folded into the GPU-lit heap follow-up.
