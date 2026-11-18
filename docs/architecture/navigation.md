# Navigation

How AI-flown ships and the player's autopilot find a way through and round asteroid fields, bases
and wrecks (macro-terrain Stage E). This guide grows slice by slice; the approved plan is
`navigation-plan.md` in the owner's plans folder.

<!-- showcase-exempt: internals guide; the autopilot shot lands with the autopilot slices -->

## Why
Every AI leg (`HostileDroneBehaviour.tickMoveTo`) flies a straight line, so convoys, flagships and
elites crossing a cut asteroid field fly into rock. Navigation adds two pieces the owner approved
(a free-space map and A* route search) and extends existing systems for everything else.

## The one graph searcher (`core/nav/search.ts`)
`GraphSearch` is the game's only path/hop search. It runs A* over any graph that implements
`SearchGraph` (`nodeCount`, `edgeCount(i)`, `edgeTo(i, k)`, `edgeCost(i, k)`), towards any
`SearchGoal` (`isGoal(i)`, `heuristic(i)`):
- heuristic 0 ⇒ Dijkstra; unit edge costs as well ⇒ breadth-first search;
- ties pop in insertion order, so on a unit-cost graph the visit order is exactly a FIFO BFS: a
  hand-written BFS moved onto it keeps its answers, tie-breaks included (tested against a reference
  BFS on random graphs);
- allocation-free once warm: costs, parents and the open heap live in typed arrays grown only for a
  bigger graph or fuller heap; a run stamp replaces clearing arrays (#14);
- `expanded` counts the nodes the last search expanded (the work counter for count gates).

Callers keep one goal object and mutate it between searches instead of passing a closure.
`UnitGraph` wraps adjacency lists (gate graphs); `NodeGoal` is a single target node.

### Who uses it
| Caller | Graph | Goal |
|---|---|---|
| `server/livingworld/heldSectorRoutes.ts` | sectors with a room, gate edges | nearest sector a power holds |
| `core/galaxy/gateHops.ts` (`gateFirstHop`, `gateHops`; behind `population.nextHopToward` / `hopDistance` and migration ranking) | whole galaxy, gate edges | one sector |
| `core/bases/transitNetwork.routeHops` | gate edges (1) + transit links (`LINK_HOP_COST`), one graph per network | one sector (weighted cost) |
| `core/structures/Grid` route tree (`bfsTree`) | power grid; unbuilt nodes reachable, never expanded (dead-end rule) | none: the whole reachable tree, cached per source |

Not a search, so not here: `Grid.rebuild`'s connected-component flood fill (it labels groups, it
does not look for a route).

## The one obstacle gatherer (`server/rooms/SectorObstacles.ts`)
Every "what solid things are near here?" question in a sector room reads `SectorObstacles`, the
room's `obstacles` field. It replaced four hand-written gathers in `SectorRoom` that each saw a
different subset.
| Call | Sees | Used by |
|---|---|---|
| `rocks(near?)` | live rocks (swarm kind 0, SAB pose, collider parts); with `near`, field rocks with no body (`CutFieldSubsystem.dormantObstacles`) | structure placement, connection line of sight, NPC base links (`getObstacles`) |
| `structureBoxes()` | structure solid boxes (a teleporter pad is open, only its posts) | join spawn, convoy spawn (`clearPointNear`) |
| `landing(...)` | structure boxes, every swarm body within reach (rocks, drones, scrap, wreck pieces, pods), field rocks with no body, other pilots' ships and parked hulls (own skipped, or only `onlySkipShipId`), blocking shield walls and closed gate spans | `landingPoint` (warp, sector trip, fleet and bot warps) |
| `hullCircles(playerId)` | AI ships and other pilots' hulls by extent (pilots still joining skipped) | join spawn spacing |

Outputs are scratch: each call refills the same arrays with the same pooled records (and a rock's
parts are built once per outline), so a caller uses the result before the next call and never keeps
it. The field-layout cut behind dormant rocks still allocates; every caller is a discrete action, never
a tick. Ship and wall sources reach it as visitors (`HullSink`, `WallSink`;
`ShieldWallManager.forEachBlockingWall`), and `nearestClearPoint` keeps a body clear of wall segments.

## The free-space map (`core/nav/clearance.ts`)
`ClearanceGrid` turns a patch of sector into square cells and stores, per cell, how far its centre is
from the nearest blocked cell's centre (world units). It is an exact Euclidean distance transform
(Felzenszwalb–Huttenlocher, columns then rows on squared distances), checked against brute force on
random layouts, so a lane between two walls reads exactly its half-width at the middle.
- A cell is blocked when its centre is inside an obstacle grown by `pad`: within `pad` of one of its
  convex `parts` (turned by `angle`) when it has them, else of its circle. Input is `GridObstacle[]`, the same records
  `SectorObstacles.rocks` fills, so the map sees what placement and line of sight see.
- A hull with clearance `c` fits at a cell reading `>= c`, to within one cell. `at(x, y)` reads the cell
  (clamped to the edge).
- Allocation-free once warm; arrays grow only for a bigger grid.
- Cost (print-only, desktop): one fine chunk (4 096 u at 64 u cells, 64×64) with 120 rocks builds in
  ~0.14 ms. Phone timing comes with the perf scene (slice 16).

## The coarse layer (`core/nav/coarseField.ts`)
`CoarseFieldMap` covers a whole cut field (plus room to go round it) with 2 048 u cells, from the
field's layout maths alone: `slicedFieldLanes`, `fieldStreet`, the open core and `FieldClearing` (the
same functions the cut uses, #15). No rock geometry is read.
- Each cell stores its **best point** (the most open spot in it) and the **room** there: the biggest
  hull clearance (hull radius) that fits. Not the centre: a lane is only ~560 u wider than a
  battleship (lane half-width 4 602 u, walls bend up to ~1.1 km, battleship radius 2 876 u), so a cell
  the lane's centre line crosses is judged on that line.
- Room at a point is the best of: past the rim (less the warp pad), the open core (less the pad and one
  piece), a clearing (exact), a lane (to its nearer wall, less the pad), and inside the field half the
  street there. Streets top out at 288 u at the rim, so every capital (destroyer radius 1 220 u and
  up) is kept to lanes, the core, clearings and the outside; fighters may use streets.
- It is a `SearchGraph` (8 neighbours; a cell is open when its room >= `clearance`; edge cost = the
  distance between best points), searched by the one `GraphSearch`.
- Built in the nav worker for every cut-field sector room (below); not yet used by any ship: the route
  planner (slice 6) searches it.
- Measured (desktop, print-only): 156×156 cells, 285 KB, built in ~4 ms. Across the field a battleship
  routes 448 km (round or along lanes), a fighter 325 km through streets (314 km straight).

## The fine layer (`core/nav/fineField.ts`)
One free-space map (`ClearanceGrid`) of 64 u cells per **loaded** field chunk, built from the chunk's real
rocks. The worker cuts them itself with the same pure `rocksInChunk` + `fieldRockBody` the room and the
client use (#15), so no rock shape crosses a thread; only "chunk loaded / dropped" and "rock broken up /
left somewhere else" do.
- Rocks grow by half a cell diagonal (`FINE_NAV_PAD`) before stamping, and the planner reads a cell's
  value less a cell diagonal (`FINE_NAV_DIAG`, ~91 u): a true lower bound anywhere in the cell, not just
  at its centre. Without it a route rated "64 u of room" ran a fighter into rock between cell centres.
  The cost: in the packed chunks (80+ rocks) almost no cell has fighter room. Measured 2026-11-18 (seed
  `look`): 1.5–5.5 % of a packed chunk's cells pass a fighter (`navClearance` 30 u), about 88 % read as
  rock. The streets (48 u at the core, 288 u at the rim) lose the 45 u pad on each side plus the 91 u
  diagonal, so the fine layer closes them too: a fighter's route into a packed chunk ends at the nearest
  reachable spot. In sparse chunks and outside the field fighters thread between rocks.
- Each chunk's grid reaches 1024 u past the chunk on every side (96×96 cells, 36 KB), so a rock over
  the border counts. Clearance reads are capped at that reach (past it the coarse layer decides) and read
  -1 where the chunk is not loaded.
- A broken-up or moved rock rebuilds only the loaded chunks its circle reaches (counted in
  `cellsRebuilt`; a rock deep inside a chunk rebuilds one chunk, not nine). Rocks already gone or left
  elsewhere when the room started come from the saved records (`CutFieldSubsystem.attachNav`).
- Awake rocks drifting between rests are not tracked: ships dodge moving bodies with local avoidance
  (slice 8). Wreck-field chunk sources are not in it yet.
- Measured (desktop, print-only): ~16–19 ms per chunk including cutting its 3×3 block of rocks.

## The nav worker (`server/nav/NavWorker.ts`)
Navigation maps are CPU-heavy, so they live on a worker (server threading rule), built like the physics
pool: the entry (`navWorkerEntry.ts`) is bundled once with `bundleWorker`, started with `eval` and
`unref()`'d. One worker per process hosts every sector: each room gets a `worldId`, replies come back
tagged with it.
- What the worker does with each message is `core/nav/navHost.ts` (`NavHost`), pure and tested
  directly: `ADD_FIELD {worldId, opts}` builds the coarse layer and replies `FIELD_BUILT` (cells, bytes,
  build ms); `REMOVE_FIELD` frees it; `CHUNK` and `ROCK` drive the fine layer; `ROUTE` plans a route
  (below).
- `SectorRoom` sends its cut field's own layout options (`CutFieldSubsystem.navOpts`, the same
  `ChunkOpts` the cut uses, #15) when the field is created, logs `nav coarse layer built`, and detaches
  on dispose. `NavWorker.addField` returns at once: chunk and rock events posted before the build replies
  queue in order behind it, so the field attaches before the streamer's first step and needs no replay. Rooms without a cut field never start the worker.
- Measured (desktop, print-only): a field with a clearing builds in ~8 ms in the worker, 285 KB.

## The route planner (`core/nav/routePlanner.ts`)
Runs on the nav worker over one field's two layers; a request is start, goal and hull clearance (how far
the hull's centre stays from rock, from `shipTuning`, #18). Room at a point is the fine layer where its
chunk is loaded and rock is within its reach, else the coarse layer.
1. Straight line clear ⇒ that is the route, no search (most requests).
2. Coarse A* over the whole field (cells with room for the hull): which way round, which lane.
3. Fine A* over 64 u cells in a 5×5-chunk window round the start, to the goal or to where the coarse path
   leaves the window (a goal inside the window skips the coarse search: it reads the field as solid). Diagonals never cut a corner.
4. String-pull: keep only the turns a straight line can't skip. Past the window the route follows coarse
   cell points; the ship asks again as it goes (slice 9).
- Line checks leap by the room to spare and, when tight, visit every 64 u cell
  the segment crosses (a fixed step skipped thin rock).
- Per-request caps: 30 000 coarse and 60 000 fine expansions. Past them, or with no way at this
  clearance, the route ends at the reached cell nearest the goal (`GraphSearch.nearest`, least heuristic),
  status `nearest`; `none` only when nothing reached is nearer than the start. At most 64 waypoints (`NAV_ROUTE_MAX_POINTS`).
- Capital commitment (slice 11): a capital's request also carries its nose (ship angle) and turning
  radius (`pilotTurnRadius`: cruise speed / turn rate, ~7 800 u for a battleship, wider than a lane).
  The coarse search then runs on `HeadingCoarseGraph`: a cell with less room than clearance + turning
  radius (a lane, to a capital) remembers which way the ship came in and lets the next step turn at most
  45° (forward only, no U-turn planned in a lane); each such turn costs 0.25 turning radii per 45°
  (`NAV_TURN_STEP_COST`), and entering a lane from open space costs one turning radius
  (`NAV_LANE_ENTRY_COST`). Open cells stay one node each, so the search costs about what the plain graph
  does (battleship across the field, nose on: ~12 900 expansions). The straight answer and the
  string-pull obey the same 45° rule where there is no room to turn. A capital (clearance past the fine
  layer's reach) plans on the coarse layer alone. Fighters send neither and see the plain graph.
- Wire to the worker: `ROUTE {worldId, reqId, sx, sy, tx, ty, clearance, heading, turnRadius}` → `ROUTE {reqId, status,
  points, expanded, ms}` (points transferred, not copied). `NavField.route(...)` returns a Promise;
  `NavWorker.inFlight` counts open requests; a detached field answers `none`; a worker exit rejects
  every open request.
- A ship keeps its route in a `NavRoute` (`core/ai/stepRoute.ts`), walked by the one `stepRoute` in
  open mode (runs out at the goal instead of looping; `stepNavRoute` returns -1 when finished).
- Measured (desktop, print-only): a fighter round a rock (sparse chunk 20,10) 307 expansions, ~2 ms,
  2 051 u against a 2 084 u grid path; a battleship across the field 6 waypoints, ~9 200 expansions, ~18 ms in the worker.

## Ships fly the routes (`server/nav/NavRoutes.ts`)
The room hands every brain one `IAiNavRoutes` as `view.nav` (server only: the client runs no drone
brain, so no wire change). `tickMoveTo` asks it for the waypoint to fly now; with one it flies there,
braking for `ahead` (distance to the waypoint plus the next leg as far as it runs the same way); without
one it flies straight as before.
- A new goal (moved more than `arrive`) asks the worker for one plan, at most once a second per ship
  (`NAV_REPLAN_MS`). Until it answers, or when it says `straight` / `none`, there is no waypoint.
  An answer for an older goal is dropped. Ships not asking for 10 s are forgotten.
- `nearest` (no way fits): the ship flies the route and waits at its end, the last waypoint staying
  its waypoint, until the goal changes; it asks again every 10 s (`NAV_WAIT_RETRY_MS`) and flies on if
  the way has opened.
- Stuck (game time): every 4 s (`NAV_STUCK_MS`) a ship further than 2 × arrive from its goal that moved
  less than arrive plans again from where it is; after two such plans it waits where it is (retried as
  above). Counters: `stuckReplans`, `held`, `short`.
- A waiting ship's fleet status activity is `blocked`, "Can't get closer" (Move and patrol legs,
  `SectorRoom` `activityOf` via `NavRoutes.waiting`), on the existing `fleet_status` stream.
- Squads (slice 10): a follower (`tickFlock`) asks for the way to the ship ahead of it in squad order
  (the member before it; the first, the leader) with `keep` (a moving goal flies the old route until the
  new plan lands). Open space answers straight and the boids herd is unchanged; rock between ⇒ it flies the
  route and stops `flockFollow` behind that ship, so the squad crosses single file (owner, 2026-11-17).
- Clearance: `shipTuning(kind).navClearance` = radius × 1.25.
- `CutFieldSubsystem.rockContacts` counts ship-vs-field-rock contacts (the test gate).
- Lock: `tests/integration/sectorRoom/navFollowRoute.test.ts`, a fighter told to Move across a rock arrives
  with no rock contact; the same order with routes off hits it.

## The player's autopilot asks (`server/nav/AutopilotRoutes.ts`)
- Wire (slice 12): client → server `nav_route_request {reqId, tx, ty}` (strict; the client names only the
  goal); server → that client `nav_route {reqId, status, points}` (`shared-types/messages/navMessages.ts`).
- The room plans from the asker's own active hull: its pose, `shipTuning` clearance and, for a capital,
  nose and turning radius (the slice 11 rules, as for AI capitals). A room without a rock field answers
  `straight` at once.
- One request in flight per player and one per 500 game ms; excess is dropped silently. The reply is advice
  for the client's helm, not state (#16 holds: a lost reply only means asking again).
- Player guide: [autopilot](../features/autopilot.md).
- Netgate scenario `autopilot` (gated, slice 15): a fighter at the field's rim flies a server route round
  a rock on the helm alone; the local prediction is held to the baseline's health. Triggered by
  `core/nav`, `server/nav`, `core/helm`, `client/helm` and the route wire (`tests/netgate/scenarios.ts`).

## History
- 2026-11-17: plan approved (wide lane by default, no-route ⇒ nearest spot and wait, whole route line,
  squads single file). Slice 1a: `GraphSearch` lands; `HeldSectorRoutes` moves onto it.
  Slice 1b: galaxy gate hops (`gateHops.ts`) and `routeHops` move onto it; answers unchanged for
  every sector pair. Slice 1c: the power grid's route tree moves onto it; routes unchanged on
  random grids. Slice 2: one obstacle gatherer (`SectorObstacles`) for placement, line of sight,
  landing and spawns. Landing now also avoids field rocks whose chunk is not loaded and blocking shield
  walls (before, a warp could land inside either).
  Slice 3: the free-space map (`ClearanceGrid`), an exact distance transform; ~0.14 ms per 64×64 chunk.
  Slice 4a: the coarse layer (`CoarseFieldMap`) from the field layout maths; a battleship fits every lane,
  streets are closed to capitals.
  Slice 4b: the nav worker builds the coarse layer for every cut-field sector room.
  Slice 5: the fine layer, per loaded chunk from the cut rocks, kept current as rocks break up or move.
  Slice 6: the route planner on the worker (`ROUTE`), `NavField.route`, `stepRoute` open mode and the
  `NavRoute` record. Not yet flown by any ship (slice 7).
  2026-11-18 slice 7: AI-flown ships follow routes (`NavRoutes`, `view.nav`, `tickMoveTo`). The fine
  layer's room became a true lower bound (padded rocks, value less a cell diagonal).
  2026-11-18 slice 8: moving danger. Drifting field rocks join the wreck-piece debris grid, and move legs
  dodge debris with the combat hull avoidance (extracted to `ai/hullAvoid.ts`); resting rocks stay with routes.
  2026-11-18 slice 9: no way ⇒ `nearest` route and wait; stuck ⇒ re-plan twice, then wait; fleet status
  `blocked` ("Can't get closer").
  2026-11-18 slice 10: squads cross rock single file, each follower routing to the ship ahead of it.
  2026-11-18 slice 11: capital commitment. Capitals plan with nose and turning radius: no U-turn in a
  lane, turns and lane entry cost turning radii.
  2026-11-18 slice 12: autopilot wire, `nav_route_request` → `nav_route`, served by `AutopilotRoutes`.
  2026-11-18 slice 13: the helm flies routes on every hull (`HelmOrder.route`, `helmPassRadius`;
  client `HelmRouteClient`); arrival within the hull's own size, not a fixed 20 u.
  2026-11-18 slice 14: the route line. One trace (`client/render/routeLine.ts`) for the fleet patrol
  pick and the helm course; `RenderMirror.helmCourse` carries the turns still ahead (`route`, `routeN`).
  2026-11-18 slice 15: netgate scenario `autopilot` (the plan's D1 guard). Found while choosing its route:
  the fine layer closes the field's streets to fighters (fine layer, above).
