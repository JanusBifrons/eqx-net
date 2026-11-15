# Capital ships

Capital ships are the galaxy's warships: destroyers, light and heavy cruisers, battlecruisers and battleships, kilometres long, with turreted naval guns. They are NPC-only (`npcOnly`); players fight them and their escorts. The design, hull styles and combat rules are in `docs/architecture/` (capital-ship R&D); this page is the player-facing story and grows as wrap-up step W2 lands.

## Flagship fleets (wrap-up W2a)

Somewhere in the galaxy there is always a **flagship fleet**: one capital ship with an escort of two destroyers and four gunships.

- **Where it is.** The galaxy map shows it: hovering a system or opening its drawer reads "⚓ Capital sighted: the Battleship Warspite". A notice goes out when a new fleet arrives and when a flagship is destroyed.
- **How it moves.** It holds a pocket of a solar-system sector for a few minutes, then the whole fleet spools up and warps to another pocket together, the capital's slow turn making its spool the long one. Every third move it heads for a gate and crosses into a neighbouring system, arriving at that system's gate facing back. A fleet always arrives in a new system through a gate.
- **How strong it is.** The capital's class follows the sector's power: a power's heartland fields battleships and battlecruisers, neutral ground cruisers. The flagship is named, carries half again its class's hull, and a bounty for whoever sinks it.
- **Escorts** hold stations round the flagship, outside its hull, turning with its heading. When the flagship is destroyed the escorts break off and jump out, and a new fleet arrives elsewhere about fifteen minutes later.
- **It's neutral until provoked**, like other drone-side ships: fire on it and it fights back.
- **Never load-shed.** The flagship is an elite and the escorts are exempt, so a busy server never quietly removes them.
- **It survives a restart**, at the pocket it was in, with the same name and class.

### How it works

- `FlagshipDirector` (`src/server/livingworld/`) runs on the drone director's control tick (~1.5 s), never the 60 Hz loop.
- Ids start `flagship-` (`isDirectorBotId`). Moves use the NPC warp (`SectorRoom.warpBot`, see [warp-to](warp-to.md)), which lands clear of rocks and ships. Escort stations are `escortRing(capital, escort)`: both hulls' radii plus a fifth of the capital's.
- The map reads `SectorLiveState.capital` (snapshot, #16); notices are accelerators.
- Persisted in `allegiance_director_state`, row `flagships`. Kill switch: `EQX_DISABLE_FLAGSHIPS=1`.
- Locks: `FlagshipDirector.test.ts`, `LoadShedder.test.ts`, `tests/integration/sectorRoom/flagshipFleet.test.ts`, `galaxyTooltip.test.ts`.

## Hull styles (wrap-up W2b)

Every capital class comes in three hull styles: A (Iowa line), B and C (user, 2026-11-08: keep all three for variety). Each ship in a fleet gets its own style, seeded from its id (`styledKind`), so a fleet never looks cloned and a ship keeps its look across a restart. Styles are separate kinds appended to the catalogue (`<class>-b`, `<class>-c`; the user chose this over threading a style through every system), so the collider, turrets, art, wrecks and the wire all work through the ordinary kind path. `?capStyle=` / `EQX_CAPITAL_STYLE` still sets the base kinds' style for R&D. Locks: `capitalShips.test.ts` (the variants are their class in another hull), `FlagshipDirector.test.ts` (`styledKind`).

## Helm orders and the move marker

Flying a capital, tap empty space and the helm sets a course there (`core/helm/helm.ts`; WASD or the stick cancels it). A green RTS-style move marker sits on the course point so you can see where you tapped (owner, 2026-11-12): a ring with a centre dot and four inward chevrons, in `#3ddc84`. Each new tap pops it (it starts 1.7× and fully bright, eases to its steady size in 0.32 s, and a ring ripples out and fades); then it holds steady at 75 % opacity until the ship arrives, the course is cancelled, or you switch to spectator.

- Only the pilot sees it, only for their own capital under an active order: the order lives in `ColyseusClient`, and `helm/helmCourseMark.ts` decides visibility. The point rides `RenderMirror.helmCourse` to the renderer (spatial, so never Zustand, #2), so both render paths draw it.
- `render/helm/HelmCourseMarker.ts` draws it in screen space, so it keeps one pixel size at any zoom (capitals zoom far out). Painted once; per frame only position, scale and alpha change (#14). Hidden during a trip.
- Locks: `helmCourseMark.test.ts`, `HelmCourseMarker.test.ts`, `tests/e2e/capital-helm.spec.ts` (shown after a tap, gone after W, read via `__eqxArtStats().helmMarker`).

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

### Helm move marker

- The capital pilot's helm course point reaches the renderer as `RenderMirror.helmCourse` (`{x, y, seq}` or null), written by `ColyseusClient.syncHelmMark` via the pure `helm/helmCourseMark.ts` (own capital + active order + not spectating). Never put it in Zustand (#2). `render/helm/HelmCourseMarker.ts` draws it screen-space (fixed pixel size), popping on each `seq` change. E2E reads `__eqxArtStats().helmMarker`. Story: `docs/features/capital-ships.md`.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Flagship fleets (wrap-up W2a, 2026-11-08)

- **`FlagshipDirector`** (`livingworld/`) is ticked on the drone director's `onTick`. It keeps `FLEET_COUNT` capital fleets: an elite-marked flagship plus escorts with `flagship-` ids, which `LoadShedder` never sheds.
- **Moving.** Fleets move pocket to pocket with `SectorRoom.warpBot`, the NPC warp: `World.botWarp` → `BOT_WARP` → `drones[].warp`. They cross systems by gate.
- **Escort stations come from hull radii** (`escortRing`), never a flock distance: fighter-scale flocking rammed escorts into a battleship's hull.
- **`warpBot` lands at `landingPoint`.** A drop inside a belt rock killed an escort, so the bot lands at the nearest clear spot, like a pilot.
- **The map's truth is `SectorLiveState.capital`.** Persisted as `allegiance_director_state` row `flagships`; kill switch `EQX_DISABLE_FLAGSHIPS`.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](../architecture/server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Capital combat (plan prancy-squishing-donut Phase 3)**:
  - **Guns:** capital mounts fire the naval guns `naval_s|m|l|xl` (bound by mount size in `warshipDesign.ts`; ratios in the catalogue comment).
  - **Reach:** turret target pick for capitals uses `mountTargetReach` (`core/combat/mountReach.ts`: longest gun reach + mount offset). Every other kind keeps `HITSCAN_RANGE`. The server player path, the drone path and the client's `tickLocalMountAim` all call it (#15).
  - **Fire control:** capitals never fire as a hull-aimed salvo (`AiFireResolver.resolve` returns early). `WeaponMountTicker.tickDrone` leads the target per mount with that gun's shell speed, and fires a mount (`fireDroneMount` → `AiFireResolver.fireMount`) only when it is reloaded (`droneMountReload`), the target is within that gun's reach, and the barrel is within `TURRET_FIRE_TOLERANCE` of the lead bearing.
  - **Salvos:** a naval turret fires one shell per barrel, each from its drawn barrel tip (`navalBarrelOffset`, `NAVAL_BARREL_SPAN` shared with the bake, #15).
  - **AI:** `HostileDroneBehaviour` broadside mode (`BROADSIDE_STANDOFF` 0.75 of main reach). It holds station (thrust only to correct range) and, out of reach, turns before it thrusts ahead: a capital that thrusts while facing away steams out of its own guns' reach. With the target abaft the beam it backs its engines at its own `reverseFactor` instead, so a hull that aggroed under way stops opening the range at once and backs in while the bow comes round (2026-11-12: a coasting battleship lost its target in the duel room; lock `tests/integration/sectorRoom/capitalClosesRange.test.ts`). **Guard posts (owner decision 2026-11-11, "It should stay close to the thing it's defending, obviously"):** a capital given a post (`room.setBotGuardPost` → `HostileDroneBehaviour.setGuardPost(x, y, r)`, radius at least `shipTuning(kind).guardRadiusMin`) does NOT hold the stand-off: it keeps station at the post (beam to the target in reach) and never leaves its guard radius to hold range or chase a target out of reach. `FlagshipDirector` posts the flagship on the pocket it holds, refreshed each control tick (a warp moves the post). Its escorts guard round the FLAGSHIP (owner 2026-11-15: "Leash, but the zone follows the flagship"): each escort's post is anchored to the flagship (`setBotGuardPost(…, anchorId)`), radius `escortRing + pocket r` (a pocket radius past its station), so the zone moves with the flagship and an idle escort returns to it. No special "attackers of the flagship" rule: who is hostile stays the allegiance stance, retaliation ledger and faction escalation. Only unposted capitals (showcase duels, scripted scenes) keep the stand-off. A director that spawns a capital to defend something must post it. Lock: `HostileDroneBehaviour.guard.test.ts`, `FlagshipDirector.test.ts`.
  - **Turrets:** near-real traverse (16" 4°/s … 5" 15°/s), main arcs ±135°, main stations spaced so gunhouses never touch (`spaceStations`).
  - **Targeting (review 2026-11-07, user design):** every capital turret picks its OWN target (`WeaponMountTicker.tickCapitalMounts`, rules in `core/combat/mountTargeting.ts`). A soft priority list, never a ban: mains prefer capitals, 5" secondaries prefer sub-capitals and small capitals, quad AA (`size: 'AA'`, 4 barrels firing in turn, laser bolts) prefers small craft. A turret takes only a target it can engage: in reach, in arc, a clear line of fire (the hull fire mask: guns fire outwards, never down their own deck) and slow enough across its sights to TRACK (`canTrack`: bearing rate ≤ 0.8 × traverse). So slow main guns leave a darting fighter to the AA. Sticky: a turret re-checks only its own target each tick, holds it through a brief loss (`TARGET_HOLD_TICKS`), and searches only when it has none, every `RETARGET_TICKS`, staggered. Fires only within `TURRET_FIRE_MISS` of the aim point. Targeting only: shells hit whatever they meet.
  - **Reloads** are the real ones (16" 30 s … 5" 4 s), damage scaled to match.
  - **Seen from afar:** a capital is a WIDE interest entity, so its shells must be too. Projectiles outside the viewer's box still ride the snapshot when their owner is wide and in the viewer's interest. The spawner passes the radius to `SpatialGrid.insert` (before this, spawned capitals were never marked wide).
  - **Naval shells travel ONLY as events (shells as events, slices 1–4; no switch since 2026-11-12):** every room builds a `ShellEventHub`, driven by `ProjectilePipeline`'s `onShell*` hooks and flushed once per `update()` after the fire passes. A naval shell (s/m/l/xl/xxl/siege) reaches a viewer as one `shell_salvo` when fired and one `shell_end` on a hit, plus `shellsInFlight` on the welcome and a `shellKey` keyframe on the snapshot; it NEVER rides `projectiles[]` (sub-capital projectiles keep the ±3,072 u box + wide-owner rule). Every naval shell is quantised at spawn and follows the closed form on the WORKER tick. The hub's viewer rule sizes the view with `shellViewHalfExtent(viewer's ship kind)` (shared-types `tuning.ts`: half a 1920-px view at the hull zoom-out floor: fighter 6,400 u, destroyer ~13,000 u, battleship ~30,700 u; in `real` mode a fixed reach × `GUN_VIEW_MARGIN` × `MAX_VIEW_ASPECT` 2.4, battleship ~102,000 u; #15 with the client zoom floor). Route new viewer rules through the hub, never a second scan. Measured: `naval-broadside` perf scene, rx per pilot 254 → 67 KB/s. Story: [docs/architecture/shell-events.md](../architecture/shell-events.md). Locks: `ShellEventHub.test.ts`, `ProjectilePipeline.shellEvents.test.ts`, `SnapshotBroadcaster.navalShells.test.ts`, `tests/integration/sectorRoom/shellEvents.test.ts`.
  - **Far drones' slim slice (2026-11-12):** `drones[]` also carries drones OUTSIDE the recipient's interest, with only `hostile` / `hp`, when either is non-default, on one recipient snapshot in `FAR_DRONE_SLICE_EVERY` (2 Hz; the window is `broadcastCounter % 30 < 3`, and each recipient gets exactly one broadcast per 3 counters). It walks `swarmRegistry.forEachRecord` with the bound `_visitFarDrone` (alloc-free, #14); a fake without `forEachRecord` has no far tier. Hp% for both tiers comes from `droneHpPct`. Locks: `SnapshotBroadcaster.farDrones.test.ts`, `hostilityOnSnapshot.test.ts`.
  - **Real-scale naval ranges (slice 14, switch):** `EQX_NAVAL_RANGE=real` (default `legacy`) gives every `naval_*` gun its real range as its ENGAGE reach (16" 38,700 u … Lindemann 56,000 u) and flight real ÷ 3 (`shared-types/combat/navalGuns.ts`); the shell's `maxTicks` is flight-to-reach ÷ 0.85. Read once per PROCESS (catalogue built at load), never per room. The server stamps it on every welcome (`stampNavalRange` in `withShipScale`); the client must run `?navalRange=real` or logs `naval_range_mismatch` (#15). Integration tests that need it live in `tests/integration/navalReal/` and run via `pnpm test:naval-real` (own config: the shared integration worker can't flip it). Story + follow-ups: [docs/architecture/real-scale-ranges.md](../architecture/real-scale-ranges.md).
  - **Projectile owner on the wire:** a drone shooter is sent as `swarm-<entityId>` (`SnapshotBroadcaster.wireOwnerId`) so the renderer can match a shot to its gun (recoil + muzzle flash). Internally `ownerId` stays the drone id (hit attribution, self-skip).
  - **Threshold:** turret tick ≈ 2.4 µs per battleship per tick (`benchmarks/capital-mounts.bench.ts`: 8 battleships × 4 pilots = 0.02 ms); budget 10 µs per capital.
  - 🔴 netgate. Locks: `tests/unit/capitalCombat.test.ts`, `tests/integration/sectorRoom/capitalEngagement.test.ts`.

### Server rules in full (moved from src/server/CLAUDE.md)

The zone `CLAUDE.md` keeps a condensed form of these rules; this is the full wording with its lock tests.

**Capital combat** ([capital-ships](../../docs/features/capital-ships.md), [shell-events](../../docs/architecture/shell-events.md), [real-scale-ranges](../../docs/architecture/real-scale-ranges.md)):
- 🔴 Capitals never fire as a hull-aimed salvo; each mount leads its own target and fires only when reloaded, in reach and on bearing. Each turret picks its own target (`mountTargeting.ts`); targeting only, shells hit whatever they meet.
- Turret reach comes from `mountTargetReach` on the server player, drone and client aim paths (#15). A capital given a guard post keeps station inside its radius; a director that spawns a defending capital posts it.
- Naval shells travel only as `ShellEventHub` events, never in `projectiles[]`; route new viewer rules through the hub. A capital and its shells are WIDE interest entities.
- `EQX_NAVAL_RANGE` is read once per process; the server stamps it on the welcome (`stampNavalRange`). Far drones' slim slice and the drone `swarm-<id>` wire owner are snapshot-only views.
- Locks: `tests/unit/capitalCombat.test.ts`, `tests/integration/sectorRoom/capitalEngagement.test.ts`.

## Weapon fits (plan section 9)

A `fit` axis sits next to the hull style: `warshipDesign(id, style, map, fit)` with `fit = { main, secondary }` (default `NAVAL_FIT`, all naval guns, so the plain kinds are unchanged). A fit changes only the mounts' `weaponId`; the hull, turret stations and groups stay the class's. Fitted kinds are appended to the catalogue like the styles, ids per the scheme below. The first is the **rail battleship** (`battleship-rail`: railguns in every main turret, naval secondaries and AA, base hull style). It sits in `CAPITAL_STYLE_VARIANTS.battleship`, so `styledKind` fields it for one battleship in four, seeded from the ship's id like a style. The railgun's charge (`chargeTicks`, 'when-bearing', 'mount-glow') lives in its weapon def, so a railgun mount needs nothing extra beyond its single barrel (`barrels: 1`, one slug per shot) ([weapon-mounts](../architecture/weapon-mounts.md#charge-up-one-store-one-telegraph)). Beam fits put the capital `heavy_beam` on a battery, one emitter per turret (`barrels: 1`: the AI fire path shoots one ray per barrel and the heavy beam's numbers are per mount). The **beam cruiser** (`heavy-cruiser-beam`: heavy beams on all six secondaries, naval 8" main) and the **lance battlecruiser** (`battlecruiser-lance`: heavy beams in the three main turrets, naval 5" secondaries) follow the rail battleship in the catalogue and in their classes' `CAPITAL_STYLE_VARIANTS`, so each is fielded for one ship in four of its class.

**Id scheme:** `<class>[-b|-c][-<main fit>][-<secondary fit>]`; the main-battery suffix names its weapon (`-rail` railguns, `-lance` heavy beams), the secondary one `-beam` (heavy beams). So `-beam` always means beam secondaries and `-lance` a beam main battery. `classOf` strips all three.

**Fire path:** a beam turret needs nothing new. It fires through the ordinary capital per-turret fire control (`WeaponMountTicker` → `AiFireResolver.fireMount` → the hitscan sink → `laser_fired`, `hitscan` lead 0); the kill reaches the wreck with `weaponId: 'heavy_beam'`, so it slices. No AI energy gating yet (separate stream).

Locks: `capitalShips.test.ts` (fit mounts, one emitter per beam turret, catalogue order), `FlagshipDirector.test.ts` (`styledKind`, `classOf`), `tests/integration/sectorRoom/beamFits.test.ts` (a spawned beam cruiser's secondaries fire `laser_fired` and its kill slices; a lance battlecruiser's main turrets fire).
