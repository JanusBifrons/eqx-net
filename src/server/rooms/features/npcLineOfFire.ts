/**
 * NPC line of fire (friendly fire slice 2) — the room's one line-of-fire gate
 * and who it treats as friendly. Moved verbatim out of `SectorRoom` (god-file
 * split slice 52); the room hands in live accessors.
 *
 * Before an NPC fires (drone slot, capital turret, structure turret) it asks
 * whether a FRIENDLY body lies on the shot's path to its target; if so it
 * holds fire this tick. "Friendly" mirrors `isFriendlyFire` (what a hit
 * would count as an accident): for an NPC ship of side A, ships of a
 * friendly allegiance and NPC structures not hostile to A; for a structure
 * turret, its own owner's structures (an NPC base also its faction's) and,
 * for an NPC base, ships of sides it isn't hostile to; a PLAYER's turret
 * also holds on its owner's own ship. Players are never gated.
 */
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import { isWreckPiece } from '../../net/SwarmEntityRegistry.js';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipState } from '../schema/SectorState.js';
import type { BlockedLineHold } from '../BlockedLineHold.js';
import type { WingmanPilots } from './wingmanPilots.js';
import { LineOfFireGate } from '../LineOfFireGate.js';
import { LofShipBody, type LofBody } from '../lofShipBody.js';
import { allegianceOfKind, type WeaponMount } from '../../../shared-types/shipKinds.js';
import { isFriendly, type NpcAllegianceId } from '../../../shared-types/allegiances.js';
import { isNpcOwner, relationOf, type RelationContext } from '../../../shared-types/relations.js';
import { SWARM_KIND_DRONE } from '../../../shared-types/swarmWireFormat.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF } from '../../../shared-types/sabLayout.js';
import { tuningFor } from '../../../shared-types/shipScale/lookup.js';
import { getWeapon, type WeaponId } from '../../../core/combat/WeaponCatalogue.js';
import { weaponIdReach } from '../../../core/combat/mountReach.js';
import { NAVAL_SHELL_WEAPON_IDS } from '../../../core/combat/shellFlight.js';

/** What the line-of-fire gate needs from the room; getters read the live field. */
export interface NpcLineOfFireHost {
  swarmRegistry: SwarmEntityRegistry;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  relationCtx: RelationContext;
  npcSideParty: Readonly<Record<NpcAllegianceId, string>>;
  sabF32(): Float32Array;
  serverTick(): number;
  /** Game-clock now (ms), for the blocked-line hold. */
  now(): number;
  playerToSlot(): ReadonlyMap<string, number>;
  lingeringSlots: ReadonlyMap<string, number>;
  shipPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  /** The room state's ships (lingering hulls, owned hulls). */
  ships(): { get(shipInstanceId: string): ShipState | undefined };
  getActiveShip(playerId: string): ShipState | undefined;
  playerHitscanDist(ship: ShipState, fx: number, fy: number, dx: number, dy: number, maxDist: number, cx: number, cy: number, angle: number, halfWidth?: number): number | null;
  swarmRayHit(rec: SwarmEntityRecord, fx: number, fy: number, dx: number, dy: number, maxDist: number, cx: number, cy: number, ca: number, hw?: number): number | null;
  /** Line-of-fire feedback to the shooter's brain. */
  noteBlocked(entityId: string, tick: number, blockerX: number, blockerY: number): void;
  /** Fire control's blocked-line hold (the mount ticker's, built in onCreate). */
  lineHold(): BlockedLineHold;
  wingmen(): Pick<WingmanPilots, 'hullTrigger' | 'wingmanFireKeys' | 'entityPoseInto'>;
}

export class NpcLineOfFire {
  /** testMode switch (`_internals.setNpcLineOfFire`): the slice-1 friendly
   *  fire tests turn it off to show what a shot hits. */
  enabled = true;
  /** Lazily built (needs the SAB). Null until the first check. */
  built: LineOfFireGate<LofBody> | null = null;
  /** The current check's shooter (set before each `blocked` call; #14). */
  private lofShooterKind = 0; // 1 = NPC ship, 2 = structure, 3 = owned hull (AI pilot)
  /** An owned hull's target (kind 3): never a blocker by any of its keys. */
  private lofTarget = '';
  /** Players' ships as gate bodies, one per ship key (`fillLofShips`). */
  private readonly lofShipBodies = new Map<string, LofShipBody>();
  private lofSide: NpcAllegianceId = 'drones';
  private lofOwner = '';
  private lofOwnerIsNpc = false;
  private lofShipGen = 0;
  /** Scratch: an owned hull's target pose (`hullLineBlocked`). */
  private readonly hullLofTarget = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

  constructor(private readonly host: NpcLineOfFireHost) {}

  /** Pre-bound predicate for the gate (made once, #14). */
  private readonly lofFriendly = (rec: LofBody): boolean => {
    const h = this.host;
    if (rec instanceof LofShipBody) {
      // A player's ship: an owned hull's AI pilot holds over every one (none
      // is its enemy but its target); a player's turret over its owner's
      // own ships; an NPC never.
      if (this.lofShooterKind === 3) return rec.sid !== this.lofTarget;
      return this.lofShooterKind === 2 && !this.lofOwnerIsNpc && rec.owner === this.lofOwner;
    }
    // An AI pilot (an NPC ship or an owned hull) never pours fire into a
    // wreck piece on its line: each shot would stop on it and its knock-back
    // shove it on ahead of the shooter, a dead hull flying beside a live
    // ship (take 11 "ghost ship").
    if (isWreckPiece(rec)) return this.lofShooterKind !== 2;
    if (rec.kind === SWARM_KIND_DRONE) {
      if (this.lofShooterKind === 1) return isFriendly(this.lofSide, allegianceOfKind(rec.shipKind));
      return this.lofOwnerIsNpc
        && relationOf(h.npcSideParty[allegianceOfKind(rec.shipKind)], this.lofOwner, h.relationCtx) !== 'hostile';
    }
    if (rec.kind !== 2) return false;
    const owner = h.structureRegistry.get(rec.id)?.owner;
    if (owner === undefined) return false;
    if (this.lofShooterKind === 1) {
      return isNpcOwner(owner) && relationOf(h.npcSideParty[this.lofSide], owner, h.relationCtx) !== 'hostile';
    }
    if (owner === this.lofOwner) return true;
    // An NPC base also holds over its own faction's other bases.
    return this.lofOwnerIsNpc && isNpcOwner(owner) && relationOf(this.lofOwner, owner, h.relationCtx) === 'friendly';
  };

  /** The one line-of-fire grid (built on first use). */
  gate(): LineOfFireGate<LofBody> {
    if (this.built === null) {
      const h = this.host;
      this.built = new LineOfFireGate<LofBody>({
        registry: h.swarmRegistry,
        sabF32: h.sabF32(),
        tick: () => h.serverTick(),
        ships: (out) => this.fillLofShips(out),
        rayHit: (rec, fx, fy, dx, dy, max, cx, cy, ca, hw) => rec instanceof LofShipBody
          ? h.playerHitscanDist(rec.ship!, fx, fy, dx, dy, max, cx, cy, ca, hw)
          : h.swarmRayHit(rec, fx, fy, dx, dy, max, cx, cy, ca, hw),
      });
    }
    return this.built;
  }

  /**
   * The players' ships for the line-of-fire grid (once per build): every
   * ACTIVE ship that is in the world (alive, not on a warp run) and every
   * LINGERING hull that is alive (#17: both are bodies a shot can hit; DEAD
   * and TRAVELLING are not). Bodies are kept per ship key, pruned when the
   * key leaves (#14: a new body only for a new ship key).
   */
  private fillLofShips(out: LofBody[]): number {
    const h = this.host;
    let n = 0;
    const gen = ++this.lofShipGen;
    for (const [pid, slot] of h.playerToSlot()) {
      const ship = h.getActiveShip(pid);
      if (!ship || !ship.alive || ship.travelling) continue;
      out[n++] = this.lofShipBody(pid, slot, ship, pid, gen);
    }
    const ships = h.ships();
    for (const [sid, slot] of h.lingeringSlots) {
      const ship = ships.get(sid);
      if (!ship || !ship.alive) continue;
      out[n++] = this.lofShipBody(sid, slot, ship, ship.playerId, gen);
    }
    if (this.lofShipBodies.size > n) {
      for (const [k, b] of this.lofShipBodies) if (b.gen !== gen) this.lofShipBodies.delete(k);
    }
    return n;
  }

  private lofShipBody(key: string, slot: number, ship: ShipState, owner: string, gen: number): LofShipBody {
    let b = this.lofShipBodies.get(key);
    if (b === undefined) { b = new LofShipBody(); b.id = key; this.lofShipBodies.set(key, b); }
    b.slot = slot;
    b.ship = ship;
    b.shipKind = ship.kind;
    b.radius = tuningFor(ship.kind).hitRadius;
    b.owner = owner;
    b.sid = ship.shipInstanceId;
    b.gen = gen;
    return b;
  }

  /** An NPC ship's line of fire (drone slot or capital turret). */
  npcShipLineBlocked(
    shooterId: string, targetId: string, fx: number, fy: number, dx: number, dy: number, maxDist: number, weaponId?: WeaponId, mountIdx = 0,
  ): boolean {
    if (weaponId !== undefined && this.lineHeld(shooterId, mountIdx, weaponId, fx, fy, fx + dx * maxDist, fy + dy * maxDist, shooterId, targetId)) return true;
    if (!this.enabled) return false;
    const rec = this.host.swarmRegistry.get(shooterId);
    if (rec == null || rec.kind !== SWARM_KIND_DRONE) return false;
    this.lofShooterKind = 1;
    this.lofSide = allegianceOfKind(rec.shipKind);
    const gate = this.gate();
    const blocked = gate.blocked(fx, fy, dx, dy, maxDist, shooterId, targetId, this.lofFriendly);
    if (!blocked) return false;
    // Line-of-fire feedback: tell the brain which ally held its shot (drone
    // slots via AiFireResolver AND capital turret barrels via the mount ticker
    // both come through here; the behaviour counts at most once per tick).
    this.host.noteBlocked(shooterId, this.host.serverTick(), gate.lastBlockerX, gate.lastBlockerY);
    return true;
  }

  /** A drone's slot shot: the distance is to its target's live pose. */
  droneLineBlocked(shooterId: string, targetId: string, fx: number, fy: number, dx: number, dy: number): boolean {
    if (!this.enabled || targetId === '') return false;
    let tx: number, ty: number;
    const pose = this.host.shipPoseCache.get(targetId);
    if (pose !== undefined) { tx = pose.x; ty = pose.y; } else {
      const t = this.host.swarmRegistry.get(targetId);
      if (t == null) return false; // unknown target: nothing to measure to
      const b = slotBase(t.slot);
      const sab = this.host.sabF32();
      tx = sab[b + SLOT_X_OFF]!; ty = sab[b + SLOT_Y_OFF]!;
    }
    return this.npcShipLineBlocked(shooterId, targetId, fx, fy, dx, dy, Math.hypot(tx - fx, ty - fy));
  }

  /** A structure turret's line of fire. */
  structureLineBlocked(
    rec: StructureRecord, targetId: string, fx: number, fy: number, dx: number, dy: number, maxDist: number, weaponId?: WeaponId, mountIdx = 0,
  ): boolean {
    if (weaponId !== undefined && this.lineHeld(rec.id, mountIdx, weaponId, fx, fy, fx + dx * maxDist, fy + dy * maxDist, rec.id, targetId)) return true;
    if (!this.enabled) return false;
    this.lofShooterKind = 2;
    this.lofOwner = rec.owner;
    this.lofOwnerIsNpc = isNpcOwner(rec.owner);
    // A player's turret never fires through its owner's own ships (the gate's
    // player-ship bodies: the active ship and parked hulls).
    return this.gate().blocked(fx, fy, dx, dy, maxDist, rec.id, targetId, this.lofFriendly);
  }

  /** Fire control's blocked-line hold (`BlockedLineHold`) on the one line-of-fire grid, in game time. */
  lineHeld(key: string, idx: number, weaponId: WeaponId, fx: number, fy: number, tx: number, ty: number, skipId: string, targetId: string): boolean {
    return this.host.lineHold().held(this.gate(), key, idx, weaponId, fx, fy, tx, ty, skipId, targetId, this.host.now());
  }

  /**
   * RTS Part B: an owned hull's barrel line (`PlayerFireResolver.fireHull`),
   * from its muzzle to the target its AI pilot holds the trigger on. The one
   * gate: a player's ship, the owner's structures or a wreck piece on the
   * line holds the shot, and the brain hears which ally blocked it (as an NPC
   * ship does). The line runs the shot's whole reach, not just to the target:
   * a shot that misses flies on into whoever is behind it. A bolt or missile
   * is checked as a moving shot (a friend that will cross its line in flight
   * holds it too). A pilot's own fire never comes here.
   */
  hullLineBlocked(
    sid: string, fx: number, fy: number, dx: number, dy: number, weaponId: WeaponId, svx: number, svy: number, size: WeaponMount['size'],
  ): boolean {
    if (!this.enabled) return false;
    const wingmen = this.host.wingmen();
    const targetId = wingmen.hullTrigger.get(sid) ?? wingmen.wingmanFireKeys.get(sid)?.id;
    const ship = this.host.ships().get(sid);
    const p = this.hullLofTarget;
    if (targetId === undefined || ship === undefined || !wingmen.entityPoseInto(targetId, p)) return false;
    this.lofShooterKind = 3;
    this.lofOwner = ship.playerId;
    this.lofOwnerIsNpc = false;
    this.lofTarget = targetId;
    const gate = this.gate();
    const w = getWeapon(weaponId);
    const dist = Math.hypot(p.x - fx, p.y - fy);
    // A beam or bolt that misses flies on to its reach; a missile homes and a
    // naval shell's line is checked to its target (as an AI capital's turret).
    const reach = w.mode === 'missile' || NAVAL_SHELL_WEAPON_IDS.has(weaponId) ? 0 : weaponIdReach(weaponId, size);
    const shotSpeed = w.mode === 'hitscan' ? 0 : w.speed;
    // A bolt hits by its catalogue radius (the projectile sweep's): the line is that wide.
    const shotRadius = w.mode === 'projectile' ? w.radius : 0;
    if (!gate.blocked(fx, fy, dx, dy, reach > dist ? reach : dist, sid, targetId, this.lofFriendly, shotSpeed, svx, svy, shotRadius)) return false;
    this.host.noteBlocked(sid, this.host.serverTick(), gate.lastBlockerX, gate.lastBlockerY);
    return true;
  }
}
