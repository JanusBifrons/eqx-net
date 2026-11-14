import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { stepKinematic, throttleOf, turnOf } from './pilotTestKit.js';

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
    b.setMoveTarget(0, 5000); // at angle 0 the nose points +Y, so this is dead ahead
    const intent = b.tick(self(0, 0, 0), view);
    expect(throttleOf(intent)).toBe(1);
    expect(turnOf(intent)).toBe(0);
  });

  it('turns toward a target off the current heading', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    b.setMoveTarget(5000, 0); // +X = starboard at angle 0 → must turn right
    const intent = b.tick(self(0, 0, 0), view);
    expect(turnOf(intent)).toBe(-1);
  });

  it('flies to the target and stops there (does not float past)', () => {
    // Player controls only: it must brake with reverse / damping to stop at
    // the slot, so arriving without sailing past is the pilot's job.
    const kind = getShipKind('fighter');
    const b = new HostileDroneBehaviour(kind);
    b.setMoveTarget(0, 3000);
    const body = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    let maxY = 0;
    for (let t = 0; t < 60 * 60; t++) {
      stepKinematic(body, kind, b.tick({ id: 'd', ...body }, view));
      maxY = Math.max(maxY, body.y);
    }
    expect(Math.hypot(body.x, body.y - 3000)).toBeLessThan(kind.radius * 2);
    expect(Math.hypot(body.vx, body.vy)).toBeLessThan(5);
    expect(maxY - 3000).toBeLessThan(kind.radius * 2);
  });

  it('holds position (no thrust) once at the target', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    b.setMoveTarget(5, 5);
    const intent = b.tick(self(5, 5, 0), view);
    expect(intent.input).toBe(0);
  });

  it('clearMoveTarget reverts to the origin orbit (finite intent, not NaN)', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    b.setMoveTarget(0, 1000);
    b.clearMoveTarget();
    const intent = b.tick(self(1800, 0, 0), view);
    expect(intent.input).toBeDefined();
    expect(Number.isInteger(intent.input)).toBe(true);
  });
});
