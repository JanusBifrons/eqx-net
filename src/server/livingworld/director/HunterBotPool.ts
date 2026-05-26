/**
 * Per-bot lifecycle state + the fixed pool of hunter records.
 *
 * Owns the `Map<botId, BotRecord>`, the BotState machine, and the
 * idempotent `scheduleRespawn` transition. Pure of any room / bus
 * knowledge — the LivingWorldDirector composes this against rooms.
 *
 * The state machine (`active`/`in-transit`/`respawning`) is guarded +
 * idempotent so overlapping signals (kill / shed / emergency-respawn /
 * transit-outcome) converge instead of racing.
 */

import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { SHIP_KINDS_LIST, type ShipKindId } from '../../../shared-types/shipKinds.js';
import type { BotTransitController } from '../BotTransitController.js';
import type { Rng } from '../population.js';

export type BotState = 'active' | 'in-transit' | 'respawning';

export interface BotRecord {
  botId: string;
  kind: ShipKindId;
  /** Sector the bot is in while `active`; last sector otherwise. */
  sectorKey: string;
  state: BotState;
  /** Wall-clock the bot may (re)spawn — gated additionally by shed
   *  recovery. Meaningful only while `respawning`. */
  respawnAtMs: number;
  /** Wall-clock the bot last arrived somewhere (arrival-cooldown anchor). */
  arrivedAtMs: number;
  controller: BotTransitController | null;
}

export interface DirectorSnapshot {
  total: number;
  active: number;
  inTransit: number;
  respawning: number;
  perSector: Record<string, { players: number; bots: number }>;
}

export interface HunterBotPoolOptions {
  botCount: number;
  /** Initial warp-ins are spread out by this step so N bots don't all
   *  appear on the same tick. */
  initialStaggerMs: number;
  rng: Rng;
  nowMs: () => number;
}

/**
 * Roster of hunter bots. Owns the lifecycle state machine; the
 * orchestrator drives transitions via `scheduleRespawn`, `markActive`,
 * `markInTransit`.
 */
export class HunterBotPool {
  private readonly bots = new Map<string, BotRecord>();
  private readonly opts: HunterBotPoolOptions;

  constructor(opts: HunterBotPoolOptions) {
    this.opts = opts;
  }

  /** Seed the pool with `botCount` initially-respawning records. */
  seed(initialSectorKey: string): void {
    const now = this.opts.nowMs();
    for (let i = 0; i < this.opts.botCount; i++) {
      const botId = `lwbot-${i}`;
      const kind =
        SHIP_KINDS_LIST[Math.floor(this.opts.rng() * SHIP_KINDS_LIST.length)]!.id;
      this.bots.set(botId, {
        botId,
        kind,
        sectorKey: initialSectorKey,
        state: 'respawning',
        respawnAtMs: now + i * this.opts.initialStaggerMs,
        arrivedAtMs: now,
        controller: null,
      });
    }
  }

  get(botId: string): BotRecord | undefined {
    return this.bots.get(botId);
  }

  values(): IterableIterator<BotRecord> {
    return this.bots.values();
  }

  size(): number {
    return this.bots.size;
  }

  /** Idempotent: a record already heading for respawn is left alone, so
   *  overlapping kill / shed / emergency / transit-outcome signals
   *  converge to a single scheduled warp-in. */
  scheduleRespawn(rec: BotRecord, delayMs: number): void {
    if (rec.state === 'respawning') return;
    rec.state = 'respawning';
    rec.respawnAtMs = this.opts.nowMs() + delayMs;
    rec.controller?.dispose();
    rec.controller = null;
    serverLogEvent('bot_respawn', { botId: rec.botId, sectorKey: rec.sectorKey, delayMs });
  }

  /** Mark a bot as freshly-arrived in `sectorKey`. Anchor for the
   *  arrival cooldown. */
  markActive(rec: BotRecord, sectorKey: string): void {
    rec.state = 'active';
    rec.sectorKey = sectorKey;
    rec.arrivedAtMs = this.opts.nowMs();
    rec.controller = null;
  }

  /** Drop all controllers (stop-time teardown). */
  disposeControllers(): void {
    for (const rec of this.bots.values()) {
      rec.controller?.dispose();
      rec.controller = null;
    }
  }

  /** Read-only counts for the `/dev/population` route + tests. */
  snapshot(
    sectorKeys: string[],
    perSectorPlayers: (sectorKey: string) => number,
  ): DirectorSnapshot {
    const perSector: DirectorSnapshot['perSector'] = {};
    for (const k of sectorKeys) {
      perSector[k] = { players: perSectorPlayers(k), bots: 0 };
    }
    let active = 0;
    let inTransit = 0;
    let respawning = 0;
    for (const rec of this.bots.values()) {
      if (rec.state === 'active') {
        active++;
        const ps = perSector[rec.sectorKey];
        if (ps) ps.bots++;
      } else if (rec.state === 'in-transit') inTransit++;
      else respawning++;
    }
    return { total: this.bots.size, active, inTransit, respawning, perSector };
  }
}
