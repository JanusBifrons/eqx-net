/**
 * `pilotJob()` equivalence (god-file split, peacetime modes): the one place
 * that picks the pilot's peacetime job. Each scene drives a brain through one
 * job (leaving, travel, patrol leg, flock follow, guard, hunt, course, orbit)
 * and records, tick by tick, what the fleet panel reads (`getActivity`) and
 * which controls the pilot pressed (the intent's input bits; the kinematic
 * step then flies them, so the trajectory follows from the bits). The
 * fingerprints were recorded on the code BEFORE the selector and the mode
 * files existed: the split changes no behaviour. Since the activity fix the
 * panel reports by the same `pilotJob()` order `tick()` flies (see EXPECTED).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { AiEntityPoseOut, AiIntent, AiSwarmView, AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import { MORALE_OUTCOME } from './tactics/morale.js';
import { MANOEUVRE_FLEE } from './tactics/manoeuvre.js';
import { stepKinematic } from './pilotTestKit.js';
import { TRAVEL_ARRIVED } from './hostileDroneTuning.js';

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

/** `hash`: activity + controls per tick; `bits`: controls alone (the
 *  flying, which a reporting change must leave identical). */
interface Trace { activities: string[]; hash: number; bits: number }

/** FNV-1a over each tick's activity and input bits. */
function record(b: HostileDroneBehaviour, self: Body, ticks: number, mkView: (t: number) => AiWorldView, from = 100): Trace {
  let h = 0x811c9dc5;
  let k = 0x811c9dc5;
  const mix = (n: number): void => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  const mixBits = (n: number): void => { mix(n); k ^= n & 0xff; k = Math.imul(k, 0x01000193) >>> 0; };
  const activities: string[] = [];
  for (let t = from; t < from + ticks; t++) {
    const intent: AiIntent = b.tick(self, mkView(t));
    const a = b.getActivity();
    if (activities[activities.length - 1] !== a) activities.push(a);
    for (let i = 0; i < a.length; i++) mix(a.charCodeAt(i));
    mixBits(intent.input ?? 0);
    mixBits((intent.input ?? 0) >>> 8);
    mixBits(intent.fire ? 1 : 0);
    mixBits(intent.warpOut ? 1 : 0);
    stepKinematic(self, KIND, intent);
  }
  return { activities, hash: h, bits: k };
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

/** An owned Aggressive ship flying past a robot on its route. */
function ownedPast(order: (b: HostileDroneBehaviour) => void): Trace {
  const b = new HostileDroneBehaviour(KIND, { side: 'players', ownerId: 'owner-1' });
  b.setEngageOnSight(true);
  order(b);
  const swarms: AiSwarmView[] = [{ id: 'r1', x: 0, y: 1500, vx: 0, vy: 0, allegiance: 'robots', kindId: 'robot-square' }];
  return record(b, body(0, 0, 0), 900, (t) => ({ players: [], tick: t, dtSec: 1 / 60, swarms }));
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
  // Travel / patrol / search coverage (recorded before the travel and search
  // modes moved out of the brain).
  travelArrive: () => { const b = brain(); b.setTravel(900, 300); return record(b, body(), 600, (t) => view(t)); },
  travelFiring: () => ownedPast((b) => b.setTravel(0, 3000)),
  patrolLegFight: () => ownedPast((b) => b.setPatrolLeg(0, 0, 0, 3000)),
  huntLong: () => { const b = brain(); b.setHunt(true); return record(b, body(), 2400, (t) => view(t)); },
};

/** Recorded on the pre-selector code (see header); the travel / patrol /
 *  search additions on the code before those modes moved out. `bits`
 *  (controls alone) recorded before the activity fix below and unchanged by
 *  it. The activity fix (the panel reads the job `tick()` flies) changed
 *  the labels, and so `hash`, of six scenes only: course, leaderCourse and
 *  huntThenCourse fly their course (`idle` / `searching` ⇒ `moving`);
 *  flockLeaderGone flies the orbit (`moving` ⇒ `idle`); leaving, after the
 *  run, flies the course to its drop point (`idle` ⇒ `moving`); travelFiring
 *  on its arrival tick flew travel and posted, not the fight (`chasing`
 *  dropped for that one tick). The owner short-move turn (moveTo.ts: an
 *  owner's order keeps its nose only inside wingmanArrive, not flockFollow)
 *  changed the controls of holdFireTravel and travelArrive only: both short
 *  travels now turn to face the point on the last stretch instead of sliding
 *  there nose-fixed; their labels are unchanged. */
const EXPECTED: Record<string, Trace> = {
  orbit: { activities: ['idle'], hash: 2473974824, bits: 2829683080 },
  orbitFar: { activities: ['idle'], hash: 474350843, bits: 3680974707 },
  course: { activities: ['moving'], hash: 1517452081, bits: 458650133 },
  leaderCourse: { activities: ['moving'], hash: 4029499109, bits: 1471027973 },
  guardReturn: { activities: ['moving', 'guarding'], hash: 1375265895, bits: 1658740194 },
  guardPostHold: { activities: ['moving', 'guarding'], hash: 1375265895, bits: 1658740194 },
  travel: { activities: ['moving'], hash: 2680883185, bits: 1012981025 },
  patrolLeg: { activities: ['patrolling'], hash: 3391953992, bits: 401342200 },
  holdFireTravel: { activities: ['moving'], hash: 2809715492, bits: 1698488116 },
  flockFollow: { activities: ['moving'], hash: 1363681713, bits: 984585117 },
  flockLeaderGone: { activities: ['idle'], hash: 880472628, bits: 1650270408 },
  flockWithPost: { activities: ['moving'], hash: 2687486342, bits: 1712373666 },
  hunt: { activities: ['searching'], hash: 1793141760, bits: 746650452 },
  huntThenCourse: { activities: ['moving'], hash: 1796483839, bits: 1668080087 },
  leaving: { activities: ['retreating', 'moving'], hash: 1421539877, bits: 1894031765 },
  travelArrive: { activities: ['moving', 'guarding'], hash: 2949910939, bits: 3195831271 },
  travelFiring: { activities: ['moving', 'guarding'], hash: 3741288517, bits: 3753688765 },
  patrolLegFight: { activities: ['patrolling', 'chasing', 'attacking'], hash: 2851019941, bits: 3732694268 },
  huntLong: { activities: ['searching'], hash: 2146711092, bits: 4192992930 },
};

describe('HostileDroneBehaviour — pilotJob() equivalence', () => {
  for (const [name, scene] of Object.entries(SCENES)) {
    it(`${name}: same activity and controls as before the split`, () => {
      const got = scene();
      expect(got).toEqual(EXPECTED[name]);
    });
  }
});

/** The labels the fleet panel read, tick by tick, over `ticks` ticks. */
function labels(b: HostileDroneBehaviour, self: Body, ticks: number, mkView: (t: number) => AiWorldView, kind = KIND): string[] {
  const out: string[] = [];
  for (let t = 100; t < 100 + ticks; t++) {
    const intent = b.tick(self, mkView(t));
    const a = b.getActivity();
    if (out[out.length - 1] !== a) out.push(a);
    stepKinematic(self, kind, intent);
  }
  return out;
}

/** The fleet panel reads the job `tick()` flies (the `pilotJob()` order
 *  `tick()` uses), not a second order of its own (PR #863's mismatches). */
describe('HostileDroneBehaviour — getActivity() reports the job tick() flies', () => {
  it('a hunter given a course flies it and reads moving, not searching', () => {
    const b = brain();
    b.setHunt(true);
    b.setMoveTarget(-800, -1600);
    expect(labels(b, body(), 60, (t) => view(t))).toEqual(['moving']);
  });

  it('a hunter given a leader course flies it and reads moving, not searching', () => {
    const b = brain();
    b.setHunt(true);
    b.setFlockLeaderCourse(-1200, 600);
    expect(labels(b, body(), 60, (t) => view(t))).toEqual(['moving']);
  });

  it('a bare course reads moving, not idle', () => {
    const b = brain();
    b.setMoveTarget(1500, 900);
    expect(labels(b, body(), 60, (t) => view(t))).toEqual(['moving']);
  });

  it('a broadside capital with a post and nothing to fight orbits and reads idle', () => {
    const cap = getShipKind('battleship');
    const b = new HostileDroneBehaviour(cap);
    b.setGuardPost(4000, 0, 0);
    expect(labels(b, body(), 60, (t) => view(t), cap)).toEqual(['idle']);
  });

  it('a broadside capital on a patrol leg keeps its route past a foe and reads patrolling', () => {
    const cap = getShipKind('battleship');
    const b = new HostileDroneBehaviour(cap, { side: 'players', ownerId: 'owner-1' });
    b.setEngageOnSight(true);
    b.setPatrolLeg(0, 0, 0, 12000);
    const swarms: AiSwarmView[] = [{ id: 'r1', x: 0, y: 2500, vx: 0, vy: 0, allegiance: 'robots', kindId: 'robot-square' }];
    const self = body(0, 0, 0);
    const seen = new Set<string>();
    let picked = false;
    for (let t = 100; t < 3000 && b.getTravelState() !== TRAVEL_ARRIVED; t++) {
      const intent = b.tick(self, { players: [], tick: t, dtSec: 1 / 60, swarms });
      if (b.getTargetId() !== null) picked = true;
      seen.add(b.getActivity());
      stepKinematic(self, cap, intent);
    }
    expect(picked).toBe(true);
    expect([...seen]).toEqual(['patrolling']);
  });

  it('a fleeing ship that lost its target runs clear and reads retreating', () => {
    const b = brain();
    b.setMoraleRoll(() => MORALE_OUTCOME.Flee);
    b.markHostile('enemy', 0);
    const swarms: AiSwarmView[] = [{ id: 'enemy', x: 0, y: 600, vx: 0, vy: 0, allegiance: 'traders' }];
    const self = body(0, 0, 0);
    self.health = 0.2 * KIND.maxHealth;
    const nb: IAiNeighbourQuery = {
      count: 0,
      queryNeighbours: () => 0,
      idAt: () => '', xAt: () => 0, yAt: () => 0, vxAt: () => 0, vyAt: () => 0,
      radiusAt: () => 20, sideAt: () => '', isPilotAt: () => false, isCapitalAt: () => false,
    };
    // Fight until the morale roll turns it to flee.
    let t = 1;
    for (; t < 600 && b.getManoeuvre() !== MANOEUVRE_FLEE; t++) {
      stepKinematic(self, KIND, b.tick(self, { players: [], tick: t, dtSec: 1 / 60, swarms, neighbours: nb }));
    }
    expect(b.getManoeuvre()).toBe(MANOEUVRE_FLEE);
    // The enemy drops out of view: the ship runs clear until it asks to warp out.
    const seen = new Set<string>();
    let clearTicks = 0;
    for (; t < 3000 && b.getWarpOutCount() === 0; t++) {
      const intent = b.tick(self, { players: [], tick: t, dtSec: 1 / 60, swarms: [], neighbours: nb });
      if (b.getWarpOutCount() === 0) { seen.add(b.getActivity()); clearTicks++; }
      stepKinematic(self, KIND, intent);
    }
    expect(b.getWarpOutCount()).toBe(1);
    expect(clearTicks).toBeGreaterThan(0);
    expect([...seen]).toEqual(['retreating']);
  });

  it('a follower whose leader is gone flies its next job (the orbit) and reads idle', () => {
    const b = brain();
    b.setFlockFollow('leader', ['leader', 'me']);
    expect(labels(b, body(), 60, (t) => view(t))).toEqual(['idle']);
  });
});
