/**
 * SquadPool — groups the hunter-bot pool into homogeneous squads of 8 with a
 * shared "strategic brain" (wave-system plan, Phase 3).
 *
 * The individual bots still live in `HunterBotPool` and still fly + pick
 * targets independently via the unchanged `HostileDroneBehaviour` (the "limbs").
 * The SQUAD is the strategic unit the `WaveDirector` commands: it warps as one,
 * goes hostile as one, and retreats as one. This layer owns ONLY the squad-level
 * record (membership + state machine + current/target sector + assigned
 * faction); per-bot lifecycle (active/in-transit/respawning) stays in
 * `HunterBotPool`, and squad member liveness is derived from it on demand.
 *
 * Squad-aware respawn (hostile-review C4): a bot that dies mid-wave respawns
 * back into ITS squad's sector (via `respawnSectorFor`), not the ambient
 * distribution — so "warp/fight together" survives individual deaths. A squad
 * tolerates `botIds.length < SQUAD_SIZE` (load-shed / partial arrival); the pool
 * refills members over time.
 */

import { DEFAULT_SHIP_KIND, type ShipKindId } from '../../../shared-types/shipKinds.js';
import type { DirectorSquadState } from '../DirectorPersistence.js';

/** Members per squad. Part of the "8 × Legionnaires" wave identity. */
export const SQUAD_SIZE = 8;
/** Number of squads the director keeps. 3 × 8 = 24 bots (≈ the legacy 25). */
export const LIVING_WORLD_SQUAD_COUNT = 3;

/**
 * The squad strategic-brain state:
 *   - `forming`    — seeded / refilling; members not yet all spawned.
 *   - `idle`       — members active in `sectorKey`, no wave assignment.
 *   - `warping`    — members spooling toward `sectorKey` (the target).
 *   - `attacking`  — members in `sectorKey`, hostile to `targetFactionId`.
 *   - `retreating` — de-escalating; leaving `sectorKey`.
 */
export type SquadState = 'forming' | 'idle' | 'warping' | 'attacking' | 'retreating';

export interface SquadRecord {
  squadId: string;
  /** Homogeneous ship kind for every member (the "Legionnaire" hull in v1). */
  kind: ShipKindId;
  /** Member bot ids. Length ≤ SQUAD_SIZE (shrinks on shed; refilled on respawn). */
  botIds: string[];
  state: SquadState;
  /** Current sector while idle/attacking/retreating; the TARGET while warping.
   *  Under hop-by-hop traversal this is the squad's GOAL — members traverse
   *  toward it one galaxy-graph hop at a time; the squad's true position is the
   *  multiset of member `rec.sectorKey`, derived on demand. */
  sectorKey: string;
  /** Faction this squad is tasked against, or null when unassigned. */
  targetFactionId: string | null;
  /** One-shot warp-in-warning dedupe: set the first tick a member begins the
   *  FINAL leg into the goal sector, reset on (re)assignment + retreat so each
   *  wave telegraphs exactly once. */
  warned: boolean;
}

export interface SquadSnapshot {
  total: number;
  byState: Record<SquadState, number>;
}

export class SquadPool {
  private readonly squads = new Map<string, SquadRecord>();
  /** botId → squadId reverse index (for death/respawn routing). */
  private readonly botToSquad = new Map<string, string>();

  /**
   * Partition `botIds` into `LIVING_WORLD_SQUAD_COUNT` homogeneous squads of
   * `SQUAD_SIZE`, each given a home sector by `sectorForSquad(index)` (the
   * director spreads squads across the galaxy so they don't all pile into one
   * sector) and seeded in the `forming` state. `pickKind` chooses each squad's
   * homogeneous hull (v1 passes `() => 'fighter'`, labelled "Legionnaire"); a
   * future `WavePattern` can vary it. Extra bot ids beyond capacity are ignored.
   */
  seed(
    botIds: readonly string[],
    sectorForSquad: (squadIndex: number) => string,
    pickKind: () => ShipKindId,
  ): void {
    this.squads.clear();
    this.botToSquad.clear();
    let idx = 0;
    for (let s = 0; s < LIVING_WORLD_SQUAD_COUNT; s++) {
      const squadId = `squad-${s}`;
      const members: string[] = [];
      for (let m = 0; m < SQUAD_SIZE && idx < botIds.length; m++, idx++) {
        const botId = botIds[idx]!;
        members.push(botId);
        this.botToSquad.set(botId, squadId);
      }
      this.squads.set(squadId, {
        squadId,
        kind: pickKind() ?? DEFAULT_SHIP_KIND,
        botIds: members,
        state: 'forming',
        sectorKey: sectorForSquad(s),
        targetFactionId: null,
        warned: false,
      });
    }
  }

  get(squadId: string): SquadRecord | undefined {
    return this.squads.get(squadId);
  }

  all(): IterableIterator<SquadRecord> {
    return this.squads.values();
  }

  /** The squad a bot belongs to, or undefined (unassigned bot). */
  squadOf(botId: string): SquadRecord | undefined {
    const id = this.botToSquad.get(botId);
    return id ? this.squads.get(id) : undefined;
  }

  setState(squad: SquadRecord, state: SquadState): void {
    squad.state = state;
  }

  /** Task a squad against a faction's sector (the WaveDirector's assignment). */
  assignTarget(squad: SquadRecord, sectorKey: string, factionId: string): void {
    squad.sectorKey = sectorKey;
    squad.targetFactionId = factionId;
    squad.warned = false; // a fresh wave telegraphs once on its final approach
  }

  /** Clear a squad's wave assignment (de-escalation / retreat complete). */
  clearTarget(squad: SquadRecord): void {
    squad.targetFactionId = null;
    squad.warned = false;
  }

  /**
   * Serialize each squad's abstract continuity for director-state persistence
   * (Phase 5 — "restart from any state"). `botIds` is OMITTED (re-derived by
   * `seed` on the next boot) and `warned` is a per-wave one-shot. The mapped
   * `state` (SquadState) flows into `DirectorSquadState.state` — this site fails
   * to typecheck if the two unions ever drift.
   */
  serialize(): DirectorSquadState[] {
    const out: DirectorSquadState[] = [];
    for (const sq of this.squads.values()) {
      out.push({
        squadId: sq.squadId,
        kind: sq.kind,
        sectorKey: sq.sectorKey,
        targetFactionId: sq.targetFactionId,
        state: sq.state,
      });
    }
    return out;
  }

  /**
   * Restore persisted squad continuity onto the freshly-seeded pool (Phase 5).
   * MUST run AFTER `seed()` (which creates the squad records + membership and
   * sets `kind`); this overwrites each KNOWN squad's `sectorKey` / `targetFactionId`
   * / `state` so the existing respawn path re-homes its bots at the restored
   * sector. `kind` is NOT restored — the pool re-seeds it and the director forces
   * each member's `rec.kind` to the squad's seeded kind, so restoring kind here
   * would desync the record from its bots (v1 is homogeneous anyway). Unknown
   * squad ids are skipped (defensive against a squad-count change without a
   * DIRECTOR_STATE_VERSION bump).
   */
  restoreStates(states: readonly DirectorSquadState[]): void {
    for (const s of states) {
      const sq = this.squads.get(s.squadId);
      if (!sq) continue;
      sq.sectorKey = s.sectorKey;
      sq.targetFactionId = s.targetFactionId;
      sq.state = s.state;
    }
  }

  /**
   * Sector a (re)spawning member should go to so it joins/rejoins its squad
   * (hostile-review C4). A squad always has a home sector (set at seed and
   * updated on assignment), so a squad member always returns to its squad —
   * the initial spawn gathers the squad at its home, and a combat respawn
   * rejoins it wherever the squad currently is. `null` only for an unassigned
   * bot (not in any squad) ⇒ the director uses the ambient random picker.
   */
  respawnSectorFor(botId: string): string | null {
    return this.squadOf(botId)?.sectorKey ?? null;
  }

  /** Count of a squad's members that satisfy `isActive` (derived from the
   *  HunterBotPool — kept off this module so the squad layer stays pool-blind). */
  activeMemberCount(squad: SquadRecord, isActive: (botId: string) => boolean): number {
    let n = 0;
    for (const id of squad.botIds) if (isActive(id)) n++;
    return n;
  }

  /** Read-only counts for telemetry / tests. */
  snapshot(): SquadSnapshot {
    const byState: Record<SquadState, number> = {
      forming: 0,
      idle: 0,
      warping: 0,
      attacking: 0,
      retreating: 0,
    };
    for (const sq of this.squads.values()) byState[sq.state]++;
    return { total: this.squads.size, byState };
  }
}
