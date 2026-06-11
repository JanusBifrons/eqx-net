/**
 * Inter-sector hop = depart-then-(travel)-then-arrive + transit-outcome routing.
 *
 * The cross-room hop is SPLIT into two halves so a bot spends a real
 * `hopTravelMs` flight time "between sectors" (the drone-warp-in design's
 * emergent travel: farther = longer, hop-by-hop):
 *
 *   - `depart(rec, from, to)` — runs at spool-end (the controller's `commit`).
 *     Pre-checks the destination free slot, despawns the bot from the SOURCE
 *     (stashing its carry: kind/health), then starts a per-bot arrival timer of
 *     `hopTravelMs`. Returns `true` iff the bot actually left the source.
 *   - `arrive(rec, from, to, carry)` — runs when that timer fires. Re-checks
 *     the destination slot (it can be lost during flight) and spawns the bot at
 *     the dest edge; self-heals via `scheduleRespawn` on a slot race, else
 *     `markActive`.
 *
 * Between depart and arrive the bot is in NO room — fully despawned — so the
 * flight window is invulnerable BY CONSTRUCTION (no live entity to shoot, no
 * `ENTITY_DESTROYED` to race). `markActive` fires ONLY at arrive, so the record
 * stays `in-transit` across the whole flight. `onTransitOutcome` routes the
 * controller's spool result: `'arrived'` means "departed OK" (the arrival timer
 * owns the rest), `'failed'` means the bot never left (stay put), `'destroyed'`
 * means it was killed during the vulnerable spool (respawn).
 */

import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { sectorEdgePose, type Rng } from '../population.js';
import type { LivingWorldRoom } from '../LivingWorldRoom.js';
import type { BotCarry } from '../botTypes.js';
import type { HunterBotPool, BotRecord } from './HunterBotPool.js';

export interface HunterBotWarpControllerOptions {
  rooms: Map<string, LivingWorldRoom>;
  pool: HunterBotPool;
  rng: Rng;
  respawnDelayMs: number;
  /** Invulnerable inter-sector flight time (ms). 0 ⇒ effectively instant
   *  arrival (deferred one macrotask). */
  hopTravelMs: number;
}

export class HunterBotWarpController {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly pool: HunterBotPool;
  private readonly rng: Rng;
  private readonly respawnDelayMs: number;
  private readonly hopTravelMs: number;
  /** botId → pending arrival timer (the in-flight window). Cleared on
   *  `disposePending` (director stop) so no timer fires into a torn-down room. */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: HunterBotWarpControllerOptions) {
    this.rooms = opts.rooms;
    this.pool = opts.pool;
    this.rng = opts.rng;
    this.respawnDelayMs = opts.respawnDelayMs;
    this.hopTravelMs = opts.hopTravelMs;
  }

  /** Spool-end half of the hop: pre-check the dest slot, despawn the bot from
   *  the source, then arm the `hopTravelMs` arrival timer. Returns `true` iff
   *  the bot left the source (⇒ the controller reports `'arrived'`, i.e.
   *  "departed OK"); `false` ⇒ it stays put for the director to retry. */
  depart(rec: BotRecord, from: string, to: string): boolean {
    const src = this.rooms.get(from);
    const dest = this.rooms.get(to);
    if (!src || !dest) return false;
    if (!dest.hasFreeSlot()) return false; // bot stays put; director retries
    const carry = src.despawnLivingWorldBot(rec.botId);
    if (!carry) return false; // already gone (killed/shed mid-spool) — handler owns it
    serverLogEvent('bot_transit_depart', { botId: rec.botId, from, to });
    const timer = setTimeout(() => {
      this.pending.delete(rec.botId);
      this.arrive(rec, from, to, carry);
    }, this.hopTravelMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pending.set(rec.botId, timer);
    return true;
  }

  /** Arrival half of the hop (fires `hopTravelMs` after `depart`). The bot is
   *  currently in no room; spawn it at the destination edge. A lifecycle event
   *  could have taken ownership while in flight (guarded), and the dest slot can
   *  be lost during flight (self-heal). */
  private arrive(rec: BotRecord, from: string, to: string, carry: BotCarry): void {
    // A kill/shed signal can only land on a record that is in a room, and the
    // bot has been despawned for the whole flight — but guard defensively so a
    // late lifecycle transition is never clobbered back to active.
    if (rec.state !== 'in-transit') return;
    const dest = this.rooms.get(to);
    if (!dest || !dest.hasFreeSlot()) {
      // Dest gone / slot lost during flight — self-heal: re-enter from
      // no-origin so the population converges back to N.
      rec.kind = carry.kind;
      this.pool.scheduleRespawn(rec, this.respawnDelayMs);
      return;
    }
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
      rec.kind = carry.kind;
      this.pool.scheduleRespawn(rec, this.respawnDelayMs);
      return;
    }
    rec.kind = carry.kind;
    this.pool.markActive(rec, to);
    serverLogEvent('bot_transit_commit', { botId: rec.botId, from, to });
  }

  /** Route the controller's spool outcome. `'arrived'` ⇒ the bot departed OK
   *  and the arrival timer (started in `depart`) owns the spawn/self-heal — so
   *  this is a no-op for that case (the record stays `in-transit` until arrive).
   *  `'failed'`/`'destroyed'` are handled here as before. */
  onTransitOutcome(
    rec: BotRecord,
    from: string,
    _to: string,
    res: 'arrived' | 'failed' | 'destroyed',
  ): void {
    // A lifecycle event (kill / shed / emergency respawn) may have taken
    // ownership while the controller settled — guard so we never clobber a
    // 'respawning' record back to 'active'.
    if (rec.state !== 'in-transit') return;
    if (res === 'arrived') {
      // Departed; the in-flight arrival timer completes the hop. Nothing here.
      return;
    }
    if (res === 'failed') {
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

  /** Clear all in-flight arrival timers (director stop / teardown). Idempotent.
   *  The bots stay despawned (mid-flight) — the director is tearing down. */
  disposePending(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
