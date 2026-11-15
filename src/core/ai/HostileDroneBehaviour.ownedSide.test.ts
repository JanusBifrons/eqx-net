/**
 * RTS Part B slice 1: a player-owned ship flown by the same AI pilot brain the
 * drones use (`HostileDroneBehaviour` with `{ side: 'players', ownerId }`).
 *
 * The owned ship sits on the PLAYERS side: it engages anything that attacks
 * players on sight (robots), never targets its owner or another friendly
 * pilot, never runs, and pays boost and guns from the ship's one energy pool
 * (the pool it is handed, read and spent the same way as a drone's own).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import type { AiEntity, AiSwarmView, AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { resolveSlotEnergyCost } from '../combat/Energy.js';
import { MANOEUVRE_FALL_BACK, MANOEUVRE_FLEE } from './tactics/manoeuvre.js';
import { MORALE_OUTCOME } from './tactics/morale.js';

const FIGHTER = getShipKind('fighter');
const OWNER = 'owner-1';

function self(health?: number): AiEntity {
  return { id: 'own-1', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, health };
}

function view(tick: number, over: Partial<AiWorldView> = {}): AiWorldView {
  return { players: [], tick, dtSec: 1 / 60, ...over };
}

const ROBOT_AHEAD: AiSwarmView = { id: 'r1', x: 0, y: 300, vx: 0, vy: 0, allegiance: 'robots' };
const DRONE_AHEAD: AiSwarmView = { id: 'd1', x: 0, y: 300, vx: 0, vy: 0, allegiance: 'drones' };

function owned(pool?: { energy: number }): HostileDroneBehaviour {
  return new HostileDroneBehaviour(FIGHTER, { side: 'players', ownerId: OWNER, energyPool: pool });
}

describe('HostileDroneBehaviour — player-owned side', () => {
  it('engages a robot ahead unprovoked (robots attack players on sight)', () => {
    const b = owned();
    const intent = b.tick(self(), view(100, { swarms: [ROBOT_AHEAD] }));
    expect(b.getTargetId()).toBe('r1');
    expect(intent.fire).toBeDefined();
  });

  it('ignores an unprovoked drone (drones are neutral to players)', () => {
    const b = owned();
    b.tick(self(), view(100, { swarms: [DRONE_AHEAD] }));
    expect(b.getTargetId()).toBeNull();
  });

  it('picks the robot, never its owner or a friendly pilot, even when they are closer', () => {
    const b = owned();
    const players = [
      { id: OWNER, x: 0, y: 120, vx: 0, vy: 0 },
      { id: 'friend', x: 0, y: 150, vx: 0, vy: 0 },
      { id: 'owner-ship-2', ownerId: OWNER, x: 0, y: 180, vx: 0, vy: 0 },
    ];
    for (let t = 100; t < 160; t++) b.tick(self(), view(t, { players, swarms: [ROBOT_AHEAD] }));
    expect(b.getTargetId()).toBe('r1');
    expect(b.isHostileToPlayer(OWNER)).toBe(false);
    expect(b.isHostileToPlayer('friend')).toBe(false);
  });

  it('the side comes from the option, not the hull: an owned robot hull hunts robots and spares its owner', () => {
    const b = new HostileDroneBehaviour(getShipKind('robot-square'), { side: 'players', ownerId: OWNER });
    const players = [{ id: OWNER, x: 0, y: 120, vx: 0, vy: 0 }];
    for (let t = 100; t < 160; t++) b.tick(self(), view(t, { players, swarms: [ROBOT_AHEAD] }));
    expect(b.getTargetId()).toBe('r1');
    expect(b.isHostileToPlayer(OWNER)).toBe(false);
  });

  it("the owner's own friendly fire never turns it on the owner", () => {
    const b = owned();
    b.markHostile(OWNER, 100);
    const players = [{ id: OWNER, x: 0, y: 150, vx: 0, vy: 0 }];
    const intent = b.tick(self(), view(101, { players }));
    expect(b.getTargetId()).toBeNull();
    expect(intent.fire).toBeUndefined();
    expect(b.isHostileToPlayer(OWNER)).toBe(false);
  });

  it('claims its target on the players side, not the drones side', () => {
    const b = owned();
    const sides: string[] = [];
    const claims = { claim: (_e: string, side: string, t: string | null) => { if (t !== null) sides.push(side); }, count: () => 0 };
    b.tick(self(), view(100, { swarms: [ROBOT_AHEAD], claims }));
    expect(sides).toEqual(['players']);
  });

  it('never flees or falls back at low hull, whatever the die would say', () => {
    const b = owned();
    const nb: IAiNeighbourQuery = {
      count: 2,
      queryNeighbours(_x, _y, _r, _k, out, excludeId) {
        let n = 0;
        if (excludeId !== 'own-1') out[n++] = 0;
        out[n++] = 1;
        return n;
      },
      idAt: (i) => (i === 0 ? 'own-1' : 'r1'),
      xAt: () => 0,
      yAt: (i) => (i === 0 ? 0 : 300),
      vxAt: () => 0,
      vyAt: () => 0,
      radiusAt: () => 20,
      sideAt: (i) => (i === 0 ? 'players' : 'robots'),
      isPilotAt: () => false,
      isCapitalAt: () => false,
    };
    const hp = 0.1 * FIGHTER.maxHealth;
    b.noteDamage(0.5 * FIGHTER.maxHealth, 1, FIGHTER.maxHealth);
    for (let t = 1; t <= 600; t++) {
      b.tick(self(hp), view(t, { swarms: [ROBOT_AHEAD], neighbours: nb }));
      expect(b.getManoeuvre()).not.toBe(MANOEUVRE_FLEE);
      expect(b.getManoeuvre()).not.toBe(MANOEUVRE_FALL_BACK);
    }
    // A morale trigger did roll, and the roll came out Fight on.
    expect(b.getLastMoraleOutcome()).toBe(MORALE_OUTCOME.FightOn);
    expect(b.getWarpOutCount()).toBe(0);
  });

  it("reads and spends the ship's one pool it is handed: no second pool", () => {
    const pool = { energy: 10 };
    const b = owned(pool);
    expect(b.getEnergy()).toBe(10);
    const cost = resolveSlotEnergyCost(FIGHTER);
    expect(b.trySpendEnergy(cost)).toBe(true);
    expect(pool.energy).toBeCloseTo(10 - cost, 9);
    // The pool was not refilled to the kind's max by the brain.
    expect(b.getEnergyFrac()).toBeCloseTo((10 - cost) / (FIGHTER.energyMax ?? 100), 9);
    // Something else (the room) changing the pool is seen at once.
    pool.energy = 0;
    expect(b.getEnergy()).toBe(0);
    expect(b.trySpendEnergy(cost)).toBe(false);
    expect(pool.energy).toBe(0);
  });

  it('a pre-scaled ship kind flows into the pilot handling', () => {
    const scaled = { ...FIGHTER, thrustImpulse: FIGHTER.thrustImpulse * 2, maxSpeed: FIGHTER.maxSpeed * 2 };
    const base = new HostileDroneBehaviour(FIGHTER, { side: 'players', ownerId: OWNER });
    const fast = new HostileDroneBehaviour(scaled, { side: 'players', ownerId: OWNER });
    expect(fast.getCruiseSpeed()).toBeGreaterThan(base.getCruiseSpeed());
  });
});
