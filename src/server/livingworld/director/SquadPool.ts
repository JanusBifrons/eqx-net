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
  /** Current sector while idle/attacking/retreating; the TARGET while warping. */
  sectorKey: string;
  /** Faction this squad is tasked against, or null when unassigned. */
  targetFactionId: string | null;
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
   * `SQUAD_SIZE`, each seeded into `initialSectorKey` in the `forming` state.
   * `pickKind` chooses each squad's homogeneous hull (v1 passes `() => 'fighter'`,
   * labelled "Legionnaire"); a future `WavePattern` can vary it. Extra bot ids
   * beyond the squads' capacity are ignored (the director sizes the pool to
   * match).
   */
  seed(botIds: readonly string[], initialSectorKey: string, pickKind: () => ShipKindId): void {
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
        sectorKey: initialSectorKey,
        targetFactionId: null,
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
  }

  /** Clear a squad's wave assignment (de-escalation / retreat complete). */
  clearTarget(squad: SquadRecord): void {
    squad.targetFactionId = null;
  }

  /**
   * Sector a respawning member should return to so it rejoins its squad
   * (hostile-review C4). Returns the squad's `sectorKey` for any squad that has
   * a meaningful location (every state except `forming`); `null` ⇒ the director
   * falls back to the ambient respawn picker (unassigned bot, or a squad still
   * forming with no committed sector).
   */
  respawnSectorFor(botId: string): string | null {
    const squad = this.squadOf(botId);
    if (!squad || squad.state === 'forming') return null;
    return squad.sectorKey;
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
