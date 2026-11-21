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

import { isNpcOwner, isUnownedOwner } from '../../shared-types/relations.js';
import { createFactionState, isBaseReady, type FactionState } from '../../core/faction/Faction.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';
import type { FactionBaseReadiness } from '../livingworld/LivingWorldRoom.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';

export interface FactionLedgerDeps {
  /** Live structures in this room (typically `registry.all()`). Iterated on
   *  demand for membership + reverse lookup; never retained. */
  structures: () => Iterable<StructureRecord>;
}

/** What `baseReadiness` reads from the room (getters for fields it reassigns). */
export interface BaseReadinessHost {
  sectorKey(): string | null;
  serverTick(): number;
  /** A wave starts only against a present owner (room option `waveNeedsOwner`). */
  waveNeedsOwner(): boolean;
  /** The owner has an ACTIVE hull in this sector. */
  ownerPresent(factionId: string): boolean;
  /** Broadcast the one-shot `base_ready` toast. */
  broadcastBaseReady(factionId: string, sectorKey: string): void;
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
      // B2 — an NPC base is not a player faction (no waves, no escalation), nor
      // is an ownerless one (capture 4E: it has no faction at all).
      if (s.id === entityId) return isNpcOwner(s.owner) || isUnownedOwner(s.owner) ? null : s.owner; // entityId IS a structure
      if (s.owner === entityId) ownsStructure = true; // entityId is a base-owning player
    }
    return ownsStructure && !isUnownedOwner(entityId) ? entityId : null;
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

  /** WS-11 (R2.24 Part B) — one-shot base-ready latch. Returns true EXACTLY ONCE
   *  for the first call after the base becomes ready (then stays false until
   *  `clearReadyNotified` re-arms it), so the caller broadcasts the "your base is
   *  operational" toast once per ready transition. */
  markReadyNotified(id: string): boolean {
    const s = this.ensure(id);
    if (s.notifiedReady) return false;
    s.notifiedReady = true;
    return true;
  }

  /** Re-arm the base-ready one-shot (the base dropped below ready — a razed base
   *  re-toasts when rebuilt). Safe for an unobserved id. */
  clearReadyNotified(id: string): void {
    const s = this.byId.get(id);
    if (s) s.notifiedReady = false;
  }

  /** Drop a faction's state (base fully destroyed / owner gone). Keeps the map
   *  bounded; safe to call for an unknown id. */
  forget(id: string): void {
    this.byId.delete(id);
  }

  /**
   * Wave-system Phase 4 — per-(owner, sector) faction base summary the
   * WaveDirector polls through `SectorRoom.factionBaseReadiness` (~1.5 s, NOT
   * the hot loop, so allocation here is fine). Engineering rooms
   * (`sectorKey === null`) return [] (waves are galaxy-only). One entry per
   * player owning ≥1 constructed structure here.
   */
  baseReadiness(h: BaseReadinessHost): FactionBaseReadiness[] {
    const sectorKey = h.sectorKey();
    if (sectorKey === null) return [];
    interface Agg {
      hasCapital: boolean;
      minerCount: number;
      solarCount: number;
      turretCount: number;
    }
    const byOwner = new Map<string, Agg>();
    for (const rec of this.deps.structures()) {
      // B2 — NPC bases are never a wave target (they aren't a player faction);
      // capture 4E — nor is an ownerless base (it belongs to nobody).
      if (!rec.isConstructed || isNpcOwner(rec.owner) || isUnownedOwner(rec.owner)) continue;
      let agg = byOwner.get(rec.owner);
      if (!agg) {
        agg = { hasCapital: false, minerCount: 0, solarCount: 0, turretCount: 0 };
        byOwner.set(rec.owner, agg);
      }
      switch (rec.kind) {
        case 'capital':
          agg.hasCapital = true;
          break;
        case 'miner':
          agg.minerCount++;
          break;
        case 'solar':
          agg.solarCount++;
          break;
        case 'turret':
          agg.turretCount++;
          break;
        default:
          break;
      }
    }
    const out: FactionBaseReadiness[] = [];
    for (const [factionId, agg] of byOwner) {
      const ownerPresent = h.ownerPresent(factionId);
      const ready = isBaseReady(agg) && (!h.waveNeedsOwner() || ownerPresent);
      // WS-11 (R2.24 Part B) — one-shot "your base is operational" toast the
      // first time a base qualifies for waves; re-arm when it drops below ready
      // (a razed-then-rebuilt base re-toasts). Evaluated at the director's
      // control cadence (this method is the canonical readiness poll), so it
      // fires within ~one control tick of the base completing.
      if (ready) {
        if (this.markReadyNotified(factionId)) {
          h.broadcastBaseReady(factionId, sectorKey);
          auditEvent({
            event: 'base_ready',
            sector: sectorKey,
            owner: factionId,
            composition: {
              miner: agg.minerCount,
              solar: agg.solarCount,
              turret: agg.turretCount,
            },
          });
        }
      } else {
        this.clearReadyNotified(factionId);
      }
      const state = this.get(factionId);
      out.push({
        factionId,
        sectorKey,
        ready,
        // The owner is "present" when they have an active hull in this sector.
        ownerPresent,
        minerCount: agg.minerCount,
        hostileToDrones: state?.hostileToDrones ?? false,
        underWave: state?.underWave ?? false,
        lastDealtDamageTick: state?.lastDealtDamageTick ?? -Infinity,
        serverTick: h.serverTick(),
      });
    }
    return out;
  }
}
