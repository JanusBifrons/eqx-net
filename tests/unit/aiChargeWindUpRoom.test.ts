/**
 * An AI pilot starts a charge wind-up only where it has room to hold its line.
 *
 * While a 'locked-direction' charge winds up (the Robot Orb's charge laser,
 * 1.2 s) the pilot holds its line, nose on the lead at the target's velocity,
 * so the shot leaves down the barrel onto the target. Pulled inside the attack
 * run's pull-off distance (`shipTuning.attackRunOvershoot`), where the pass
 * should swing beside the target, that hold parked the Orb ~2.5 ship lengths
 * off a parked pilot for the whole wind-up (strafeParkedRobots (b): a 1.27 s
 * slow hold at 155 u, half of its time inside 3 lengths spent charging).
 * A pilot saves the charge for the next dive instead.
 */
import { describe, expect, it } from 'vitest';
import { HostileDroneBehaviour } from '../../src/core/ai/HostileDroneBehaviour';
import { shipTuning } from '../../src/shared-types/shipScale/tuning';
import { getShipKind, type ShipKindId } from '../../src/shared-types/shipKinds';

/** Does a fresh brain pull the trigger on a parked pilot dead ahead at `d`? */
function triggerAt(kind: ShipKindId, d: number, charging = false): boolean {
  const brain = new HostileDroneBehaviour(kind);
  brain.markHostile('p', 0);
  const p = { id: 'p', x: 0, y: d, vx: 0, vy: 0 };
  const intent = brain.tick(
    { id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 },
    { players: [p], tick: 100, dtSec: 1 / 60, isCharging: () => charging },
  );
  return intent.fire !== undefined;
}

describe('a charge wind-up starts only where the pilot can hold its line', () => {
  const overshoot = shipTuning(getShipKind('robot-circle')).attackRunOvershoot;

  it('a Robot Orb dives in and starts its charge outside the pull-off distance', () => {
    expect(triggerAt('robot-circle', overshoot + 100)).toBe(true);
  });

  it('a Robot Orb inside the pull-off distance saves the charge for the next dive', () => {
    expect(triggerAt('robot-circle', overshoot * 0.4)).toBe(false);
    expect(triggerAt('robot-circle', overshoot - 10)).toBe(false);
  });

  it('a gun with no charge still fires point-blank (the Robot Cube)', () => {
    expect(triggerAt('robot-square', overshoot * 0.4)).toBe(true);
  });
});
