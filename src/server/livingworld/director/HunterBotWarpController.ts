/**
 * Atomic cross-room hop + transit-outcome routing.
 *
 * Owns `doHop` (the from→to despawn-then-respawn transaction that
 * pre-checks the destination slot BEFORE despawning the source) and
 * `onTransitOutcome` (the 'arrived'/'failed'/'destroyed' router that
 * defers to the pool's idempotent state-machine guards).
 */

import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { sectorEdgePose, type Rng } from '../population.js';
import type { LivingWorldRoom } from '../LivingWorldRoom.js';
import type { HunterBotPool, BotRecord } from './HunterBotPool.js';

export interface HunterBotWarpControllerOptions {
  rooms: Map<string, LivingWorldRoom>;
  pool: HunterBotPool;
  rng: Rng;
  respawnDelayMs: number;
}

export class HunterBotWarpController {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly pool: HunterBotPool;
  private readonly rng: Rng;
  private readonly respawnDelayMs: number;

  constructor(opts: HunterBotWarpControllerOptions) {
    this.rooms = opts.rooms;
    this.pool = opts.pool;
    this.rng = opts.rng;
    this.respawnDelayMs = opts.respawnDelayMs;
  }

  /** The atomic cross-room hop, invoked by the controller at spool end.
   *  Pre-checks the destination slot BEFORE despawning the source so a
   *  transit can't lose a bot to slot exhaustion. */
  doHop(rec: BotRecord, from: string, to: string): boolean {
    const src = this.rooms.get(from);
    const dest = this.rooms.get(to);
    if (!src || !dest) return false;
    if (!dest.hasFreeSlot()) return false; // bot stays put; director retries
    const carry = src.despawnLivingWorldBot(rec.botId);
    if (!carry) return false; // already gone (killed/shed mid-spool) — handler owns it
    const pose = sectorEdgePose(this.rng);
    const ok = dest.spawnLivingWorldBot({
      botId: rec.botId,
      kind: carry.kind,
      x: pose.x,
      y: pose.y,
      vx: pose.vx,
      vy: pose.vy,
      health: carry.health,
    });
    if (!ok) {
      // True race: pre-check passed but the slot was taken between. The
      // bot already left the source — self-heal by warping it back in
      // from no-origin so the population converges back to N.
      rec.kind = carry.kind;
      this.pool.scheduleRespawn(rec, this.respawnDelayMs);
      return true; // accounted for via the respawn path
    }
    rec.kind = carry.kind;
    serverLogEvent('bot_transit_commit', { botId: rec.botId, from, to });
    return true;
  }

  onTransitOutcome(
    rec: BotRecord,
    from: string,
    to: string,
    res: 'arrived' | 'failed' | 'destroyed',
  ): void {
    // A lifecycle event (kill / shed / emergency respawn) may have taken
    // ownership while the controller settled — guard so we never clobber
    // a 'respawning' record back to 'active'.
    if (rec.state !== 'in-transit') return;
    if (res === 'arrived') {
      this.pool.markActive(rec, to);
    } else if (res === 'failed') {
      // never left the source
      this.pool.markActive(rec, from);
      serverLogEvent('bot_transit_cancel', { botId: rec.botId, from, result: 'failed' });
    } else {
      // 'destroyed' but the ENTITY_DESTROYED handler hasn't run yet
      // (subscription-order race) — own the transition here; the handler
      // is idempotent when it follows.
      this.pool.scheduleRespawn(rec, this.respawnDelayMs);
    }
  }
}
