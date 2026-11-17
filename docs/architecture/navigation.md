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

Still to move here: `Grid.bfsTree` (power grid).

## History
- 2026-11-17: plan approved (wide lane by default, no-route ⇒ nearest spot and wait, whole route line,
  squads single file). Slice 1a: `GraphSearch` lands; `HeldSectorRoutes` moves onto it.
  Slice 1b: galaxy gate hops (`gateHops.ts`) and `routeHops` move onto it; answers unchanged for
  every sector pair.
