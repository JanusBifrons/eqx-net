/**
 * SquadTraversal — moves squad members across the galaxy graph hop by hop:
 * the rally-before-breach hold, the per-hop spool choice, and the one hop
 * choke point that starts a member's `BotTransitController` and announces it
 * on the incoming banner. Moved verbatim out of `LivingWorldDirector.ts`;
 * driven from the director's control tick (wave steps, roam, herding), never
 * the 60 Hz loop.
 */
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { BotTransitController } from '../BotTransitController.js';
import { nextHopToward } from '../population.js';
import type { LivingWorldRoom } from '../LivingWorldRoom.js';
import type { BotRecord, HunterBotPool } from './HunterBotPool.js';
import type { HunterBotWarpController } from './HunterBotWarpController.js';
import type { IncomingBanners } from './IncomingBanners.js';

/**
 * Per-hop vulnerable spool length. A WAVE's FINAL approach into its target sector
 * uses the long `waveApproachMs` (≈ the player's 30 s warp) so the attack
 * TELEGRAPHS with a real "incoming" countdown; every other hop — intermediate
 * wave hops AND roam hops (roamers are never a wave, so `isWave` is false) — uses
 * the fast `normalMs` so a multi-hop wave still converges. The 2026-06-19 playtest
 * "the attack came out of nowhere with 2.5 s warning" fix, decoupled + unit-locked.
 */
export function hopSpoolMs(
  isWave: boolean,
  isFinalApproach: boolean,
  normalMs: number,
  waveApproachMs: number,
): number {
  return isWave && isFinalApproach ? waveApproachMs : normalMs;
}

/**
 * Campaign 4.2 — rally-before-breach (pure decision). While a WAVE squad is in
 * its `warping` phase, members whose next hop IS the goal (they sit at the
 * "rally ring" — a sector adjacent to the target) are HELD there until every
 * other traversing member has reached the ring too, then all begin the final
 * approach in the SAME control tick — the squad breaches together instead of
 * trickling in 1-2 at a time ("squads of 8 but only 1-2 ever seen").
 *
 * @param atRing   active members whose next hop is the goal (held candidates)
 * @param pending  members still traversing toward the ring (active mid-route +
 *                 in-transit); respawning members never count — a perpetual
 *                 respawn-straggler cycle must not stall the wave, hence:
 * @param heldSinceMs  when this squad's hold window opened (null = not held yet)
 * @param rallyMaxMs   time-box: past this, the staged members breach anyway
 */
export function decideRallyRelease(
  atRing: number,
  pending: number,
  heldSinceMs: number | null,
  nowMs: number,
  rallyMaxMs: number,
): boolean {
  if (atRing === 0) return true; // nothing at the ring — nothing to hold
  if (pending === 0) return true; // fully staged — breach together
  if (heldSinceMs === null) return false; // open the hold window
  return nowMs - heldSinceMs >= rallyMaxMs; // time-boxed release
}

export interface SquadTraversalDeps {
  rooms: Map<string, LivingWorldRoom>;
  pool: HunterBotPool;
  warp: Pick<HunterBotWarpController, 'depart' | 'onTransitOutcome'>;
  incoming: Pick<IncomingBanners, 'announceHop'>;
  opts: { spoolMs: number; waveApproachSpoolMs: number; rallyMaxMs: number };
  nowMs: () => number;
}

export class SquadTraversal {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly pool: HunterBotPool;
  private readonly warp: SquadTraversalDeps['warp'];
  private readonly incoming: SquadTraversalDeps['incoming'];
  private readonly opts: SquadTraversalDeps['opts'];
  private readonly nowMs: () => number;
  /** Campaign 4.2 — per-squad rally-hold window open time (squadId → nowMs).
   *  Entry exists only while a warping wave squad is actively held at the rally
   *  ring; cleared on release, attack, retreat, or losing the wave assignment. */
  private readonly rallyHeldSince = new Map<string, number>();

  constructor(deps: SquadTraversalDeps) {
    this.rooms = deps.rooms;
    this.pool = deps.pool;
    this.warp = deps.warp;
    this.incoming = deps.incoming;
    this.opts = deps.opts;
    this.nowMs = deps.nowMs;
  }

  /**
   * Warp every active member that isn't yet at the squad's goal (`sq.sectorKey`)
   * ONE galaxy-graph hop toward it (`nextHopToward`). Re-issued each control
   * tick while a squad is warping / attacking / roaming, so members traverse the
   * graph hop-by-hop and independently — a member that respawns in from an entry
   * sector or straggles behind keeps flowing toward the goal without any
   * squad-level "current location" bookkeeping (the multiset of member
   * `rec.sectorKey` IS the squad's position).
   *
   * `in-transit` members are skipped (the per-leg `BotTransitController` is
   * single-use; only `active` members not yet at their next hop are re-tasked).
   * Returns the number of members that began the FINAL leg (`nextHop === goal`)
   * this tick — the trigger for the one-shot warp-in warning.
   */
  advanceMembersTowardGoal(squad: {
    squadId?: string;
    state?: string;
    botIds: readonly string[];
    sectorKey: string;
    targetFactionId?: string | null;
  }): number {
    const goal = squad.sectorKey;
    // A WAVE (tasked against a faction) telegraphs its FINAL approach into the
    // target with a long spool; everything else (intermediate wave hops, roam
    // hops) stays fast so traversal still converges. `targetFactionId` is unset
    // for roaming squads ⇒ they never get the slow approach.
    const isWave = squad.targetFactionId != null;

    // Campaign 4.2 — rally-before-breach: pre-breach (`warping` phase only), a
    // wave member whose next hop IS the goal holds at that rally-ring sector
    // until every traversing squadmate reaches the ring too — then the whole
    // group begins the (long, telegraphed) final approach in ONE control tick
    // and breaches together. Time-boxed via `decideRallyRelease` so a perpetual
    // respawn-straggler cycle can't stall the wave. An ATTACKING squad is never
    // held — reinforcements flow into the fight exactly as before.
    let releaseFinal = true;
    if (isWave && squad.state === 'warping' && squad.squadId !== undefined) {
      let atRing = 0;
      let pending = 0;
      for (const botId of squad.botIds) {
        const rec = this.pool.get(botId);
        if (!rec) continue;
        if (rec.state === 'in-transit') {
          pending++;
          continue;
        }
        if (rec.state !== 'active' || rec.sectorKey === goal) continue; // respawning never blocks
        const hop = nextHopToward(rec.sectorKey, goal);
        if (hop === goal || (hop === null && this.rooms.has(goal))) atRing++;
        else if (hop !== null) pending++;
        // hop === null && goal unreachable: the member can't route — never blocks.
      }
      const held = this.rallyHeldSince.get(squad.squadId) ?? null;
      releaseFinal = decideRallyRelease(atRing, pending, held, this.nowMs(), this.opts.rallyMaxMs);
      if (releaseFinal) this.rallyHeldSince.delete(squad.squadId);
      else if (held === null) this.rallyHeldSince.set(squad.squadId, this.nowMs());
    } else if (squad.squadId !== undefined) {
      this.rallyHeldSince.delete(squad.squadId);
    }

    let finalApproach = 0;
    for (const botId of squad.botIds) {
      const rec = this.pool.get(botId);
      if (!rec || rec.state !== 'active' || rec.sectorKey === goal) continue;
      let hop = nextHopToward(rec.sectorKey, goal);
      if (hop === null) {
        // No galaxy-graph route from here to the goal. In production every wave
        // target is a real graph sector, so this only happens for a goal that's
        // a LIVE room outside the graph (a synthetic test/engineering sector) —
        // hop directly to it. (Still a despawn→spawn pair, never a from-nowhere
        // ingress, so the entry-only-ingress invariant holds.) Truly unreachable
        // ⇒ leave the member.
        if (this.rooms.has(goal)) hop = goal;
        else continue;
      }
      const isFinalApproach = hop === goal;
      if (isFinalApproach && !releaseFinal) continue; // 4.2 — hold at the rally ring
      const spoolMs = hopSpoolMs(isWave, isFinalApproach, this.opts.spoolMs, this.opts.waveApproachSpoolMs);
      this.startSquadMemberTransit(rec, rec.sectorKey, hop, spoolMs);
      if (isFinalApproach) finalApproach++;
    }
    return finalApproach;
  }

  /** Spool one squad member from→to via the proven per-bot transit machinery
   *  (vulnerable spool, race-guarded outcome routing). Extracted from the old
   *  distribution-migration loop. */
  private startSquadMemberTransit(
    rec: BotRecord,
    from: string,
    to: string,
    spoolMs: number = this.opts.spoolMs,
  ): void {
    const fromRoom = this.rooms.get(from);
    if (!fromRoom) return;
    rec.state = 'in-transit';
    const ctrl = new BotTransitController(rec.botId, fromRoom.eventBus(), spoolMs);
    rec.controller = ctrl;
    fromRoom.eventBus().emit('BOT_TRANSIT_STARTED', {
      type: 'BOT_TRANSIT_STARTED',
      botId: rec.botId,
      from,
      to,
    });
    // Phase-4 P0 — announce the hop on the banner (`IncomingBanners`).
    this.incoming.announceHop(rec, from, to, spoolMs);
    serverLogEvent('bot_transit_start', { botId: rec.botId, from, to });
    ctrl.begin({
      now: this.nowMs,
      commit: () => this.warp.depart(rec, from, to),
      outcome: (res) => this.warp.onTransitOutcome(rec, from, to, res),
    });
  }
}
