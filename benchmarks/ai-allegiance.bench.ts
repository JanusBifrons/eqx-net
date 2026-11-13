/**
 * Living World P1b — AI brain cost with TWO allegiances in one sector.
 *
 * Worst case for the cross-allegiance view: the whole drone pool (56) and the
 * whole robot pool (24) packed into ONE sector, every brain scanning the full
 * other-side swarm list each tick (O(N·M)). Budget from the plan: the AI pass
 * for 56 drones + 24 robots + 4 players stays ≤ 1.5 ms per tick. Compare the
 * drones-only row (the pre-P1b shape) to see what the robot side costs.
 *
 * Also: the per-tick AI neighbour grid (steering slice 2a), rebuild + queries.
 *
 * Module-level setup only (vitest 2.1 bench skips beforeAll — README).
 */
import { bench, describe } from 'vitest';
import { HostileDroneBehaviour } from '../src/core/ai/HostileDroneBehaviour.js';
import type { AiEntity, AiSwarmView, AiWorldView } from '../src/core/contracts/IAiBehaviour.js';
import { getShipKind, type ShipKindId } from '../src/shared-types/shipKinds.js';
import { robotMemberKind } from '../src/server/livingworld/robotDirector.js';
import { AiNeighbourGrid } from '../src/server/rooms/AiNeighbourGrid.js';
import { GLOBAL_SHIP_TUNING } from '../src/shared-types/shipScale/lookup.js';

interface Agent {
  self: AiEntity;
  brain: HostileDroneBehaviour;
  allegiance: 'drones' | 'robots';
}

function makeAgents(drones: number, robots: number): Agent[] {
  const out: Agent[] = [];
  let i = 0;
  const place = (kind: ShipKindId, allegiance: Agent['allegiance']): void => {
    // Deterministic scatter over a ~3000 u box (inside on-sight range).
    const x = ((i * 7919) % 3000) - 1500;
    const y = ((i * 104729) % 3000) - 1500;
    out.push({
      self: { id: `${allegiance}-${i}`, x, y, vx: 0, vy: 0, angle: (i % 6) * 1.0, angvel: 0 },
      brain: new HostileDroneBehaviour(getShipKind(kind)),
      allegiance,
    });
    i++;
  };
  for (let d = 0; d < drones; d++) place('fighter', 'drones');
  for (let r = 0; r < robots; r++) place(robotMemberKind(0, r % 6), 'robots');
  return out;
}

function makeView(agents: Agent[]): AiWorldView {
  const swarms: AiSwarmView[] = agents.map((a) => ({
    id: a.self.id,
    x: a.self.x,
    y: a.self.y,
    vx: 0,
    vy: 0,
    allegiance: a.allegiance,
  }));
  const players = [0, 1, 2, 3].map((p) => ({ id: `p${p}`, x: p * 200, y: -p * 150, vx: 0, vy: 0 }));
  return { players, swarms, tick: 100, dtSec: 1 / 60 };
}

const MIXED = makeAgents(56, 24);
const MIXED_VIEW = makeView(MIXED);
const DRONES_ONLY = makeAgents(56, 0);
const DRONES_ONLY_VIEW: AiWorldView = { ...makeView(DRONES_ONLY), swarms: undefined };
// AI steering 2c — the same 80 bots with the neighbour grid on the view, so
// every combat tick runs the context-steering resolve + K≤8 separation query.
const MIXED_GRID = new AiNeighbourGrid();
MIXED_GRID.begin();
for (const a of MIXED) {
  MIXED_GRID.addDrone(a.self.id, a.self.x, a.self.y, 0, 0, 24, a.allegiance);
}
MIXED_GRID.end();
const MIXED_NB_VIEW: AiWorldView = { ...makeView(MIXED), neighbours: MIXED_GRID };

let tick = 100;
function runTick(agents: Agent[], view: AiWorldView): void {
  view.tick = tick++;
  for (const a of agents) a.brain.tick(a.self, view);
}

describe('AI brain tick — one sector, all bots', () => {
  bench('56 drones + 24 robots + 4 players (cross-allegiance view)', () => {
    runTick(MIXED, MIXED_VIEW);
  });
  bench('56 drones + 4 players (drones only, pre-P1b shape)', () => {
    runTick(DRONES_ONLY, DRONES_ONLY_VIEW);
  });
  bench('56 drones + 24 robots + 4 players + neighbour grid (combat context steering, 2c)', () => {
    runTick(MIXED, MIXED_NB_VIEW);
  });
});

// AI steering 2a — the per-tick neighbour grid: rebuild over 200 combatants
// (spread over a ~6000 u box, sides mixed) + 200 K=8 queries at a combat
// separation radius. Plan target: the whole AI pass stays < 1.5 ms at 200 bots.
const NB_N = 200;
const NB_GRID = new AiNeighbourGrid();
const NB_X = new Float64Array(NB_N);
const NB_Y = new Float64Array(NB_N);
const NB_IDS: string[] = [];
for (let n = 0; n < NB_N; n++) {
  NB_X[n] = ((n * 7919) % 6000) - 3000;
  NB_Y[n] = ((n * 104729) % 6000) - 3000;
  NB_IDS.push(`nb-${n}`);
}
const NB_OUT = new Int32Array(8);
const NB_R = 2 * GLOBAL_SHIP_TUNING.flockSeparation;

describe('AI neighbour grid — 200 combatants', () => {
  bench('rebuild + 200 K=8 queries', () => {
    NB_GRID.begin();
    for (let n = 0; n < NB_N; n++) {
      if (n % 10 === 0) NB_GRID.addPilot(NB_IDS[n]!, NB_X[n]!, NB_Y[n]!, 0, 0, 12);
      else NB_GRID.addDrone(NB_IDS[n]!, NB_X[n]!, NB_Y[n]!, 0, 0, 12, n % 3 === 0 ? 'robots' : 'drones');
    }
    NB_GRID.end();
    for (let n = 0; n < NB_N; n++) NB_GRID.queryNeighbours(NB_X[n]!, NB_Y[n]!, NB_R, 8, NB_OUT, NB_IDS[n]);
  });
});
