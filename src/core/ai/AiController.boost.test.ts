/**
 * Take 12 film review: AI pilots hold the boost key often, but on screen their
 * boost barely showed. The controller now remembers, per AI ship, whether this
 * tick's control keys held boost, so the snapshot can carry it (#16: the
 * client draws the same boost flame a pilot's ship gets, from the real key).
 */
import { describe, expect, it } from 'vitest';
import { AiController, type AiIntentSink } from './AiController.js';
import {
  AI_INPUT_BOOST,
  AI_INPUT_THRUST,
  type AiEntity,
  type AiIntent,
  type IAiBehaviour,
} from '../contracts/IAiBehaviour.js';

class SwitchBehaviour implements IAiBehaviour {
  intent: AiIntent = { fx: 0, fy: 0, torque: 0 };
  tick(): AiIntent {
    return this.intent;
  }
}

const sink: AiIntentSink = { postIntent: () => {}, postInput: () => {}, flushInputs: () => {} };
const pose = (id: string): AiEntity => ({ id, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });

describe('AiController — the boost key an AI pilot held this tick', () => {
  it('reports the slot while boost is held, and -1 once it is let go', () => {
    const ctrl = new AiController(sink);
    const b = new SwitchBehaviour();
    ctrl.register('ai-1', 7, b);

    b.intent = { fx: 0, fy: 0, torque: 0, input: AI_INPUT_THRUST | AI_INPUT_BOOST };
    ctrl.tick(1, 1 / 60, [], pose);
    expect(ctrl.boostingSlot('ai-1')).toBe(7);

    b.intent = { fx: 0, fy: 0, torque: 0, input: AI_INPUT_THRUST };
    ctrl.tick(2, 1 / 60, [], pose);
    expect(ctrl.boostingSlot('ai-1')).toBe(-1);
  });

  it('an impulse-flown ship, a ship with no pose and an unknown id never boost', () => {
    const ctrl = new AiController(sink);
    const b = new SwitchBehaviour();
    ctrl.register('ai-1', 3, b);
    b.intent = { fx: 0, fy: 0, torque: 0, input: AI_INPUT_BOOST };
    ctrl.tick(1, 1 / 60, [], pose);
    expect(ctrl.boostingSlot('ai-1')).toBe(3);
    // No pose this tick (the body is gone): the key is not held any more.
    ctrl.tick(2, 1 / 60, [], () => null);
    expect(ctrl.boostingSlot('ai-1')).toBe(-1);
    // Impulse intent (no control keys) never boosts.
    b.intent = { fx: 5, fy: 0, torque: 0 };
    ctrl.tick(3, 1 / 60, [], pose);
    expect(ctrl.boostingSlot('ai-1')).toBe(-1);
    expect(ctrl.boostingSlot('nobody')).toBe(-1);
  });
});
