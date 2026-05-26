/**
 * Per-sector distribution policy + occupancy hysteresis.
 *
 * Composes the pure `population` math against player-counts +
 * arrival-cooldown gating. Owns the `sectorPlayerSeenAtMs` map (the
 * sticky-occupancy guard against mobile reconnect-flap warp-churn —
 * diag 2026-05-16 q272do).
 */

import {
  computeDesiredDistribution,
  planMigrations,
  type Migration,
} from '../population.js';
import type { HunterBotPool, BotRecord } from './HunterBotPool.js';

export interface DistributionInputs {
  sectorKeys: string[];
  /** Live `room.playerCount()` per sector. */
  livePlayerCounts: Map<string, number>;
  /** Wall-clock for stamping `sectorPlayerSeenAtMs`. */
  nowMs: number;
  /** Pool source so the migration plan can filter by active state. */
  pool: HunterBotPool;
  playerStickyMs: number;
  arrivalCooldownMs: number;
  maxMigrationsPerTick: number;
}

export class HunterBotDistribution {
  /** sectorKey → wall-clock the director last observed a live player
   *  there. Drives the `playerStickyMs` occupancy hysteresis. Bounded by
   *  the fixed sector set (≤7 keys); never leaks. */
  private readonly sectorPlayerSeenAtMs = new Map<string, number>();

  /**
   * Plan this tick's migrations. Returns the migration list AND the
   * activeCount that was used in the distribution computation (for
   * downstream callers that want to walk active bots).
   *
   * Player-occupancy hysteresis (`playerStickyMs`): a sector that had a
   * live player within the window still counts as occupied. Stops a
   * mobile connection flap (`playerCount → 0` for a few seconds) from
   * whipsawing the desired distribution between "all to the player" and
   * "even N-way spread" every control tick.
   */
  plan(input: DistributionInputs): { migrations: Migration[]; activeCount: number } {
    const playerCounts = new Map<string, number>();
    for (const [key, live] of input.livePlayerCounts) {
      if (live > 0) this.sectorPlayerSeenAtMs.set(key, input.nowMs);
      const lastSeen = this.sectorPlayerSeenAtMs.get(key) ?? -Infinity;
      const sticky = input.nowMs - lastSeen < input.playerStickyMs;
      playerCounts.set(key, live > 0 ? live : sticky ? 1 : 0);
    }

    const current = new Map<string, string[]>();
    for (const k of input.sectorKeys) current.set(k, []);
    const frozen = new Set<string>();
    let activeCount = 0;
    for (const rec of input.pool.values()) {
      if (rec.state !== 'active') continue;
      activeCount++;
      current.get(rec.sectorKey)?.push(rec.botId);
      if (input.nowMs - rec.arrivedAtMs < input.arrivalCooldownMs) {
        frozen.add(rec.botId);
      }
    }

    const desired = computeDesiredDistribution({
      sectorKeys: input.sectorKeys,
      playerCounts,
      budget: activeCount,
    });
    const migrations = planMigrations({
      sectorKeys: input.sectorKeys,
      current,
      desired,
      maxPerTick: input.maxMigrationsPerTick,
      frozen,
    });
    return { migrations, activeCount };
  }

  /** Iterate active bots → call `onActive(rec)` for each in the pool. */
  forEachActive(pool: HunterBotPool, onActive: (rec: BotRecord) => void): void {
    for (const rec of pool.values()) {
      if (rec.state === 'active') onActive(rec);
    }
  }
}
