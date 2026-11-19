/**
 * Audit a confirmed combat death (structure / base / drone) — the gameplay
 * audit rows, the recent-combat tally and a drone kill's rewards (elite
 * bounty, kill XP, kill bounty). Moved out of `SectorRoom` (god-file split
 * slice 27); the room calls it from `evictSwarmEntity` on the
 * `emitDestroyed` branch BEFORE the structure record is removed, over a
 * narrow host built once as a class field.
 *
 * It owns no state: the audit sink is `GameplayAuditLog`, the tally is the
 * room's `RecentCombatLog`, XP is `ShipProgression`, credits the wallet.
 */
import { auditEvent } from '../audit/GameplayAuditLog.js';
import { getWallet } from '../db/PersistenceWorker.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import type { StructureRegistry } from '../structures/StructureRegistry.js';
import { SWARM_KIND_DRONE, SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';
import { rollKillBounty } from '../../shared-types/lootTables.js';
import { classifyAttacker } from './classifyAttacker.js';
import { droneMaxHealthOf } from './droneKindHelpers.js';
import type { RecentCombatLog } from './RecentCombatLog.js';

/** What the audit reads from the room. `sectorKey` is reassigned in
 *  `onCreate`, so it is a getter. */
export interface CombatDestructionAuditHost {
  sectorKey: () => string | null;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  recentCombatLog: Pick<RecentCombatLog, 'record'>;
  now: () => number;
  payEliteBounty: (killerId: string, targetName: string, credits: number) => void;
  awardKillXp: (killerId: string, victimMaxHealth: number) => void;
}

/**
 * Audit a confirmed combat death (structure / base / drone) with the
 * owner / kind / sector / attacker context that answers "what happened to
 * my base?". Called from `evictSwarmEntity` on the `emitDestroyed` branch
 * BEFORE the structure record is removed. Asteroids (kind 0) + scrap
 * (kind 3) are not audited. Off the per-tick path (a discrete death).
 */
export function auditCombatDestruction(host: CombatDestructionAuditHost, rec: SwarmEntityRecord, shooterId?: string): void {
  const sector = host.sectorKey() ?? undefined;
  const attackerKind = classifyAttacker(shooterId);
  if (rec.kind === SWARM_KIND_STRUCTURE) {
    const s = host.structureRegistry.get(rec.id);
    if (!s) return;
    // Equinox Phase 9 (item 5) — recent-combat tally for the galaxy map.
    host.recentCombatLog.record('structure', host.now());
    auditEvent({
      event: 'structure_destroyed',
      sector,
      owner: s.owner,
      kind: s.kind,
      attackerId: shooterId,
      attackerKind,
      x: s.x,
      y: s.y,
    });
    // A Capital IS the base — surface the headline event alongside.
    if (s.kind === 'capital') {
      auditEvent({ event: 'base_destroyed', sector, owner: s.owner, attackerId: shooterId });
    }
  } else if (rec.kind === SWARM_KIND_DRONE) {
    // Equinox Phase 9 (item 5) — a drone is an NPC SHIP for the combat tally.
    host.recentCombatLog.record('ship', host.now());
    auditEvent({ event: 'drone_destroyed', sector, attackerId: shooterId });
    // Living World P4a — a named elite falls (the galaxy-wide notice is the
    // EliteDirector's, off ENTITY_DESTROYED).
    if (rec.elite !== undefined) {
      auditEvent({ event: 'elite_killed', sector, name: rec.elite.name, kind: rec.shipKind ?? '', attackerId: shooterId });
      // P4c — the elite's bounty goes into the KILLER's hold (signed-in pilots).
      if (shooterId) host.payEliteBounty(shooterId, rec.elite.name, rec.elite.bounty);
    }
    // Phase 4 (Leveling & XP, WS-B1) — a drone is the primary XP source. Award
    // XP to the KILLER SHIP INSTANCE, weighted by the drone's toughness
    // (per-kind maxHealth — tougher drones = more XP, D10). PvP hull kills are
    // awarded separately in the SHIP_DESTROYED handler.
    const droneMaxHealth = droneMaxHealthOf(rec) ?? 40;
    host.awardKillXp(shooterId ?? '', droneMaxHealth);
    // Economy v2 W1 — every NPC kill pays a bounty straight into the killer's
    // WALLET (credits are virtual; pods carry goods only).
    if (shooterId && classifyAttacker(shooterId) === 'player') {
      getWallet().credit(shooterId, rollKillBounty(rec.shipKind, Math.random), 'kill_bounty');
    }
  }
}
