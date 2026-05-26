/**
 * The narrow surface the LivingWorldDirector drives. `SectorRoom`
 * satisfies this structurally (Step 3 hooks + the `eventBus`
 * accessor); the director never imports the 3.8k-line room.
 *
 * Extracted from `LivingWorldDirector.ts` so the room-side type lives
 * next to the director sub-modules that consume it.
 */

import type { Bus } from '../../core/events/Bus.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { BotCarry } from './botTypes.js';

export interface LivingWorldRoom {
  eventBus(): Bus;
  playerCount(): number;
  hasFreeSlot(): boolean;
  spawnLivingWorldBot(spec: {
    botId: string;
    kind: ShipKindId;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    health?: number;
  }): boolean;
  despawnLivingWorldBot(botId: string): BotCarry | null;
  markBotHostile(botId: string): void;
}
