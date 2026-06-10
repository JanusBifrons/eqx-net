/**
 * FactionLedger — per-`SectorRoom` faction hostility/peace bookkeeping
 * (wave-system plan, Phase 1).
 *
 * A faction is "a player + the structures they own in THIS sector". Because
 * `StructureRegistry` is per-room (a base lives in one sector), the ledger is
 * per-room too and sits beside it — the cross-sector `WaveDirector` polls each
 * room's ledger through a `LivingWorldRoom` hook (Phase 4). The faction id is
 * the owning player's id.
 *
 * Membership is DERIVED on demand from an injected structure-source callback
 * (never a value copy — same stateless-binding philosophy as the GEP
 * `HealthBinding`), so the ledger never holds a stale member list and never
 * imports the concrete `StructureRegistry` (DIP — tests pass a fake iterable).
 *
 * The pure decisions (de-escalate / base-ready) live in
 * `src/core/faction/Faction.ts`; this server service owns only the mutable
 * `FactionState` map + the registry-derived membership/reverse-lookup.
 */

import { createFactionState, type FactionState } from '../../core/faction/Faction.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';

export interface FactionLedgerDeps {
  /** Live structures in this room (typically `registry.all()`). Iterated on
   *  demand for membership + reverse lookup; never retained. */
  structures: () => Iterable<StructureRecord>;
}

export class FactionLedger {
  /** factionId (owner playerId) → state. Bounded by the players-with-state in
   *  this one sector; pruned via `forget`. */
  private readonly byId = new Map<string, FactionState>();

  constructor(private readonly deps: FactionLedgerDeps) {}

  /** Get-or-create the mutable state for a faction. */
  private ensure(id: string): FactionState {
    let s = this.byId.get(id);
    if (!s) {
      s = createFactionState(id);
      this.byId.set(id, s);
    }
    return s;
  }

  /** Read-only state for a faction, or undefined if none has been observed. */
  get(id: string): FactionState | undefined {
    return this.byId.get(id);
  }

  /** All tracked faction states (read-only iteration). */
  all(): IterableIterator<FactionState> {
    return this.byId.values();
  }

  /** Members of a faction, derived live from the structure source. The player
   *  id is always the faction id; structureIds are this sector's structures
   *  owned by that player. */
  membersOf(id: string): { playerId: string; structureIds: string[] } {
    const structureIds: string[] = [];
    for (const s of this.deps.structures()) {
      if (s.owner === id) structureIds.push(s.id);
    }
    return { playerId: id, structureIds };
  }

  /**
   * Reverse lookup — which faction (if any) does an entity belong to?
   *   - a structure id            → its owner's faction;
   *   - a player id that owns ≥1 structure here → that player's faction;
   *   - a drone id (`swarm-N`) / unknown id     → null.
   * Single pass over the structure source.
   */
  factionOf(entityId: string): string | null {
    let ownsStructure = false;
    for (const s of this.deps.structures()) {
      if (s.id === entityId) return s.owner; // entityId IS a structure
      if (s.owner === entityId) ownsStructure = true; // entityId is a base-owning player
    }
    return ownsStructure ? entityId : null;
  }

  /** Flip a faction hostile to drones (wave declared, or a member attacked a
   *  drone). Idempotent. */
  markFactionHostileToDrones(id: string): void {
    this.ensure(id).hostileToDrones = true;
  }

  /** Record that a faction member just dealt damage to a drone — the
   *  de-escalation peaceful-timeout anchor (req #8). Dealing damage to a drone
   *  is itself an act of war, so this also flips `hostileToDrones`. */
  recordFactionDealtDamage(id: string, tick: number): void {
    const s = this.ensure(id);
    s.lastDealtDamageTick = tick;
    s.hostileToDrones = true;
  }

  /** Set/clear the active-wave flag (gates Phase-2 drone structure targeting).
   *  Declaring a wave also marks the faction hostile to drones. */
  setUnderWave(id: string, underWave: boolean): void {
    const s = this.ensure(id);
    s.underWave = underWave;
    if (underWave) s.hostileToDrones = true;
  }

  /** Is this faction currently hostile to drones (member attacked OR under wave)? */
  isHostileToDrones(id: string): boolean {
    return this.byId.get(id)?.hostileToDrones ?? false;
  }

  /** Drop a faction's state (base fully destroyed / owner gone). Keeps the map
   *  bounded; safe to call for an unknown id. */
  forget(id: string): void {
    this.byId.delete(id);
  }
}
