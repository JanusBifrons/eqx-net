/**
 * Allegiances P0 (plan peppy-jumping-pinwheel) — the brain's on-sight stance.
 *
 * Robots attack players AND drones on sight; drones attack robots on sight but
 * still only engage players via waves / retaliation (the pre-P0 behaviour).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import type { AiEntity, AiSwarmView, AiWorldView } from '../contracts/IAiBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { ON_SIGHT_ENGAGE_RANGE } from '../../shared-types/allegiances.js';

const ROBOT = getShipKind('robot-square');
const DRONE = getShipKind('fighter');

/** Nose points (-sin θ, cos θ); θ = 0 ⇒ facing +y. */
function self(id: string): AiEntity {
  return { id, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
}

function view(over: Partial<AiWorldView>): AiWorldView {
  return { players: [], tick: 100, dtSec: 1 / 60, ...over };
}

const PLAYER_AHEAD = { id: 'p1', x: 0, y: 150, vx: 0, vy: 0 };

describe('HostileDroneBehaviour — allegiance on-sight stance', () => {
  it('a ROBOT fires at a player ahead without ever being provoked', () => {
    const b = new HostileDroneBehaviour(ROBOT);
    const intent = b.tick(self('r1'), view({ players: [PLAYER_AHEAD] }));
    expect(intent.fire).toBeDefined();
  });

  it('P2 — a ROBOT holds fire on a player with a TRUCE (robot rep), but still retaliates', () => {
    const b = new HostileDroneBehaviour(ROBOT);
    const truced = { ...PLAYER_AHEAD, truce: true };
    expect(b.tick(self('r1'), view({ players: [truced] })).fire).toBeUndefined();
    expect(b.isHostileToPlayer('p1', true)).toBe(false);
    expect(b.isHostileToPlayer('p1', false)).toBe(true);
    b.markHostile('p1', 100); // the player shot it
    expect(b.isHostileToPlayer('p1', true)).toBe(true);
    expect(b.tick(self('r1'), view({ players: [truced] })).fire).toBeDefined();
  });

  it('a DRONE does NOT fire at an unprovoked player (pre-P0 behaviour preserved)', () => {
    const b = new HostileDroneBehaviour(DRONE);
    const intent = b.tick(self('d1'), view({ players: [PLAYER_AHEAD] }));
    expect(intent.fire).toBeUndefined();
    expect(b.getState()).toBe('IDLE');
  });

  it('a ROBOT ignores a player beyond the on-sight engage range', () => {
    const b = new HostileDroneBehaviour(ROBOT);
    const far = { ...PLAYER_AHEAD, y: ON_SIGHT_ENGAGE_RANGE + 500 };
    const intent = b.tick(self('r1'), view({ players: [far] }));
    expect(intent.fire).toBeUndefined();
  });

  it('a DRONE fires at a ROBOT ahead (cross-allegiance swarm target)', () => {
    const b = new HostileDroneBehaviour(DRONE);
    const robot: AiSwarmView = { id: 'r1', x: 0, y: 150, vx: 0, vy: 0, allegiance: 'robots' };
    const intent = b.tick(self('d1'), view({ swarms: [robot] }));
    expect(intent.fire).toBeDefined();
  });

  it('a DRONE never targets a fellow drone in the swarm list', () => {
    const b = new HostileDroneBehaviour(DRONE);
    const ally: AiSwarmView = { id: 'd2', x: 0, y: 150, vx: 0, vy: 0, allegiance: 'drones' };
    const intent = b.tick(self('d1'), view({ swarms: [ally] }));
    expect(intent.fire).toBeUndefined();
  });

  it('isHostileToPlayer: robots by stance, drones only via the ledger (#16 carrier)', () => {
    const robot = new HostileDroneBehaviour(ROBOT);
    const drone = new HostileDroneBehaviour(DRONE);
    expect(robot.isHostileToPlayer('anyone')).toBe(true);
    expect(drone.isHostileToPlayer('anyone')).toBe(false);
    drone.markHostile('anyone', 1);
    expect(drone.isHostileToPlayer('anyone')).toBe(true);
  });
});
