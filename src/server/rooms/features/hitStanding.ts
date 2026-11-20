/**
 * The room's hit-side standing and economy notes (Living World P2 + F3): a
 * hit on a hauler or robot reaches the TradeDirector (`noteEconomicHit`),
 * and a hit lowers the victim faction's view of the attacker's faction once
 * per pair per window (`noteStandingHit`). Moved verbatim out of
 * `SectorRoom` (god-file split slice 55); the room hands in live accessors.
 *
 * `applyDamage` stays the one choke point that calls both (factions.md); the
 * tractor's `onShipTractored` also calls `noteStandingHit`.
 */
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { StructureRegistry } from '../../structures/StructureRegistry.js';
import type { GameClock } from '../../../core/clock/GameClock.js';
import { isHaulerId } from '../../livingworld/directorBotIds.js';
import { getTradeSink } from '../../economy/tradeSink.js';
import { convoyHaulerFactions } from '../../economy/convoyCarriers.js';
import { allegianceOfKind } from '../../../shared-types/shipKinds.js';
import { parseOwner } from '../../../shared-types/relations.js';
import { STANDING_HIT_DELTA, STANDING_HIT_WINDOW_MS, isNpcFactionId } from '../../../shared-types/factions.js';
import { classifyAttacker } from '../classifyAttacker.js';

/** F3 — move `from`'s view of `to`, through the economy store. */
export function adjustStanding(from: string, to: string, delta: number): void {
  if (from === to || from === '' || to === '') return;
  getTradeSink()?.adjustStanding?.(from, to, delta);
}

/** What the hit notes read from the room. `structureRegistry` is a getter
 *  (declared after this field); `playerToSlot` is a getter (not readonly). */
export interface RoomHitStandingHost {
  swarmRegistry: Pick<SwarmEntityRegistry, 'get'>;
  gameClock: Pick<GameClock, 'now'>;
  playerToSlot: () => ReadonlyMap<string, number>;
  structureRegistry: () => Pick<StructureRegistry, 'get'>;
}

export class RoomHitStanding {
  /** victim faction → attacker faction → last standing hit (ms). */
  private readonly standingHitAtMs = new Map<string, Map<string, number>>();

  constructor(private readonly h: RoomHitStandingHost) {}

  /** The faction behind an attacker id: a player, a structure's owner, or an
   *  NPC ship's allegiance. Null for anything else. Allocation-free. */
  attackerFaction(id: string): string | null {
    if (this.h.playerToSlot().has(id)) return id;
    const s = this.h.structureRegistry().get(id);
    if (s !== undefined) return parseOwner(s.owner).faction;
    const rec = this.h.swarmRegistry.get(id);
    return rec != null && rec.kind === 1 ? allegianceOfKind(rec.shipKind) : null;
  }

  /**
   * F3 — a hit lowers the victim faction's view of the attacker's faction
   * (one `STANDING_HIT_DELTA` per pair per window). Victims are structures
   * (their owner) and player ships; at least one side must be a player (NPC
   * politics come later). Steady state is Map lookups only (#14).
   */
  noteStandingHit(targetId: string, shooterId: string): void {
    const sink = getTradeSink();
    if (sink?.adjustStanding === undefined) return;
    // v4 C — a convoy hauler flies for its owner AND its carrier: both mind.
    if (isHaulerId(targetId)) {
      const f = convoyHaulerFactions(targetId);
      if (f !== undefined) {
        this.standingHit(f.owner, shooterId);
        if (f.carrier !== f.owner) this.standingHit(f.carrier, shooterId);
      }
      return;
    }
    const s = this.h.structureRegistry().get(targetId);
    const victim = s !== undefined ? parseOwner(s.owner).faction : this.h.playerToSlot().has(targetId) ? targetId : null;
    if (victim === null) return;
    this.standingHit(victim, shooterId);
  }

  /** Lower `victim`'s view of the shooter's faction, at most once per pair per
   *  window (never between two NPC factions). */
  private standingHit(victim: string, shooterId: string): void {
    const sink = getTradeSink();
    if (sink?.adjustStanding === undefined) return;
    const attacker = this.attackerFaction(shooterId);
    if (attacker === null || attacker === victim) return;
    if (isNpcFactionId(victim) && isNpcFactionId(attacker)) return;
    const now = this.h.gameClock.now();
    let row = this.standingHitAtMs.get(victim);
    if (row === undefined) { row = new Map(); this.standingHitAtMs.set(victim, row); }
    if (now - (row.get(attacker) ?? -Infinity) < STANDING_HIT_WINDOW_MS) return;
    row.set(attacker, now);
    sink.adjustStanding(victim, attacker, STANDING_HIT_DELTA);
  }

  /**
   * Living World P2 — economy side of a hit: a player (or their turret) hitting
   * a trade HAULER is piracy (the TradeDirector records the attacker for the
   * run); hitting a ROBOT costs robot standing (ends a truce). Steady state is
   * prefix checks + Map lookups, no allocation (#14).
   */
  noteEconomicHit(targetId: string, shooterId: string): void {
    const sink = getTradeSink();
    if (sink === null) return;
    const hauler = isHaulerId(targetId);
    if (!hauler) {
      const rec = this.h.swarmRegistry.get(targetId);
      if (rec == null || rec.kind !== 1 || allegianceOfKind(rec.shipKind) !== 'robots') return;
    }
    const kind = classifyAttacker(shooterId);
    const attacker = kind === 'player'
      ? shooterId
      : kind === 'structure' ? (this.h.structureRegistry().get(shooterId)?.owner ?? null) : null;
    // A hauler reports EVERY hit (an NPC raider drives the escort prompt too);
    // a robot only cares about player attackers.
    if (hauler) sink.onHaulerDamaged(targetId, attacker);
    else if (attacker !== null) sink.onRobotDamaged(attacker);
  }
}
