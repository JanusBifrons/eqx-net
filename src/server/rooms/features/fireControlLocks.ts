/**
 * Fire control (exp/fire-control) — the room-side lock helpers: the three
 * lock machines' deps (player, wingman, NPC), lock-key → target resolution,
 * the hostile act a finished failsafe commits, lock-held hostility refresh,
 * and the mount-bears / turret-aim reads on a group's lock. Moved verbatim
 * out of `SectorRoom`; the lock machines themselves stay `LockSubsystem` /
 * `NpcLockSubsystem`. The room hands in live accessors (`() => value` for
 * fields it reassigns). Per-tick path (#14): every scratch pose, target view
 * and fire shape is allocated once, here.
 */
import type { MapSchema } from '@colyseus/schema';
import type { AiController } from '../../../core/ai/AiController.js';
import type { GameClock } from '../../../core/clock/GameClock.js';
import { fillFireTargetShape, fillRangeShape, mountFiresOn, newFireTargetShape, type FireTargetShape } from '../../../core/combat/fireControlBearing.js';
import { isTerrainLockKind, swarmLockEligible } from '../../../core/combat/lockState.js';
import { mayBeInReach, mountsReachTarget, weaponIdReach, type MountRangeTarget } from '../../../core/combat/mountReach.js';
import { mountPriority, targetClassOfKind, STRUCTURE_TARGET_CLASS } from '../../../core/combat/mountTargeting.js';
import type { WeaponId } from '../../../core/combat/WeaponCatalogue.js';
import type { AiEntityPoseOut } from '../../../core/contracts/IAiBehaviour.js';
import { isLingeringHull } from '../../../core/entity/shipLiveness.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { HostileActLedger } from '../../../core/relations/HostileActLedger.js';
import { relationOf, type RelationContext } from '../../../shared-types/relations.js';
import { getShipKind, type ShipKind, type WeaponMount } from '../../../shared-types/shipKinds.js';
import type { CapitalWreckSubsystem } from '../CapitalWreckSubsystem.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import type { FleetCommandSubsystem } from '../../fleet/FleetCommandSubsystem.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { StructureRegistry } from '../../structures/StructureRegistry.js';
import { LockSubsystem, newLockTargetView, type LockTargetView } from '../LockSubsystem.js';
import { LockSalvageLookup, swarmLockId, type LockLineageSource } from '../lockSalvage.js';
import { NpcLockSubsystem } from '../NpcLockSubsystem.js';
import { tractorLineClear, type TractorLineHost } from '../tractorLineOfSight.js';
import type { ShipKindId } from '../../../shared-types/shipKinds.js';
import type { ShipState } from '../schema/SectorState.js';

/** Empty mount list for a kind with none (fire-range test; #14). */
const NO_FIRE_MOUNTS: ReadonlyArray<WeaponMount> = [];

/** What the lock helpers need from the room; getters read the live field. */
export interface FireControlLocksHost {
  state(): { ships: MapSchema<ShipState> };
  locks(): LockSubsystem;
  wingmanLocks(): LockSubsystem;
  fleet: Pick<FleetCommandSubsystem, 'size' | 'isAttached' | 'ownerOfAttached'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'all' | 'get' | 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  relationCtx: RelationContext;
  hostileActs: Pick<HostileActLedger, 'record'>;
  gameClock: Pick<GameClock, 'now'>;
  lingeringSlots: ReadonlyMap<string, number>;
  lingeringPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  shipPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  capitalWrecks(): CapitalWreckSubsystem | null;
  serverTick(): number;
  aiController(): Pick<AiController, 'markHostile'>;
  testLockTimeCapS(): number | undefined;
  broadcast(type: string, message: unknown): void;
  getActiveShip(playerId: string): ShipState | undefined;
  engageablePilotHull(playerId: string): { ship: ShipState; pose: ShipPhysicsState } | null;
  npcHostileTo(entityId: string, playerId: string): boolean;
  refreshNpcAttackHostility(npcId: string, pid: string): void;
  swarmEntityPoseInto(id: string, out: AiEntityPoseOut): boolean;
  resolveInstanceMounts(ship: ShipState): ReadonlyArray<WeaponMount>;
  hasHold(shipInstanceId: string): boolean;
  shipCargoCapacity(kind: string, shipInstanceId: string): number;
  holdWeight(uid: string): number;
  /** Tractor line of sight for the lock hand-over (tractorLineOfSight.ts). */
  tractorLos: TractorLineHost;
  /** Fire control's blocked-line hold (`BlockedLineHold`) on the room's line-of-fire grid, in game time. */
  lineHeld(key: string, idx: number, weaponId: WeaponId, fx: number, fy: number, tx: number, ty: number, skipId: string, targetId: string): boolean;
}

export class FireControlLocks {
  constructor(private readonly h: FireControlLocksHost) {}

  private readonly _lockPose: AiEntityPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  private readonly _lockTarget: LockTargetView = newLockTargetView();
  private _lockTargetId = ''; // the body id `resolveLockTarget` last resolved (the blocked-line hold's target)
  /** Activated-mount geometry per player, cached by the ship's `mounts` ref. */
  readonly _lockActivated = new Map<string, { ref: unknown; mounts: ReadonlyArray<WeaponMount> }>();
  private readonly _lockSalvage = new LockSalvageLookup<ShipState>({ swarm: (n) => this.h.swarmRegistry.getByEntityId(n),
    piece: (id, out) => this.h.capitalWrecks()?.pieceStore(id, out) === true, // salvage lock bits (lockSalvage.ts)
    wrecks: () => this.h.capitalWrecks(), entity: (id) => this.h.swarmRegistry.get(id)?.entityId ?? -1, // lock lineage (lockSplit.ts)
    // No hold (no roster row, e.g. a showcase room with no sectorKey): it takes nothing in, so nothing is consumable.
    freeHold: (s) => (this.h.hasHold(s.shipInstanceId) ? this.h.shipCargoCapacity(s.kind, s.shipInstanceId) - this.h.holdWeight(s.shipInstanceId) : 0) });
  /** The wreck lineages the locks re-key across (a salvage order's retarget). */
  get lockLineage(): LockLineageSource { return this._lockSalvage; }
  /** Hull `sid` has a hold and it is full (a salvage order's finish). */
  holdFull(sid: string): boolean {
    const s = this.h.state().ships.get(sid);
    return s !== undefined && this.h.hasHold(sid) && this.h.shipCargoCapacity(s.kind, sid) - this.h.holdWeight(sid) <= 0;
  }

  buildNpcLockSubsystem(): NpcLockSubsystem {
    return new NpcLockSubsystem({
      pilots: () => this.h.locks().enabledPlayers(),
      // Liveness (#17): `engageablePilotHull`, ACTIVE + the spectate-parked
      // LINGERING hull, so a pilot who toggles Spectate keeps every NPC lock
      // on them (owner decision 2026-11-12). Hostility decay is unchanged.
      pilotPose: (pid, out) => {
        const h = this.h.engageablePilotHull(pid);
        if (!h) return null;
        const p = h.pose;
        out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy; out.angle = p.angle; out.shieldUp = h.ship.shield > 0;
        return getShipKind(h.ship.kind);
      },
      forEachHostileNpc: (pid, visit) => {
        for (const rec of this.h.swarmRegistry.all()) {
          if (rec.kind !== 1 || !this.h.npcHostileTo(rec.id, pid)) continue;
          visit(rec.id, rec.entityId);
        }
      },
      npcPose: (id, out) => {
        const rec = this.h.swarmRegistry.get(id);
        if (!rec || !this.h.swarmEntityPoseInto(id, this._lockPose)) return null;
        out.x = this._lockPose.x; out.y = this._lockPose.y; out.vx = this._lockPose.vx; out.vy = this._lockPose.vy;
        out.angle = this._lockPose.angle;
        return getShipKind(rec.shipKind ?? null);
      },
      instantLock: (pid) => this.h.locks().isInstant(pid),
      lockTimeCapS: () => this.h.testLockTimeCapS(),
      refreshHostility: (npcId, pid) => this.h.refreshNpcAttackHostility(npcId, pid),
    });
  }

  /** RTS slice 5: the lock machine an id fires through (a wingman hull's
   *  shipInstanceId → `wingmanLocks`, a pilot's playerId → `locks`). */
  locksFor(id: string): LockSubsystem {
    return this.h.fleet.size > 0 && this.h.fleet.isAttached(id) ? this.h.wingmanLocks() : this.h.locks();
  }

  /** RTS slice 5: whose hostility a lock reads — a wingman hull's OWNER, else the pilot. */
  lockOwner(id: string): string {
    if (this.h.fleet.size === 0) return id;
    return this.h.fleet.ownerOfAttached(id) ?? id;
  }

  /** A lock machine's `shipOf`: kind + activated mounts, cached per id by the ship's `mounts` ref. */
  private lockShipOf(id: string, ship: ShipState | undefined): { kind: ShipKind; activated: ReadonlyArray<WeaponMount> } | null {
    if (!ship) return null;
    const kind = getShipKind(ship.kind);
    let c = this._lockActivated.get(id);
    if (!c || c.ref !== ship.mounts) {
      c = { ref: ship.mounts, mounts: this.h.resolveInstanceMounts(ship).slice((kind.mounts ?? []).length) };
      this._lockActivated.set(id, c);
    }
    return { kind, activated: c.mounts };
  }

  /** A wingman lock machine's hull: the LINGERING (AI-flown) ship `sid`. */
  private wingmanHull(sid: string): ShipState | undefined {
    return this.h.lingeringSlots.has(sid) ? this.h.state().ships.get(sid) : undefined;
  }

  /**
   * RTS slice 5 — the PLAYER lock machine for AI-flown hulls (same class, same
   * lock maths: owner rule "same locks as a pilot in that ship"). Keyed by the
   * hull's shipInstanceId; targets resolve and hostility reads/commits go
   * through the hull's OWNER, so a wingman's lock on a neutral runs the
   * failsafe and then commits as the owner's hostile act. Groups start in MAN:
   * the wingman's stance picks the target (`tickWingmanTargets`), never AUTO.
   */
  buildWingmanLockSubsystem(): LockSubsystem {
    return new LockSubsystem({
      resolveTarget: (sid, key, out) => {
        const owner = this.h.fleet.ownerOfAttached(sid);
        return owner !== null && this.resolveLockTarget(owner, key, out);
      },
      shooterPose: (sid, out) => {
        const p = this.h.lingeringPoseCache.get(sid);
        const ship = this.h.state().ships.get(sid);
        if (!p || !ship || !ship.alive || !this.h.lingeringSlots.has(sid)) return false;
        out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy; out.angle = p.angle;
        return true;
      },
      shipOf: (sid) => this.lockShipOf(sid, this.wingmanHull(sid)),
      autoPick: () => null,
      salvageOf: (sid, key, out) => this._lockSalvage.fill(this.wingmanHull(sid), key, out), lineage: this._lockSalvage,
      tractorLineClear: (sid, key, beam) => tractorLineClear(this.h.tractorLos, sid, this.wingmanHull(sid)?.kind as ShipKindId | undefined, this.h.lingeringPoseCache.get(sid), key, beam),
      commitHostileAct: (sid, key) => {
        const owner = this.h.fleet.ownerOfAttached(sid);
        if (owner !== null) this.commitLockHostileAct(owner, key);
      },
      refreshHostility: (sid, key) => {
        const owner = this.h.fleet.ownerOfAttached(sid);
        if (owner !== null) this.refreshLockHostility(owner, key);
      },
    });
  }

  buildLockSubsystem(): LockSubsystem {
    return new LockSubsystem({
      resolveTarget: (pid, key, out) => this.resolveLockTarget(pid, key, out),
      salvageOf: (pid, key, out) => this._lockSalvage.fill(this.h.getActiveShip(pid), key, out), lineage: this._lockSalvage,
      tractorLineClear: (pid, key, beam) => tractorLineClear(this.h.tractorLos, pid, this.h.getActiveShip(pid)?.kind as ShipKindId | undefined, this.h.shipPoseCache.get(pid), key, beam),
      shooterPose: (pid, out) => {
        const p = this.h.shipPoseCache.get(pid);
        const ship = this.h.getActiveShip(pid);
        if (!p || !ship || !ship.alive) return false;
        out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy; out.angle = p.angle;
        return true;
      },
      shipOf: (pid) => this.lockShipOf(pid, this.h.getActiveShip(pid)),
      autoPick: (pid, reach, sx, sy, bears, anyTarget, size) => {
        // NPC ship already hostile to this pilot, within reach and arc: the
        // class the group's heaviest gun prefers first (`mountPriority`:
        // heavy guns capitals and structures, AA small craft; owner
        // 2026-11-14), then the nearest. testMode `anyTarget`: any NPC ship
        // or a structure that isn't the pilot's own.
        let best = -1;
        let bestPri = Infinity;
        let bestD = Infinity;
        for (const rec of this.h.swarmRegistry.all()) {
          if (rec.kind === 1) {
            if (!anyTarget && !this.h.npcHostileTo(rec.id, pid)) continue;
          } else if (rec.kind === 2 && anyTarget) {
            if (this.h.structureRegistry.get(rec.id)?.owner === pid) continue;
          } else continue;
          // Class first (cached per kind): reject before any pose or shape work.
          const pri = mountPriority(size, rec.kind === 1 ? targetClassOfKind(rec.shipKind) : STRUCTURE_TARGET_CLASS);
          if (pri > bestPri) continue;
          if (!this.h.swarmEntityPoseInto(rec.id, this._lockPose)) continue;
          const dx = this._lockPose.x - sx;
          const dy = this._lockPose.y - sy;
          const d = dx * dx + dy * dy;
          if (pri === bestPri && d >= bestD) continue;
          this.fillSwarmFireShape(rec, this._lockPose, this._autoPickShape);
          // Reach is to the hull (`bears` → `mountInReach`); this only widens
          // the centre bound by the target's own size.
          if (!mayBeInReach(dx, dy, reach, this._autoPickShape)) continue;
          if (bears(this._autoPickShape)) { bestPri = pri; bestD = d; best = rec.entityId; }
        }
        return best < 0 ? null : `s:${best}`;
      },
      commitHostileAct: (pid, key) => this.commitLockHostileAct(pid, key),
      refreshHostility: (pid, key) => this.refreshLockHostility(pid, key),
    });
  }

  private readonly _autoPickShape: FireTargetShape = newFireTargetShape();

  /**
   * The fire-gate shape of an NPC ship or structure at `pose` (#15: the
   * client's `fcTargetPose` fills the same fields from the swarm wire): a
   * ship by its kind, heading and shield (the shape its hits use,
   * `shipHitShape`), a structure by its radius (its lock signature).
   */
  private fillSwarmFireShape(rec: SwarmEntityRecord, pose: { x: number; y: number; angle: number }, out: FireTargetShape): void {
    fillFireTargetShape(out, pose.x, pose.y, pose.angle, rec.kind === 1, rec.shipKind ?? null, !rec.shieldDown, rec.radius);
  }

  /** Resolve a lock key (`s:<entityId>` | `p:<playerId>` | `p:<parked hull's
   *  shipInstanceId>`) to a damageable target. */
  resolveLockTarget(pid: string, key: string, out: LockTargetView): boolean {
    if (key.startsWith('s:')) {
      const rec = this.h.swarmRegistry.getByEntityId(swarmLockId(key)); // no slice per call (#14)
      if (!rec || !swarmLockEligible(rec.kind, out)) return false; // terrain: never hostile
      if (rec.kind === 2) {
        // A structure outside the registry (testMode `structurePoses`
        // fixtures) has no owner: lockable, never hostile (failsafe first).
        const owner = this.h.structureRegistry.get(rec.id)?.owner;
        if (owner === pid) return false; // never your own base
        out.hostile = owner !== undefined && relationOf(pid, owner, this.h.relationCtx) === 'hostile';
      } else if (!out.terrain) {
        out.hostile = this.h.npcHostileTo(rec.id, pid);
      }
      if (!this.h.swarmEntityPoseInto(rec.id, this._lockPose)) return false;
      out.vx = this._lockPose.vx; out.vy = this._lockPose.vy;
      this._lockTargetId = rec.id;
      this.fillSwarmFireShape(rec, this._lockPose, out);
      return true;
    }
    if (key.startsWith('p:')) {
      // A player's ship: an ACTIVE ship by its pilot's playerId, or a parked
      // (AI-flown) hull by its shipInstanceId (RTS Part A, owner: "lock it like
      // any player's ship"; the key the client's one ship list uses for it).
      // Same rules for both: never your own ship, PvP runs the failsafe first.
      const other = key.slice(2);
      if (other === pid) return false;
      let ship = this.h.getActiveShip(other);
      let p = ship !== undefined ? this.h.shipPoseCache.get(other) : undefined;
      if (ship === undefined) {
        // Liveness (#17): LINGERING hulls only (`lingeringSlots` + `isLingeringHull`).
        ship = this.h.lingeringSlots.has(other) ? this.h.state().ships.get(other) : undefined;
        if (ship === undefined || !isLingeringHull(ship) || ship.playerId === pid) return false;
        p = this.h.lingeringPoseCache.get(other);
      }
      if (!ship || !ship.alive || !p) return false;
      out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy;
      // Fire shape: the hit shape the pilot's ship is hit on (shipHitShape).
      fillFireTargetShape(out, p.x, p.y, p.angle, true, ship.kind, ship.shield > 0, 0);
      out.hostile = false; out.terrain = false; // PvP always runs the failsafe first
      this._lockTargetId = other;
      return true;
    }
    return false;
  }

  /** A failsafe finished: `pid` committed a hostile act against the target. */
  private commitLockHostileAct(pid: string, key: string): void {
    const tick = this.h.serverTick();
    if (key.startsWith('s:')) {
      const rec = this.h.swarmRegistry.getByEntityId(swarmLockId(key)); // no slice per call (#14)
      if (!rec || isTerrainLockKind(rec.kind)) return; // terrain: never a hostile act (no ledger, aggro, log)
      if (rec.kind === 2) {
        const owner = this.h.structureRegistry.get(rec.id)?.owner;
        if (owner !== undefined) this.h.hostileActs.record(pid, owner, this.h.gameClock.now());
      } else {
        this.h.aiController().markHostile(rec.id, pid, tick);
        this.h.broadcast('bot_aggro', { type: 'bot_aggro', botEntityId: `swarm-${rec.entityId}`, targetPlayerId: pid, tick });
      }
    }
    serverLogEvent('lock_hostile_act', { playerId: pid, target: key });
  }

  /**
   * "Locks keep it hostile" (owner 2026-11-10): a pilot's live lock on an NPC
   * ship that is already hostile to them re-stamps the hostility ledger, so the
   * 30 s `FORGET_TICKS` decay runs from when the lock drops, not from the last
   * hit (a 16" shell flies ~30 s). Individual hostility only: no faction
   * escalation, no `bot_aggro` (the client's hostility rides the snapshot
   * `drones[].hostile` bit, #16). Structures keep their own hostile-act rules.
   * Called per lock per lock step (~10 Hz); no allocation (#14).
   *
   * A lock holds out to the ship's lock range (its longest gun), past a group's reach, so only a lock held while
   * the pilot is inside the NPC's FIRE range refreshes (lead call): out of
   * its fire range the NPC forgets the pilot 30 s later, lock or no lock.
   */
  private refreshLockHostility(pid: string, key: string): void {
    if (!key.startsWith('s:')) return;
    const rec = this.h.swarmRegistry.getByEntityId(swarmLockId(key)); // no slice per call (#14)
    if (rec?.kind !== 1) return;
    if (!this.pilotInNpcFireRange(rec.id, pid)) return;
    this.h.aiController().markHostile(rec.id, pid, this.h.serverTick());
  }

  /** Fire-range target scratch for `pilotInNpcFireRange` (#14). */
  private readonly _fireRangeTarget: { -readonly [K in keyof MountRangeTarget]: MountRangeTarget[K] } = {
    kindId: null, angle: 0, shieldUp: true, radius: 0,
  };

  /** The pilot's engageable hull is inside NPC `npcId`'s FIRE range (any of
   *  its mounts reaches the hull, shared `mountsReachTarget`). */
  private pilotInNpcFireRange(npcId: string, pid: string): boolean {
    const h = this.h.engageablePilotHull(pid);
    const rec = this.h.swarmRegistry.get(npcId);
    if (!h || !rec || !this.h.swarmEntityPoseInto(npcId, this._lockPose)) return false;
    const t = this._fireRangeTarget;
    fillRangeShape(t, h.pose.angle, true, h.ship.kind, h.ship.shield > 0, 0);
    const nk = getShipKind(rec.shipKind ?? null);
    return mountsReachTarget(nk.mounts ?? NO_FIRE_MOUNTS, this._lockPose.x, this._lockPose.y, this._lockPose.angle, h.pose.x, h.pose.y, t);
  }

  /**
   * Fire control: true when the mount may fire at its group's lock: the
   * target's hit shape is within the mount's own weapon reach, measured from
   * the mount, and its barrel bears on it (shared `mountFiresOn`, the same
   * call as the client's fire passes, #15). A turret clamped at its arc
   * limit with the target outside the arc fails, so it can't fire. `size`: the mount's (mining reach, `weaponIdReach`).
   * A beam or slug also holds once its line to the lock has been blocked for the tolerance (`lineHeld`).
   */
  mountBearsOnLock(pid: string, mountId: string, mountIdx: number, ox: number, oy: number, angle: number, weaponId: WeaponId, size: WeaponMount['size']): boolean {
    // A wingman's locks live in `wingmanLocks` and resolve as its owner (RTS).
    const key = this.locksFor(pid).aimKeyFor(pid, mountId);
    if (key === null || !this.resolveLockTarget(this.lockOwner(pid), key, this._lockTarget)) return false;
    if (!mountFiresOn(weaponId, weaponIdReach(weaponId, size), ox, oy, angle, this._lockTarget)) return false;
    return !this.h.lineHeld(pid, mountIdx, weaponId, ox, oy, this._lockTarget.x, this._lockTarget.y, pid, this._lockTargetId);
  }

  /** Turret aim: the pose of the mount's group lock target (false = none). */
  lockAimTarget(pid: string, mountId: string, out: { x: number; y: number; vx: number; vy: number }): boolean {
    const key = this.locksFor(pid).aimKeyFor(pid, mountId);
    if (key === null || !this.resolveLockTarget(this.lockOwner(pid), key, this._lockTarget)) return false;
    out.x = this._lockTarget.x; out.y = this._lockTarget.y; out.vx = this._lockTarget.vx; out.vy = this._lockTarget.vy;
    return true;
  }}
