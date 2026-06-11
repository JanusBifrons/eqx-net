/**
 * WaveDirector — assigns idle squads to ready faction bases and advances each
 * squad's state machine (wave-system plan, Phase 4).
 *
 * It is the DECISION layer: it polls every room's `factionBaseReadiness()`,
 * assigns spare squads to ready, un-waved factions via a `WavePattern`, then
 * runs each squad's `SquadBehaviour` to produce a list of `WaveStep`s. The
 * `LivingWorldDirector` EXECUTES the steps (issue the coordinated 8-bot warp,
 * mark hostility, retreat + purge) — keeping the bus / transit / room
 * machinery out of this testable unit (mirrors how `HunterBotDistribution.plan`
 * returns migrations the director executes).
 *
 * De-escalation (req #8) is computed here from the pure `shouldDeEscalate`
 * (no surviving miners AND peaceful past the timeout) — a squad whose faction
 * de-escalated gets a `retreat` step.
 */

import { shouldDeEscalate, FACTION_PEACEFUL_TIMEOUT_TICKS } from '../../../core/faction/Faction.js';
import type { FactionBaseReadiness, LivingWorldRoom } from '../LivingWorldRoom.js';
import type { HunterBotPool } from './HunterBotPool.js';
import { SquadPool, type SquadRecord } from './SquadPool.js';
import type { SquadBehaviour } from './SquadBehaviour.js';
import type { WavePattern } from './WavePattern.js';

export type WaveStep =
  | { kind: 'warp'; squad: SquadRecord; to: string }
  | { kind: 'attack'; squad: SquadRecord; factionId: string; sectorKey: string }
  | { kind: 'retreat'; squad: SquadRecord; factionId: string; sectorKey: string };

export interface WaveDirectorOptions {
  rooms: Map<string, LivingWorldRoom>;
  squadPool: SquadPool;
  hunterPool: HunterBotPool;
  behaviour: SquadBehaviour;
  pattern: WavePattern;
  /** Peaceful window (ticks) for de-escalation; defaults to the faction const. */
  peacefulTimeoutTicks?: number;
  /** Minimum wall-clock spacing (ms) between dispatches against the SAME ready
   *  faction. The director routes at most one squad per this window at a base,
   *  so a base that's been ready a long time isn't swarmed (drone-warp-in
   *  design: "one squad per ~5 min"). Defaults to 5 min. */
  dispatchIntervalMs?: number;
}

/** Default dispatch cadence: one squad per ready faction per 5 minutes. */
export const DEFAULT_DISPATCH_INTERVAL_MS = 300_000;

export class WaveDirector {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly squadPool: SquadPool;
  private readonly hunterPool: HunterBotPool;
  private readonly behaviour: SquadBehaviour;
  private readonly pattern: WavePattern;
  private readonly peacefulTimeoutTicks: number;
  private readonly dispatchIntervalMs: number;
  /** factionId → wave count (for the WavePattern; v1 unused beyond 1). */
  private readonly waveCount = new Map<string, number>();
  /** factionId → wall-clock of the last squad dispatch against it (the
   *  ≤1-per-`dispatchIntervalMs` rate cap anchor). */
  private readonly lastDispatchAtMs = new Map<string, number>();

  constructor(opts: WaveDirectorOptions) {
    this.rooms = opts.rooms;
    this.squadPool = opts.squadPool;
    this.hunterPool = opts.hunterPool;
    this.behaviour = opts.behaviour;
    this.pattern = opts.pattern;
    this.peacefulTimeoutTicks = opts.peacefulTimeoutTicks ?? FACTION_PEACEFUL_TIMEOUT_TICKS;
    this.dispatchIntervalMs = opts.dispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS;
  }

  /** Plan this control tick. Pure of side effects — returns the steps the
   *  director executes. Each faction's de-escalation uses ITS room's serverTick
   *  (carried on the readiness entry), not a single director clock. `nowMs` is
   *  the director's wall-clock, used ONLY for the dispatch rate-cap (the
   *  de-escalation comparison still uses each room's own serverTick). */
  plan(nowMs: number): WaveStep[] {
    // Gather readiness across all rooms (one entry per base-owning faction).
    const readiness = new Map<string, FactionBaseReadiness>();
    for (const room of this.rooms.values()) {
      for (const r of room.factionBaseReadiness()) readiness.set(r.factionId, r);
    }

    this.assignReadyFactions(readiness, nowMs);

    const steps: WaveStep[] = [];
    for (const sq of this.squadPool.all()) {
      const ctx = this.buildContext(sq, readiness);
      const action = this.behaviour.decide(sq, ctx);
      switch (action.kind) {
        case 'hold':
          break;
        case 'warp':
          steps.push({ kind: 'warp', squad: sq, to: action.to });
          break;
        case 'attack':
          steps.push({
            kind: 'attack',
            squad: sq,
            factionId: action.factionId,
            sectorKey: sq.sectorKey,
          });
          break;
        case 'retreat':
          if (sq.targetFactionId !== null) {
            steps.push({
              kind: 'retreat',
              squad: sq,
              factionId: sq.targetFactionId,
              sectorKey: sq.sectorKey,
            });
          }
          break;
      }
    }
    return steps;
  }

  /** Assign one idle, unassigned squad to each ready, un-waved faction that
   *  doesn't already have a squad on it (WavePattern decides count; v1 = 1),
   *  rate-capped to ≤1 dispatch per `dispatchIntervalMs` per faction. */
  private assignReadyFactions(readiness: Map<string, FactionBaseReadiness>, nowMs: number): void {
    const assigned = new Set<string>();
    for (const sq of this.squadPool.all()) {
      if (sq.targetFactionId !== null) assigned.add(sq.targetFactionId);
    }
    for (const [factionId, r] of readiness) {
      // Only START a wave against a ready base whose owner is present (online in
      // the sector) — the warning + countdown is meaningless if they're offline
      // and can't defend. An already-assigned wave continues regardless.
      if (!r.ready || !r.ownerPresent || assigned.has(factionId)) continue;
      // Rate cap: at most one squad per `dispatchIntervalMs` per faction. The
      // first dispatch (no record) is immediate; after a wave stands down the
      // next one against the same base waits out the window (drone-warp-in
      // design: "one squad per ~5 min"). The squad still TRAVERSES hop-by-hop
      // from wherever it is, so its arrival is further delayed by travel.
      const last = this.lastDispatchAtMs.get(factionId);
      if (last !== undefined && nowMs - last < this.dispatchIntervalMs) continue;
      const wave = (this.waveCount.get(factionId) ?? 0) + 1;
      const spec = this.pattern.nextWave(wave);
      let committed = 0;
      for (const sq of this.squadPool.all()) {
        if (committed >= spec.squadCount) break;
        if (sq.state !== 'idle' || sq.targetFactionId !== null) continue;
        this.squadPool.assignTarget(sq, r.sectorKey, factionId);
        committed++;
      }
      if (committed > 0) {
        this.waveCount.set(factionId, wave);
        this.lastDispatchAtMs.set(factionId, nowMs);
        assigned.add(factionId);
      }
    }
  }

  private buildContext(
    sq: SquadRecord,
    readiness: Map<string, FactionBaseReadiness>,
  ): { membersInSector: number; membersActive: number; factionStillHostile: boolean } {
    const isActive = (botId: string): boolean => this.hunterPool.get(botId)?.state === 'active';
    const isActiveInSector = (botId: string): boolean => {
      const rec = this.hunterPool.get(botId);
      return rec?.state === 'active' && rec.sectorKey === sq.sectorKey;
    };
    const membersActive = this.squadPool.activeMemberCount(sq, isActive);
    const membersInSector = this.squadPool.activeMemberCount(sq, isActiveInSector);

    let factionStillHostile = true;
    if (sq.targetFactionId !== null) {
      const r = readiness.get(sq.targetFactionId);
      if (!r) {
        // Base gone entirely (every structure destroyed) → stand down.
        factionStillHostile = false;
      } else {
        const deescalated = shouldDeEscalate(
          {
            id: sq.targetFactionId,
            hostileToDrones: r.hostileToDrones,
            lastDealtDamageTick: r.lastDealtDamageTick,
            underWave: r.underWave,
          },
          {
            minerCount: r.minerCount,
            nowTick: r.serverTick,
            peacefulTimeoutTicks: this.peacefulTimeoutTicks,
          },
        );
        factionStillHostile = !deescalated;
      }
    }
    return { membersInSector, membersActive, factionStillHostile };
  }
}
