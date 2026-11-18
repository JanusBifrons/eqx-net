/**
 * `pilotJob()` equivalence (god-file split, peacetime modes): the one place
 * that picks the pilot's peacetime job. Each scene drives a brain through one
 * job (leaving, travel, patrol leg, flock follow, guard, hunt, course, orbit)
 * and records, tick by tick, what the fleet panel reads (`getActivity`) and
 * which controls the pilot pressed (the intent's input bits; the kinematic
 * step then flies them, so the trajectory follows from the bits). The
 * fingerprints were recorded on the code BEFORE the selector and the mode
 * files existed: the split changes no behaviour.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { AiEntityPoseOut, AiIntent, AiSwarmView, AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import { MORALE_OUTCOME } from './tactics/morale.js';
import { stepKinematic } from './pilotTestKit.js';

const KIND = getShipKind('fighter');

type Body = { id: string; x: number; y: number; vx: number; vy: number; angle: number; angvel: number; health?: number };

function body(x = 300, y = -200, angle = 0.3): Body {
  return { id: 'me', x, y, vx: 0, vy: 0, angle, angvel: 0 };
}

function view(tick: number, poses: Record<string, { x: number; y: number }> = {}): AiWorldView {
  return {
    players: [],
    tick,
    dtSec: 1 / 60,
    resolveEntityInto: (id: string, out: AiEntityPoseOut): boolean => {
      const p = poses[id];
      if (!p) return false;
      out.x = p.x; out.y = p.y; out.vx = 0; out.vy = 0; out.angle = 0; out.angvel = 0;
      return true;
    },
  };
}

interface Trace { activities: string[]; hash: number }

/** FNV-1a over each tick's activity and input bits. */
function record(b: HostileDroneBehaviour, self: Body, ticks: number, mkView: (t: number) => AiWorldView, from = 100): Trace {
  let h = 0x811c9dc5;
  const mix = (n: number): void => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  const activities: string[] = [];
  for (let t = from; t < from + ticks; t++) {
    const intent: AiIntent = b.tick(self, mkView(t));
    const a = b.getActivity();
    if (activities[activities.length - 1] !== a) activities.push(a);
    for (let i = 0; i < a.length; i++) mix(a.charCodeAt(i));
    mix(intent.input ?? 0);
    mix((intent.input ?? 0) >>> 8);
    mix(intent.fire ? 1 : 0);
    mix(intent.warpOut ? 1 : 0);
    stepKinematic(self, KIND, intent);
  }
  return { activities, hash: h };
}

function brain(): HostileDroneBehaviour {
  return new HostileDroneBehaviour(KIND);
}

/** A forced Flee that ends in a warp-out, so the ship then runs on leaving. */
function leavingScene(): Trace {
  const b = brain();
  b.setMoraleRoll(() => MORALE_OUTCOME.Flee);
  b.markHostile('enemy', 0);
  const swarms: AiSwarmView[] = [{ id: 'enemy', x: 0, y: 600, vx: 0, vy: 0, allegiance: 'traders' }];
  const nb: IAiNeighbourQuery = {
    count: 0,
    queryNeighbours: () => 0,
    idAt: () => '', xAt: () => 0, yAt: () => 0, vxAt: () => 0, vyAt: () => 0,
    radiusAt: () => 20, sideAt: () => '', isPilotAt: () => false, isCapitalAt: () => false,
  };
  const self = body(0, 0, 0);
  self.health = 0.2 * KIND.maxHealth;
  const v = (tick: number): AiWorldView => ({ players: [], tick, dtSec: 1 / 60, swarms, neighbours: nb });
  // Fly until the warp-out request, then on through the leaving run.
  let t = 1;
  for (; t < 2000 && b.getWarpOutCount() === 0; t++) {
    stepKinematic(self, KIND, b.tick(self, v(t)));
  }
  expect(b.getWarpOutCount()).toBe(1);
  return record(b, self, 400, v, t);
}

const SCENES: Record<string, () => Trace> = {
  orbit: () => record(brain(), body(), 240, (t) => view(t)),
  orbitFar: () => record(brain(), body(9000, 4000), 240, (t) => view(t)),
  course: () => { const b = brain(); b.setMoveTarget(1500, 900); return record(b, body(), 400, (t) => view(t)); },
  leaderCourse: () => { const b = brain(); b.setFlockLeaderCourse(-1200, 600); return record(b, body(), 400, (t) => view(t)); },
  guardReturn: () => { const b = brain(); b.setGuardPost(1800, 0, 0); return record(b, body(), 500, (t) => view(t)); },
  guardPostHold: () => {
    const b = brain();
    b.setGuardPost(1800, 0, 0);
    b.setMoveTarget(1800, 0);
    return record(b, body(), 500, (t) => view(t));
  },
  travel: () => { const b = brain(); b.setTravel(0, 2600); return record(b, body(), 500, (t) => view(t)); },
  patrolLeg: () => { const b = brain(); b.setPatrolLeg(300, -200, 300, 2600); return record(b, body(), 500, (t) => view(t)); },
  holdFireTravel: () => { const b = brain(); b.setHoldFire(true); b.setTravel(-900, 900); return record(b, body(), 300, (t) => view(t)); },
  flockFollow: () => {
    const b = brain();
    b.setFlockFollow('leader', ['leader', 'me']);
    return record(b, body(), 300, (t) => view(t, { leader: { x: 2000, y: 400 } }));
  },
  flockLeaderGone: () => {
    const b = brain();
    b.setFlockFollow('leader', ['leader', 'me']);
    return record(b, body(), 200, (t) => view(t));
  },
  flockWithPost: () => {
    const b = brain();
    b.setGuardPost(-1500, 0, 0);
    b.setFlockFollow('leader', ['leader', 'me']);
    return record(b, body(), 300, (t) => view(t, t < 200 ? { leader: { x: 1500, y: 0 } } : {}));
  },
  hunt: () => { const b = brain(); b.setHunt(true); return record(b, body(), 500, (t) => view(t)); },
  huntThenCourse: () => {
    const b = brain();
    b.setHunt(true);
    b.setMoveTarget(-800, -1600);
    return record(b, body(), 400, (t) => view(t));
  },
  leaving: leavingScene,
};

/** Recorded on the pre-selector code (see header). */
const EXPECTED: Record<string, Trace> = {
  orbit: { activities: ['idle'], hash: 2473974824 },
  orbitFar: { activities: ['idle'], hash: 474350843 },
  course: { activities: ['idle'], hash: 1206344689 },
  leaderCourse: { activities: ['idle'], hash: 3768640621 },
  guardReturn: { activities: ['moving', 'guarding'], hash: 1375265895 },
  guardPostHold: { activities: ['moving', 'guarding'], hash: 1375265895 },
  travel: { activities: ['moving'], hash: 2680883185 },
  patrolLeg: { activities: ['patrolling'], hash: 3391953992 },
  holdFireTravel: { activities: ['moving'], hash: 2667841088 },
  flockFollow: { activities: ['moving'], hash: 1363681713 },
  flockLeaderGone: { activities: ['moving'], hash: 779420788 },
  flockWithPost: { activities: ['moving'], hash: 2687486342 },
  hunt: { activities: ['searching'], hash: 1793141760 },
  huntThenCourse: { activities: ['searching'], hash: 965616777 },
  leaving: { activities: ['retreating', 'idle'], hash: 4093456341 },
};

describe('HostileDroneBehaviour — pilotJob() equivalence', () => {
  for (const [name, scene] of Object.entries(SCENES)) {
    it(`${name}: same activity and controls as before the split`, () => {
      const got = scene();
      expect(got).toEqual(EXPECTED[name]);
    });
  }
});
