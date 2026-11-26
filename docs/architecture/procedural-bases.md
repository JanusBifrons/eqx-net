# Procedural bases

> Plan: `soft-leaping-truffle`. Bases are built from **real structures**: the
> same Capital, connectors, power, processors, storage, turrets and shield
> fence a player builds, following the same rules.

## How a base is made

1. **Profile.** `src/core/bases/baseProfile.ts` turns a galaxy sector into a
   `BaseProfile`: tier (outpost → citadel), role in the production chain
   (mining, refinery, workshop, manufactory, assembly works, trade hub), wealth,
   level cap and whether it is fenced. Where the sector sits drives all of it:
   its region, how far it is from the region's heart, its features, and
   whether it is an edge sector.
2. **Growth.** `src/core/bases/growBase.ts` spends the profile's wealth the way
   a builder would. It lays connector rows and adds the role's processors and
   extractors, then power for their expected draw, storage, turrets and a fence
   with a gate per side. Every placement and every link passes the real
   `placementRejection` / `canConnect` as it is built.
3. **Seeding.** `src/server/bases/NpcBaseSubsystem.ts` places the result in a
   live room through the normal placement path (`skipAutoConnect`, then
   explicit edges). Every galaxy sector seeds its own base this way (T1:
   `seedGalaxyBase` (`bases/NpcBaseSubsystem.ts`) picks a site with `chooseBaseSite`, after the
   snapshot restore, and spawns are nudged out of structures). It builds everything at its level, loads recipes and bound
   blueprints, opens the gates for anyone not hostile, and stocks fuel,
   munitions and inputs.

After that, nothing is special about the base. Power, batteries, the fence,
turrets, production and destruction all run through the systems players use.
NPC structures are not persisted; a restart regenerates the base from its seed
(`BASE_GROWTH_VERSION` pins the output).

Full story of the roles, the chain and the generator:
[production-chains.md](production-chains.md). Network and wire costs at base
scale: [structure-network-scale.md](structure-network-scale.md) and the budgets
in `src/shared-types/structureBudgets.ts`.

## Test and showcase rooms

`npc-base-outpost` (mining), `npc-base-settlement` (refinery),
`npc-base-stronghold` (manufactory) and `npc-base-citadel` (assembly works).
Each has `filterBy(testId)`, and the pilot spawns south of the fence. Lock:
`tests/integration/sectorRoom/npcBases.test.ts`. Showcase shot:
`showcase/shots/proceduralBase.ts`.

## Deck gate approach lights (on by default; `?approach=off` hides them)

Outside every deck fence gate (`shield_gate` on a seam, its road running along
the gate's local ±y) runway lights run out along the road, like the lights off
the end of an airfield. A white centre row of 10 lamps runs down the road's
middle; red and green rows of 5 sit on the road's exact edges (±175, the road's
half width), red on the inbound pilot's left, green on the right. The outside is
the seam side whose hex is on no floored plate; a gate with plates on both
sides (or neither) gets none, and a run that would reach another deck stops
short of it (no lamp on a plate). The lamps are small and dim; a soft white pulse
(the "rabbit") walks down the centre row toward the gate every 1.5 s of effect
time (`fxNow`). Render only, part of the deck floor layer:
`StructureDeckPlates` owns a `DeckApproachLights`
(`src/client/render/pixi/deckApproachLights.ts`), noted per structure by the
swarm updater like the zone paint. Each gate's Container is built once and
re-placed only when its pose or the plate set changes; a frame writes only the
flash alphas of on-screen gates. Z band: over road tiles, under rig pads.
On by default on both renderer paths (BOOT carries the flag to the worker);
`?approach=off` turns them off. See them in `?room=deck-bases`: each base
has at least two gates.

## Fence run (placing a deck fence by its corners)

With the fence post (`shield_pylon`) picked in a deck room, each Place snaps
to the nearest hex corner and puts a post there if it has none (an existing
post is reused, so 3 clicks make 2 edges). From the second click on, the game
fills a post on every corner along the shortest run of plated hex edges from
the previous click's corner; inner edges count, not just the rim. A fence may
cross a road (it blocks it; `deckFenceRoad.test.ts`).

- **Path:** `core/hex/deckCornerGraph.ts` is only a `SearchGraph` adapter over
  the plate corners (edges where `isDeckSeam` holds); the search is the nav
  `GraphSearch`.
- **Wire:** nothing new. The client (`client/structures/fenceRun.ts`, routed
  from `commitPlacement`) sends one ordinary `place_structure` per missing
  corner via `placeStructureAt`; the server's `autoConnectStructure` makes the
  `DECK_LINK_SEAM_FENCE` beams.
- **Refusals:** the first corner the ghost's own rule (`PlacementGhostVerdict`)
  refuses is still sent, so the server's `lastRefusal` notice says why, and the
  run stops there. No rollback. Rocks are not in the client check: a corner on
  a rock is refused by the server while later corners still go.
- **Preview:** the sent corners ride the one pending record
  (`PendingPlacement.sent` / `run`, `pendingPlacementRun.ts`) into
  `pendingPlacementPreview.run`, drawn by `drawPendingRun` inside
  `drawPlacementPreview` until all of the run's posts land (or the pending
  timeout).
- **Ends** on Cancel (right-click, ✕) or any change of `placementKind`.

See it in `?room=deck`: pick Shield Pylon and click hex corners of the empty
west hex (centre (-1300, 0)), e.g. (-650, 375) then (-1950, 375): the post at
(-1300, 751) between them is filled.

## History: Tier A static geometry (retired in phase E)

The first pass generated **inert scenery**: warehouse walls, racks and
buildings from a seed (`src/core/procgen/`). They were drawn by a dedicated
`BaseRenderer`, given union-outline colliders in the physics worker and the
client prediction world, and could be destroyed piece by piece. The user's
verdict was that it missed the point: "Where are the connectors? Where are the
power generators? Where is the capital? All structures should be part of a
network and function the same way, not purely visual."

Phase E deleted all of it:
- **Core and server.** The generator, archetypes, `BaseSubsystem`, the
  `SPAWN_BASE` / `SET_BASE_DEAD` worker commands, the base-chunk colliders in
  `World`, and the `bases` room-state schema.
- **Client.** The `setBases` renderer seam, the client chunk streamer, and the
  base renderer and visuals.
- **Tests, rooms and tooling.** The budget file and its tests, the
  `base-warehouse-*` rooms, and their E2Es and cinematics.

The generic seeded RNG moved to `src/core/random/rng.ts`.

Measurements from that work that still hold:
- **Static colliders are not free.** 25 moving ships among 8,000 per-piece
  colliders cost 1.2 ms per step and 27 ms per 20-tick prediction replay. One
  collider per chunk cost 0.14 / 2.5 ms. Phones are ~4× slower, so keep static
  collider counts low, which is why structures stream into the prediction world
  by distance (`PREDWORLD_STRUCTURE_RADIUS`).
- **Soft CCD stops tunnelling** (`SOFT_CCD_PREDICTION = 48` on every dynamic
  body): zero pass-throughs on 16 u walls for ≤ 0.06 ms per step. Full CCD
  breaks the static-overlap contact events, so don't switch to it (see
  `src/core/CLAUDE.md`).
- **Seams snag.** Adjacent separate colliders catch a sliding ship at the
  seams; a single outline per chunk slid at the damping-only floor.
- **The perf baseline harness had two bugs**, both fixed: it parsed a server
  tick field that doesn't exist, and it sampled client frames from a diag-only
  ring that is empty on the production path. Both are now hard preconditions.

The design research behind the original plan is kept in
[procedural-bases-research.md](procedural-bases-research.md).

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

- **Seeding:** the `npcBases` room option → `seedNpcBases` → `NpcBaseSubsystem.seed`.
- **Place and link:** placements go through `structurePlacement.place(…, { skipAutoConnect: true, rot })`, edges through `connectExplicit`. Never auto-connect a generated base, because it would close gates and link the wrong things.
- **Built and set up:** structures spawn built at their level. Processors get recipes and BOUND originals (`rec.blueprint.bound`, which `unloadBlueprint` refuses). Gates open for anyone not hostile.
- **Stocked:** storage starts with an hour of fuel, munitions, and 20 cycles of inputs.
- **Not persisted:** NPC structures aren't saved (B2); a restart regenerates them from the seed.
- **Galaxy sectors (T1):** `galaxyBases` (set by `resolveSectorConfig`) → `seedGalaxyBase`, run AFTER `hydrateFromSnapshot`.
  - **Order matters.** Seeding before the restore would make saved player structures fail their overlap check and be lost. Keep it after.
  - **Site.** The site comes from `chooseBaseSite`: player structures and parked hulls are hard blockers. Asteroids under the footprint are evicted quietly. In a deck room the footprint is the base's whole plate extent (`deckExtent`) and the site is a plate centre (`deck` option). A base whose pocket is a cut field's clearing (`galaxyBaseClearing`) grows dense (all 6 outer hexes per plate), so it is sited by its smaller dense deck and clears less rock.
  - **Spawns** are nudged out of every structure box (`nearestClearPoint` in `onJoin`).
  - **Several bases:** `galaxyBasePlan` gives a sector one to three bases (each its own owner, a different role, big bases alone, within `NPC_STRUCTURES_PER_SECTOR_MAX`), each seeded with `NPC_BASE_GAP` from the earlier ones. A base that finds no site is skipped and logged.
  - **Kill switch:** `EQX_DISABLE_NPC_BASES=1`. Lock: `galaxyBases.test.ts`.

### Server rules in full (moved from src/server/CLAUDE.md)

The zone `CLAUDE.md` keeps a condensed form of these rules; this is the full wording with its lock tests.

#### NPC bases, convoys and transit links

- **Order:** galaxy bases seed AFTER `hydrateFromSnapshot`, and alien gates AFTER the bases; keep it. NPC structures are not persisted (regenerated from the seed). Kill switches `EQX_DISABLE_NPC_BASES=1`, `EQX_DISABLE_CONVOYS`. Lock: `galaxyBases.test.ts`.
- **Convoys:** `ConvoyDirector` runs on its 1 s unref'd loop, never the 60 Hz tick; every value move is ONE `tradeTransfer`; every trade quote goes through `TradeDirector.quote(kind, good, rep, sectorKey)`.
- **Link teleporters** pair at run time through `findLinkTwin`, never by position; NPC-owned teleporters refuse pairing requests. Military bases' gates are owner + allies; patrol ids start `patrol-` (in `isDirectorBotId`). Lock: `transitHubs.test.ts`.
- Detail: [procedural-bases.md](../../docs/architecture/procedural-bases.md#server-implementation-notes), [economy-and-trade.md](../../docs/architecture/economy-and-trade.md#server-implementation-notes), [transit-hubs.md](../../docs/features/transit-hubs.md#server-implementation-notes), [military-bases.md](../../docs/features/military-bases.md#server-implementation-notes).

