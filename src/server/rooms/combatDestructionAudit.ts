/**
 * What a confirmed combat death records and causes.
 *
 * `auditCombatDestruction` — a structure / base / drone death: the gameplay
 * audit rows, the recent-combat tally and a drone kill's rewards (elite
 * bounty, kill XP, kill bounty). Moved out of `SectorRoom` (god-file split
 * slice 27); the room calls it from `evictSwarmEntity` on the
 * `emitDestroyed` branch BEFORE the structure record is removed.
 *
 * `onShipDestroyed` — a player hull's death (the room's `SHIP_DESTROYED`
 * subscriber; god-file split slice 46): the same audit + tally + kill
 * rewards for a hull, plus the hold spill, roster wipe, ownerless eviction
 * and the active hull's scrap.
 *
 * Both run over narrow hosts the room builds once as class fields. They own
 * no state: the audit sink is `GameplayAuditLog`, the tally is the room's
 * `RecentCombatLog`, XP is `ShipProgression`, credits the wallet.
 */
import { auditEvent } from '../audit/GameplayAuditLog.js';
import { getWallet } from '../db/PersistenceWorker.js';
import { getBountyBoard, type BountyRoom } from '../economy/BountyBoard.js';
import { paysRealCredits } from './sealedSectors.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { ScrapSpawner } from '../spawn/ScrapSpawner.js';
import { recordKill } from '../stats/StatsService.js';
import type { StructureRegistry } from '../structures/StructureRegistry.js';
import type { BusEventPayloads } from '../../core/events/Bus.js';
import { shipScrapGroups } from '../../core/geometry/shipScrapGroups.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import { SWARM_KIND_DRONE, SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';
import { rollKillBounty } from '../../shared-types/lootTables.js';
import { slotBase, SLOT_ANGLE_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_X_OFF, SLOT_Y_OFF } from '../../shared-types/sabLayout.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { classifyAttacker } from './classifyAttacker.js';
import { droneMaxHealthOf } from './droneKindHelpers.js';
import type { RecentCombatLog } from './RecentCombatLog.js';
import type { ShipState } from './schema/SectorState.js';

/** What the audit reads from the room. `sectorKey` is reassigned in
 *  `onCreate`, so it is a getter. */
export interface CombatDestructionAuditHost {
  sectorKey: () => string | null;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  recentCombatLog: Pick<RecentCombatLog, 'record'>;
  now: () => number;
  payEliteBounty: (killerId: string, targetName: string, credits: number) => void;
  awardKillXp: (killerId: string, victimMaxHealth: number) => void;
  /** Tells a rock / wreck-piece ram killer from a player (`classifyAttacker`). */
  swarmRegistry: Pick<SwarmEntityRegistry, 'get'>;
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
  const attackerKind = classifyAttacker(shooterId, host.swarmRegistry);
  const pays = paysRealCredits(sector); // sandbox: kills pay no real credits
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
      if (pays && shooterId && attackerKind === 'player') host.payEliteBounty(shooterId, rec.elite.name, rec.elite.bounty);
    }
    // Phase 4 (Leveling & XP, WS-B1) — a drone is the primary XP source. Award
    // XP to the KILLER SHIP INSTANCE, weighted by the drone's toughness
    // (per-kind maxHealth — tougher drones = more XP, D10). PvP hull kills are
    // awarded separately in the SHIP_DESTROYED handler.
    const droneMaxHealth = droneMaxHealthOf(rec) ?? 40;
    if (attackerKind === 'player') host.awardKillXp(shooterId ?? '', droneMaxHealth);
    // Economy v2 W1 — every NPC kill pays a bounty straight into the killer's
    // WALLET (credits are virtual; pods carry goods only).
    if (pays && shooterId && attackerKind === 'player') {
      getWallet().credit(shooterId, rollKillBounty(rec.shipKind, Math.random), 'kill_bounty');
    }
  }
}

/** P4c-2 — the killer collects any open player bounties on the victim; a
 *  sealed (sandbox) room pays none (`paysRealCredits`). */
export function claimPvpBounty(host: Pick<ShipDestroyedHost, 'sectorKey' | 'bountyRoom'>, victim: string, killer: string): void {
  if (paysRealCredits(host.sectorKey())) getBountyBoard()?.onPlayerKilled(host.bountyRoom(), victim, killer);
}

/** What the `SHIP_DESTROYED` handler reads from the room. Every room field
 *  it touches is a getter / closure: several are assigned later in
 *  `onCreate` (`sabF32`, `scrapSpawner`) or declared after the host field,
 *  so they are read at call time. */
export interface ShipDestroyedHost extends Pick<CombatDestructionAuditHost, 'sectorKey' | 'recentCombatLog' | 'now' | 'awardKillXp' | 'swarmRegistry'> {
  roomId: () => string;
  getActiveShip: (playerId: string) => ShipState | undefined;
  ships: () => { get(shipInstanceId: string): ShipState | undefined };
  forgetSquadMember: (shipInstanceId: string) => void;
  /** The playerId its death policy noted as vaporised just before the emit. */
  vaporisedActiveDeath: () => string | null;
  clearVaporisedActiveDeath: () => void;
  playerToUser: () => ReadonlyMap<string, string | null>;
  bountyRoom: () => BountyRoom;
  playerToSlot: () => ReadonlyMap<string, number>;
  shipPoseCache: () => ReadonlyMap<string, ShipPhysicsState>;
  sabF32: () => Float32Array;
  spillOrLoseShipHold: (
    shipInstanceId: string,
    playerId: string,
    pose: { x: number; y: number; vx: number; vy: number } | undefined,
    cause: string,
    death?: { kind: string; vaporised: boolean; shooterId: string },
  ) => void;
  deleteRosterRow: (shipInstanceId: string) => void;
  ownerlessShips: () => { has(shipInstanceId: string): boolean };
  evictOwnerlessShip: (shipInstanceId: string) => void;
  scrapSpawner: () => Pick<ScrapSpawner, 'spawnFromDeath'>;
}

/**
 * A player hull died (`SHIP_DESTROYED`) — the stats kill row, the
 * `ship_destroyed` / `player_killed` audit rows, the recent-combat tally,
 * player bounties, kill XP, the hold spill + roster wipe, ownerless-hull
 * eviction and the active hull's scrap. Moved out of `SectorRoom`
 * (god-file split slice 46); the room subscribes it in `onCreate` over a
 * narrow host built once as a class field (`shipDestroyedHost`).
 */
export function onShipDestroyed(host: ShipDestroyedHost, evt: BusEventPayloads['SHIP_DESTROYED']): void {
  // Phase 6b — `evt.targetId` has mixed semantics:
  //   - active-hull case (applyDamage line ~1553): a playerId (the
  //     applyDamage path looked up the ship via getActiveShip(playerId)).
  //   - lingering-hull case (applyDamage line ~1525): a shipInstanceId
  //     (looked up directly via state.ships.get).
  // Disambiguate by trying the active-hull lookup first; if it fails,
  // treat the target as a shipInstanceId.
  const activeHull = host.getActiveShip(evt.targetId);
  const destroyedShip = activeHull ?? host.ships().get(evt.targetId);
  const victimPlayerId = activeHull ? evt.targetId : destroyedShip?.playerId;
  // RTS slice 4b: a squad member its owner was flying leaves its squad.
  if (activeHull) host.forgetSquadMember(activeHull.shipInstanceId);
  // Its death policy noted a vaporised hull just before this emit.
  const vaporised = host.vaporisedActiveDeath() === evt.targetId;
  host.clearVaporisedActiveDeath();

  const killerUser = host.playerToUser().get(evt.shooterId) ?? null;
  const victimUser = victimPlayerId !== undefined
    ? (host.playerToUser().get(victimPlayerId) ?? null)
    : null;
  recordKill(killerUser, victimUser, 'hitscan', host.sectorKey() ?? host.roomId());
  // Gameplay audit — a player hull died (covers offline lingering-hull
  // deaths too). A non-prefixed shooter id is another player ⇒ PvP kill.
  const auditAttacker = evt.shooterId || undefined;
  // Equinox Phase 9 (item 5) — recent-combat tally for the galaxy map.
  host.recentCombatLog.record('ship', host.now());
  auditEvent({
    event: 'ship_destroyed',
    sector: host.sectorKey() ?? undefined,
    playerId: victimPlayerId ?? evt.targetId,
    attackerId: auditAttacker,
    attackerKind: classifyAttacker(auditAttacker, host.swarmRegistry),
  });
  if (auditAttacker && victimPlayerId && classifyAttacker(auditAttacker, host.swarmRegistry) === 'player') {
    auditEvent({
      event: 'player_killed',
      sector: host.sectorKey() ?? undefined,
      victim: victimPlayerId,
      killer: auditAttacker,
    });
    // P4c-2 — the killer collects any open player bounties on the victim.
    claimPvpBounty(host, victimPlayerId, auditAttacker);
  }
  // Phase 4 (Leveling & XP, WS-B1) — award XP to the KILLER SHIP INSTANCE,
  // weighted by the victim's toughness. MUST run BEFORE the roster wipe
  // below (D9): the wipe drops the VICTIM's row; the killer's row is a
  // different instance, so ordering only matters in the self-kill edge
  // (a ship can't kill itself, but a stale shooterId === victim would be
  // a no-op award anyway). We still read the victim's maxHealth here while
  // its kind is known.
  if (destroyedShip !== undefined) {
    const victimMaxHealth = getShipKind(destroyedShip.kind).maxHealth;
    host.awardKillXp(evt.shooterId, victimMaxHealth);
  }
  // Phase 3 dual-write — drop the destroyed ship from the roster. D9 — the
  // whole roster row (level / xp / statAlloc / mounts) is dropped together
  // here, so a destroyed ship's progression is gone atomically.
  if (destroyedShip !== undefined) {
    // Living World P1a — hardcore: an ACTIVE hull's carried hold spills where
    // it died. (A LINGERING hull is handled by onLingeringHullDeath — it never
    // reaches here with `activeHull` set.) Read BEFORE the roster wipe.
    if (activeHull !== undefined) {
      const slot = host.playerToSlot().get(evt.targetId);
      const b = slot !== undefined ? slotBase(slot) : -1;
      const pose = host.shipPoseCache().get(evt.targetId)
        ?? (b >= 0 ? { x: host.sabF32()[b + SLOT_X_OFF]!, y: host.sabF32()[b + SLOT_Y_OFF]!, vx: host.sabF32()[b + SLOT_VX_OFF]!, vy: host.sabF32()[b + SLOT_VY_OFF]! } : undefined);
      host.spillOrLoseShipHold(destroyedShip.shipInstanceId, evt.targetId, pose, 'death',
        { kind: destroyedShip.kind, vaporised, shooterId: evt.shooterId });
    }
    host.deleteRosterRow(destroyedShip.shipInstanceId);
  }
  // Phase 8 sub-phase B (lingering ships) — if a hull was destroyed
  // while ownerless (lingering or actively-disconnected-with-timer),
  // evict immediately. Skipping the 15-min wait keeps the room cleaner
  // and lets the player fresh-spawn from the galaxy map.
  // Phase 6b cleanup — ownerlessShips is shipInstanceId-keyed. Look up
  // by the destroyed ship's id, not by playerId.
  if (destroyedShip !== undefined && host.ownerlessShips().has(destroyedShip.shipInstanceId)) {
    host.evictOwnerlessShip(destroyedShip.shipInstanceId);
  }

  // S2a: an ACTIVE hull's wreck comes from its death policy (`spawnActiveHullWreck`).

  // Scrap-on-death (Phase 2b-ii) — break a dying ACTIVE composite hull into
  // floating scrap. Only the active-hull case (we have a playerId-keyed slot
  // + pose); lingering hulls are skipped (their slot bookkeeping is already
  // torn down by the lingering death policy). Spawn BEFORE the slot is freed
  // — at SHIP_DESTROYED time the active slot is still allocated (the death
  // policy only sets `ship.alive = false`). Read the death pose from
  // shipPoseCache ?? SAB.
  if (activeHull !== undefined && shipScrapGroups(activeHull.kind).length > 0) {
    const slot = host.playerToSlot().get(evt.targetId);
    if (slot !== undefined) {
      const b = slotBase(slot);
      const pose = host.shipPoseCache().get(evt.targetId) ?? {
        x:     host.sabF32()[b + SLOT_X_OFF]!,
        y:     host.sabF32()[b + SLOT_Y_OFF]!,
        vx:    host.sabF32()[b + SLOT_VX_OFF]!,
        vy:    host.sabF32()[b + SLOT_VY_OFF]!,
        angle: host.sabF32()[b + SLOT_ANGLE_OFF]!,
      };
      host.scrapSpawner().spawnFromDeath(
        activeHull.kind as ShipKindId,
        { x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy, angle: pose.angle },
        `scrap-${activeHull.shipInstanceId}`,
      );
    }
  }
}
