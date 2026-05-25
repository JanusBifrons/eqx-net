/**
 * AI controller + per-tick view scratch for SectorRoom.
 *
 * Step 10 of the hazy-pillow decomposition plan — relocates the AI
 * controller handle + the reused player-view scratch array.
 *
 * The `AiController` is created in SectorRoom.onCreate (it needs the
 * `bus` reference there) and assigned to `this.ai.controller` via
 * `setController(...)`. Pre-assignment access throws (matches the
 * `!` non-null assertion the field used to carry).
 *
 * `tick(ctx)` and `drainFire(ctx)` method bodies remain in SectorRoom
 * for now — the tick consumes shipPoseCache + state.ships + swarm
 * registry, and the fire-drain calls into the combat path. Those
 * migrate once their collaborators stabilise.
 */

import type { AiController } from '../../core/ai/AiController.js';
import type { AiPlayerView } from '../../core/contracts/IAiBehaviour.js';

export class AiSubsystem {
  /** Reused per-tick view passed to AiController.tick — mutated in
   *  place to avoid per-tick allocation. */
  readonly scratch: AiPlayerView[] = [];

  private _controller: AiController | null = null;

  setController(controller: AiController): void {
    this._controller = controller;
  }

  get controller(): AiController {
    if (this._controller === null) {
      throw new Error('AiSubsystem: controller not initialised');
    }
    return this._controller;
  }
}
