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
 *
 * Phase-1 issue 4 — TIME-BOXED waves (2026-06-18). A 12 h playtest audit showed
 * waves NEVER resolved (`wave_repelled=0`): a base turret keeps the faction "at
 * war" so de-escalation can't fire, and killed wave members respawn at the
 * galaxy edge and trickle back, so a single squad ground on indefinitely and no
 * second wave was ever dispatched (one perpetual grind, not phased squad
 * assaults). A wave now also `retreat`s after `waveMaxAttackMs` of attacking —
 * a discrete PHASE — which frees the faction so the existing dispatch cadence
 * sends a FRESH squad next phase.
 */

import { shouldDeEscalate, FACTION_PEACEFUL_TIMEOUT_TICKS } from '../../../core/faction/Faction.js';
import { hopDistance } from '../population.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
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
  /** Phase-1 issue 4 — max wall-clock a squad stays `attacking` before the wave
   *  falls back (resolves). Bounds an assault to a discrete PHASE so the faction
   *  is freed for a fresh squad on the dispatch cadence. Defaults to 3 min (a
   *  FEEL knob — verify on-device). */
  waveMaxAttackMs?: number;
}

/** Default dispatch cadence: one squad per ready faction per 5 minutes. */
export const DEFAULT_DISPATCH_INTERVAL_MS = 300_000;

/** Default max attack duration before a wave falls back (phased assaults). Must
 *  be < the dispatch cadence so a lull separates phases. Feel knob. */
export const DEFAULT_WAVE_MAX_ATTACK_MS = 180_000;

export class WaveDirector {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly squadPool: SquadPool;
  private readonly hunterPool: HunterBotPool;
  private readonly behaviour: SquadBehaviour;
  private readonly pattern: WavePattern;
  private readonly peacefulTimeoutTicks: number;
  private readonly dispatchIntervalMs: number;
  private readonly waveMaxAttackMs: number;
  /** factionId → wave count (for the WavePattern; v1 unused beyond 1). */
  private readonly waveCount = new Map<string, number>();
  /** factionId → wall-clock of the last squad dispatch against it (the
   *  ≤1-per-`dispatchIntervalMs` rate cap anchor). */
  private readonly lastDispatchAtMs = new Map<string, number>();
  /** squadId → wall-clock it ENTERED `attacking` (the time-box anchor). Set the
   *  first plan() tick a squad is seen attacking; cleared when it leaves. */
  private readonly attackStartedAtMs = new Map<string, number>();

  constructor(opts: WaveDirectorOptions) {
    this.rooms = opts.rooms;
    this.squadPool = opts.squadPool;
    this.hunterPool = opts.hunterPool;
    this.behaviour = opts.behaviour;
    this.pattern = opts.pattern;
    this.peacefulTimeoutTicks = opts.peacefulTimeoutTicks ?? FACTION_PEACEFUL_TIMEOUT_TICKS;
    this.dispatchIntervalMs = opts.dispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS;
    this.waveMaxAttackMs = opts.waveMaxAttackMs ?? DEFAULT_WAVE_MAX_ATTACK_MS;
  }

  /**
   * Serialize the wave bookkeeping for director-state persistence (Phase 5 —
   * "restart from any state"). `waveCount` is monotonic and `lastDispatchAtMs`
   * is absolute wall-clock, so both restore meaningfully across a restart: a
   * base dispatched just before shutdown stays rate-capped on the next boot,
   * while a long-quiet base is immediately dispatchable.
   */
  serialize(): {
    waveCount: Array<[string, number]>;
    lastDispatchAtMs: Array<[string, number]>;
  } {
    return {
      waveCount: [...this.waveCount.entries()],
      lastDispatchAtMs: [...this.lastDispatchAtMs.entries()],
    };
  }

  /** Restore wave bookkeeping (Phase 5). Clears then repopulates both maps. */
  restore(state: {
    waveCount: ReadonlyArray<readonly [string, number]>;
    lastDispatchAtMs: ReadonlyArray<readonly [string, number]>;
  }): void {
    this.waveCount.clear();
    for (const [factionId, n] of state.waveCount) this.waveCount.set(factionId, n);
    this.lastDispatchAtMs.clear();
    for (const [factionId, ms] of state.lastDispatchAtMs) this.lastDispatchAtMs.set(factionId, ms);
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
      // Maintain the per-squad attack time-box anchor: stamp the first tick it's
      // seen attacking; clear it the moment it leaves (retreat / idle / re-warp).
      if (sq.state === 'attacking') {
        if (!this.attackStartedAtMs.has(sq.squadId)) this.attackStartedAtMs.set(sq.squadId, nowMs);
      } else {
        this.attackStartedAtMs.delete(sq.squadId);
      }
      const ctx = this.buildContext(sq, readiness, nowMs);
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
      // Equinox: a ready base draws a wave whether or not the owner is present
      // ("they should attack if the player is there or not"). The world stays
      // dangerous while you're away — the base's own turrets defend it, and an
      // undefended base eventually de-escalates (no surviving miners + peaceful
      // timeout). `ownerPresent` is still computed on the readiness entry for
      // telemetry, but it no longer gates the dispatch.
      if (!r.ready || assigned.has(factionId)) continue;
      // Rate cap: at most one squad per `dispatchIntervalMs` per faction. The
      // first dispatch (no record) is immediate; after a wave stands down the
      // next one against the same base waits out the window (drone-warp-in
      // design: "one squad per ~5 min"). The squad still TRAVERSES hop-by-hop
      // from wherever it is, so its arrival is further delayed by travel.
      const last = this.lastDispatchAtMs.get(factionId);
      if (last !== undefined && nowMs - last < this.dispatchIntervalMs) continue;
      const wave = (this.waveCount.get(factionId) ?? 0) + 1;
      const spec = this.pattern.nextWave(wave);
      // Dispatch the NEAREST idle squads (the user's directive: "review the
      // pools of drones … direct the nearest roaming groups towards the
      // player"). Sort spare squads by galaxy-graph hop distance to the ready
      // base, deterministic tie-break by squadId, then commit the closest N.
      const candidates: { sq: SquadRecord; dist: number }[] = [];
      for (const sq of this.squadPool.all()) {
        if (sq.state !== 'idle' || sq.targetFactionId !== null) continue;
        candidates.push({ sq, dist: hopDistance(sq.sectorKey, r.sectorKey) });
      }
      candidates.sort((a, b) => a.dist - b.dist || (a.sq.squadId < b.sq.squadId ? -1 : 1));
      let committed = 0;
      for (const c of candidates) {
        if (committed >= spec.squadCount) break;
        this.squadPool.assignTarget(c.sq, r.sectorKey, factionId);
        committed++;
        // Audit: a wave was sent at this base (control-tick cadence, off the
        // 60 Hz loop). `owner` is the targeted faction = the base owner.
        auditEvent({
          event: 'wave_dispatched',
          sector: r.sectorKey,
          owner: factionId,
          targetSector: r.sectorKey,
          squadId: c.sq.squadId,
          squadSize: c.sq.botIds.length,
        });
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
    nowMs: number,
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
            // shouldDeEscalate reads only lastDealtDamageTick; the base-ready
            // one-shot is irrelevant here (the readiness entry doesn't carry it).
            notifiedReady: false,
          },
          {
            minerCount: r.minerCount,
            nowTick: r.serverTick,
            peacefulTimeoutTicks: this.peacefulTimeoutTicks,
          },
        );
        // Phase-1 issue 4 — TIME-BOX the assault into a discrete PHASE. The audit
        // log (12 h playtest) showed waves NEVER resolved (wave_repelled=0): a
        // dispatched squad's killed members respawn at the galaxy edge and trickle
        // back, so the wave self-heals forever, the faction stays `assigned`, and
        // no second wave is ever dispatched — one squad grinding indefinitely
        // instead of phased squad assaults. After `waveMaxAttackMs` of attacking
        // the wave falls back; the faction is freed and the existing dispatch
        // cadence sends a FRESH squad next phase (de-escalation stays a fallback).
        const attackStart = this.attackStartedAtMs.get(sq.squadId);
        const timedOut =
          sq.state === 'attacking' &&
          attackStart !== undefined &&
          nowMs - attackStart >= this.waveMaxAttackMs;
        factionStillHostile = !deescalated && !timedOut;
      }
    }
    return { membersInSector, membersActive, factionStillHostile };
  }
}
