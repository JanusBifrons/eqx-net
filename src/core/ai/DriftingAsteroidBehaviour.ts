import type { AiEntity, AiIntent, AiWorldView, IAiBehaviour } from '../contracts/IAiBehaviour.js';

/**
 * Drifting asteroid: contributes no impulse. Motion is purely whatever Rapier
 * imparts via initial velocity and collisions. When the body settles, the
 * worker's sleep poll trips `FLAG_SLEEPING` and broadcasting drops to zero.
 */
export class DriftingAsteroidBehaviour implements IAiBehaviour {
  // Reused across calls so the AI controller's hot path doesn't allocate.
  private static readonly ZERO: AiIntent = Object.freeze({ fx: 0, fy: 0, torque: 0 }) as AiIntent;

  tick(_self: AiEntity, _view: AiWorldView): AiIntent {
    return DriftingAsteroidBehaviour.ZERO;
  }
}
