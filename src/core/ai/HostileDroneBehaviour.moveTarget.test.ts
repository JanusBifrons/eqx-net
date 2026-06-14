import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';

function self(x: number, y: number, angle = 0): AiEntity {
  return { id: 'd', x, y, vx: 0, vy: 0, angle, angvel: 0 };
}
const view: AiWorldView = { players: [], tick: 0, dtSec: 1 / 60 };

/**
 * Phase-5 WS-4 — the in-sector formation move target. A roaming drone with a
 * director-assigned move target flies to it (arrive ramp) and slows to a stop,
 * instead of the origin orbit ("AI bots which are roaming just sort of sit
 * there… make a formation and fly in formation").
 */
describe('HostileDroneBehaviour — roaming move target', () => {
  it('IDLE with a move target straight ahead thrusts forward, no turn', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    b.setMoveTarget(0, 1000); // at angle 0 the nose points +Y, so this is dead ahead
    const intent = b.tick(self(0, 0, 0), view);
    expect(intent.fy).toBeGreaterThan(0);
    expect(Math.abs(intent.fx)).toBeLessThan(1e-6);
    expect(intent.setAngvel ?? 0).toBeCloseTo(0, 9);
  });

  it('turns toward a target off the current heading', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    b.setMoveTarget(1000, 0); // +X = starboard at angle 0 → must turn
    const intent = b.tick(self(0, 0, 0), view);
    expect(Math.abs(intent.setAngvel ?? 0)).toBeGreaterThan(0);
  });

  it('ramps thrust DOWN near the target (slows to a stop, does not float past)', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    b.setMoveTarget(0, 1000);
    const far = b.tick(self(0, 0, 0), view).fy; // dist 1000 → full thrust
    const near = b.tick(self(0, 900, 0), view).fy; // dist 100, inside slow radius 300
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far);
  });

  it('holds position (no thrust) once at the target', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    b.setMoveTarget(5, 5);
    const intent = b.tick(self(5, 5, 0), view);
    expect(intent.fx).toBe(0);
    expect(intent.fy).toBe(0);
  });

  it('clearMoveTarget reverts to the origin orbit (finite intent, not NaN)', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    b.setMoveTarget(0, 1000);
    b.clearMoveTarget();
    const intent = b.tick(self(1800, 0, 0), view);
    expect(Number.isFinite(intent.fx)).toBe(true);
    expect(Number.isFinite(intent.fy)).toBe(true);
  });
});
