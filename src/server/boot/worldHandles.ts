import type { LivingWorldDirector } from '../livingworld/LivingWorldDirector.js';
import type { RobotTerritory } from '../livingworld/RobotTerritory.js';
import type { EliteDirector } from '../livingworld/EliteDirector.js';
import type { FlagshipDirector } from '../livingworld/FlagshipDirector.js';
import type { EventDirector } from '../livingworld/EventDirector.js';
import type { EconomyStore } from '../economy/EconomyStore.js';
import type { TradeDirector } from '../economy/TradeDirector.js';
import type { ConvoyDirector } from '../economy/ConvoyDirector.js';

/**
 * The process-global directors the boot steps start. Owned by `index.ts`
 * (one mutable record), filled in by `startLivingWorld()` / `startEconomy()`,
 * read by the dev router getters and `shutdown()`. Every field stays null
 * when its kill switch is set or until boot reaches it.
 */
export interface WorldHandles {
  /** Process-global Living World population brain. Constructed in `main()`
   *  after the eager galaxy rooms exist; stopped on shutdown. */
  livingWorldDirector: LivingWorldDirector | null;
  /** Living World P1b — the robot-side director (null when disarmed). */
  robotDirector: LivingWorldDirector | null;
  /** Living World P3 — robot territory + nexus (null when robots are disarmed). */
  robotTerritory: RobotTerritory | null;
  /** Living World P4a — named elites (null when the Living World is disabled). */
  eliteDirector: EliteDirector | null;
  flagshipDirector: FlagshipDirector | null;
  /** Living World P4b — world events (null when the Living World is disabled). */
  eventDirector: EventDirector | null;
  /** Living World P2 — the economy (null until boot finishes). */
  economyStore: EconomyStore | null;
  tradeDirector: TradeDirector | null;
  convoyDirector: ConvoyDirector | null;
}

export function createWorldHandles(): WorldHandles {
  return {
    livingWorldDirector: null,
    robotDirector: null,
    robotTerritory: null,
    eliteDirector: null,
    flagshipDirector: null,
    eventDirector: null,
    economyStore: null,
    tradeDirector: null,
    convoyDirector: null,
  };
}
