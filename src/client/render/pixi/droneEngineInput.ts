/**
 * An AI ship's boost input for the engine exhaust (FxEngines).
 *
 * A pilot's ship passes its real boost key (`mirror.boostingShips`). An AI
 * ship's pilot holds the same key, which the snapshot carries as
 * `drones[].boost` → `SwarmRenderState.boosting` (#16), so its boost flame is
 * the same as a pilot's: on while the key is held, off when it is let go.
 * Thrust has no key on the wire, so it still follows speed (-1).
 */
import type { EngineInput } from '../art/fx/FxEngines.js';

export function droneBoostInput(entry: { boosting?: boolean } | undefined): EngineInput {
  return entry?.boosting === true ? 1 : 0;
}
