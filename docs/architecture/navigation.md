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
- A cell is blocked when its centre is inside an obstacle: inside one of its convex `parts` (turned by
  `angle`) when it has them, else inside its circle. Input is `GridObstacle[]`, the same records
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
- Not yet built in a worker or used by any ship: the nav worker (slice 4b) hosts it, and the route
  planner (slice 6) searches it.
- Measured (desktop, print-only): 156×156 cells, 285 KB, built in ~4 ms. Across the field a battleship
  routes 448 km (round or along lanes), a fighter 325 km through streets (314 km straight).

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
