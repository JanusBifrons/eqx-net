/**
 * Living World P1b — AI brain cost with TWO allegiances in one sector.
 *
 * Worst case for the cross-allegiance view: the whole drone pool (56) and the
 * whole robot pool (24) packed into ONE sector, every brain scanning the full
 * other-side swarm list each tick (O(N·M)). Budget from the plan: the AI pass
 * for 56 drones + 24 robots + 4 players stays ≤ 1.5 ms per tick. Compare the
 * drones-only row (the pre-P1b shape) to see what the robot side costs.
 *
 * Module-level setup only (vitest 2.1 bench skips beforeAll — README).
 */
import { bench, describe } from 'vitest';
import { HostileDroneBehaviour } from '../src/core/ai/HostileDroneBehaviour.js';
import type { AiEntity, AiSwarmView, AiWorldView } from '../src/core/contracts/IAiBehaviour.js';
import { getShipKind, type ShipKindId } from '../src/shared-types/shipKinds.js';
import { robotMemberKind } from '../src/server/livingworld/robotDirector.js';

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
});
