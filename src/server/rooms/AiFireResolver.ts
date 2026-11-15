/**
 * Per-drone weapon-fire pipeline (AI side).
 *
 * Mirrors the player hitscan path (`SectorRoom.handleFire`) but skips
 * the message parser, the per-session hit_ack, and the temporal-
 * plausibility window — AI fires at the current tick by definition.
 * Cooldown is enforced via the same `lastFireClientTick` Map keyed by
 * AI shooter id.
 *
 * Owns nothing of its own; reaches into the room via deps for the
 * cooldown ledger, the drone pose snapshot, the mount catalogue + slewed
 * angles, the player target candidates, and the damage / broadcast
 * seams. Single-fire-path-per-side contract (Invariant #12).
 *
 * Extracted from SectorRoom (commit 21 partial; src/server/CLAUDE.md
 * "Multi-mount fire path" section).
 */

import { hasTurretFireControl, mountInReach, mountWeaponReach } from '../../core/combat/mountReach.js';
import { barrelBearsOn, mountFireTolerance } from '../../core/combat/fireControlBearing.js';
import { DEFAULT_SHIP_KIND, getShipKind, type ShipKind, type WeaponMount } from '../../shared-types/shipKinds.js';
import {
  getWeapon,
  hitscanFalloffFrac,
  type MissileWeaponDef,
  type WeaponId,
} from '../../core/combat/WeaponCatalogue.js';
import { getWeaponObject } from '../../core/combat/weapons/index.js';
import type { WeaponFireContext, WeaponFireSink } from '../../core/combat/weapons/Weapon.js';
import type { AiEntity } from '../../core/contracts/IAiBehaviour.js';
import type { LaserFiredEvent } from '../../shared-types/messages.js';
import type { ShipState } from './schema/SectorState.js';
import { shipShotMuzzle, navalTurret, navalBarrelOffset } from '../../core/combat/muzzle.js';
import { NEVER_FIRED } from '../../core/combat/fireTemporal.js';
import { resolveSlotEnergyCost } from '../../core/combat/Energy.js';
import { NOT_CHARGING, type MountCharges } from './WeaponMountTicker.js';

/** Per-player pose the resolver reads to test target hits. */
export interface ShipPose {
  x: number;
  y: number;
  angle: number;
}

/** Narrow view of swarmRegistry — only `get(id)` is needed for kind + entityId. */
export interface SwarmRecLookup {
  get(id: string): { entityId: number; shipKind?: string | null } | null | undefined;
}

/** A fire target's centre and hit shape, for the per-mount range gate. */
export interface AiFireTargetShape {
  x: number;
  y: number;
  kindId?: string | null;
  angle?: number;
  shieldUp?: boolean;
  radius?: number;
}

export interface AiFireResolverDeps {
  /** THE per-mount charge store (`WeaponMountTicker.charges`), shared with
   *  capital turrets: a charge weapon's trigger writes each bearing mount's
   *  start tick, `releaseCharges` fires them. Absent ⇒ a charge weapon fires
   *  at once (unit harnesses). */
  mountCharges?: MountCharges;
  /** Fire range (owner decision 2026-11-14): fill `out` with `targetId`'s
   *  live centre and hit shape (a ship's kind, heading and shield, else a
   *  circle radius); false when unknown. A mount fires only when the target's
   *  hull is within its own weapon reach of it (`mountInReach`). Must not
   *  touch the `swarmEntitySnapshot` scratch. Absent / unknown ⇒ no range
   *  gate (unit harnesses, a shot with no target). */
  targetShape?: (targetId: string, out: AiFireTargetShape) => boolean;
  /** Fire control: refuse a shot at `targetId` when it is a pilot this NPC
   *  holds no completed lock on. Absent ⇒ never blocked. */
  fireBlocked?: (shooterId: string, targetId: string) => boolean;
  /** NPC line of fire (friendly fire slice 2): true ⇒ a FRIENDLY body lies
   *  between the shooter at (fx, fy) and `targetId` along unit (dx, dy), so
   *  the drone holds fire this tick (no cooldown spent). The room resolves the
   *  target's distance. Absent ⇒ never blocked (unit harnesses). */
  lineOfFireBlocked?: (shooterId: string, targetId: string, fx: number, fy: number, dx: number, dy: number) => boolean;
  /** The ship's energy pool (owner rule 2026-11-13: an AI pilot's ship pays a
   *  player's energy per slot trigger). Spends `cost` and returns true when
   *  the pool can pay; false ⇒ the shot is refused and nothing is spent. The
   *  room routes it to the AI pilot brain's pool (`IAiBehaviour.trySpendEnergy`),
   *  the same pool boost draws on. Absent ⇒ free fire (unit harnesses). */
  trySpendEnergy?: (shooterId: string, cost: number) => boolean;
  /** Cooldown ledger — keyed by shooter id (drone). */
  lastFireClientTick: Map<string, number>;
  /** Pose snapshot for the firing drone (SAB read). */
  swarmEntitySnapshot: (id: string) => AiEntity | null;
  /** Lookup for the drone's entityId + ship kind (wire id + mount list). */
  swarmRegistry: SwarmRecLookup;
  /** Resolves the active-slot mount list for a kind. */
  resolveSlotMounts: (kind: ShipKind, slotId?: string) => ReadonlyArray<WeaponMount>;
  /** Pure mount world-origin helper (composes mountGeometry.ts). */
  mountWorldOrigin: (
    shipX: number, shipY: number, shipAngle: number, mount: WeaponMount,
  ) => { x: number; y: number };
  /** Per-drone slewed mount angles (one Float32Array per drone). */
  droneMountAngles: Map<string, Float32Array>;
  /** Iterable of `[playerId, _]` for target candidates. */
  playerToSlot: Iterable<[string, number]>;
  /** Active-ship resolver — skips destroyed / lingering targets. */
  getActiveShip: (playerId: string) => ShipState | undefined;
  /** Per-tick player pose cache. */
  shipPoseCache: Map<string, ShipPose>;
  /** Shield-aware ray-vs-ship test (cheap circle / hull-polygon refine). */
  playerHitscanDist: (
    ship: ShipState,
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number,
    cx: number, cy: number, angle: number,
  ) => number | null;
  /** Damage sink — invoked on a confirmed hit. (hitX, hitY) is the beam's
   *  impact point, (dirX, dirY) its direction (capital wreck hit tracker and
   *  knock-back), `weaponId` the firing weapon. Returns true iff THIS call
   *  destroyed the target (the room's choke point does; mocks may not). */
  applyDamage: (
    targetId: string,
    shooterId: string,
    damage: number,
    hitX?: number,
    hitY?: number,
    dirX?: number,
    dirY?: number,
    weaponId?: WeaponId,
  ) => boolean | void;
  /** Friendly fire (owner decision 2026-11-10) — the first non-player thing
   *  along the beam: every swarm entity (drones of ANY side, structures of ANY
   *  owner, asteroids, scrap) and lingering hulls, skipping only `skipId` (the
   *  shooter). Returns a reused scratch (read it before the next call) or null.
   *  Absent ⇒ the beam tests players only (unit harnesses). Replaced the
   *  hostile-structure + other-allegiance passes, which let a beam pass through
   *  its own side. `passDebris`: wreck pieces and scrap don't stop the ray
   *  (a heavy beam's kill follow-through, `fireMount`). */
  nonPlayerRayHit?: (
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number, skipId: string,
    passDebris?: boolean,
  ) => { id: string; wireId: string; dist: number } | null;
  /** Shield-fence plan — if an ACTIVE shield wall lies along the beam within
   *  `maxDist`, absorb the shot (apply the wall's grid-power damage model) and
   *  return the crossing distance; else null. Absent ⇒ no walls in the sector
   *  (byte-identical to the pre-fence behaviour). */
  blockBeamAtWall?: (
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number, damage: number,
  ) => number | null;
  /** Broadcast a laser_fired event to every client. */
  broadcast: (type: 'laser_fired', msg: LaserFiredEvent) => void;
  /** Spawn a server-side projectile (delegates to ProjectilePipeline). Bolt
   *  drones (scout/fighter/heavy/gunship after the weapons overhaul) fire
   *  through this. */
  spawnServerProjectile: (
    ownerId: string,
    x: number, y: number, vx: number, vy: number,
    damage: number, radius: number, maxTicks: number,
    weaponId: WeaponId,
  ) => void;
  /** Spawn a server-side missile (delegates to MissileSimulation). Returns
   *  the assigned missileId on success or `null` on pool overflow. */
  spawnServerMissile: (
    ownerId: string,
    spawnX: number, spawnY: number,
    dirX: number, dirY: number,
    def: MissileWeaponDef,
  ) => number | null;
}

export class AiFireResolver implements WeaponFireSink {
  constructor(private readonly deps: AiFireResolverDeps) {}

  /** Reused per-mount fire geometry (the resolver IS the WeaponFireSink — see
   *  `src/core/combat/weapons/`). Mutated per mount; no per-fire allocation. */
  private readonly _fireCtx: WeaponFireContext = {
    fromX: 0, fromY: 0, dirX: 0, dirY: 0, shooterVx: 0, shooterVy: 0, mountId: '',
  };
  // Per-fire-event sink state — set in resolve() before the salvo.
  private _shooterId = '';
  /** The weapon of the barrel now resolving (set per mount before
   *  `resolveFire`), so a beam hit tells applyDamage what landed it. */
  private _weaponId: WeaponId | undefined = undefined;
  private _wireShooterId = '';
  /** Set by the hitscan sink when a beam of the shot now resolving destroyed
   *  what it hit (`fireMount` reports it: the heavy beam's follow-through). */
  private _shotKilled = false;
  /** The shot now resolving passes debris (set by `fireMount`). */
  private _passDebris = false;

  /**
   * Resolve an AI fire claim. Cooldown-rejected → silent no-op.
   * Zero-length direction → silent no-op. Per-mount iteration: each
   * mount in the drone's slot produces an independent laser_fired
   * broadcast with its own ray geometry; aggregate hit goes to the
   * damage sink (`applyDamage`).
   */
  resolve(shooterId: string, dirX: number, dirY: number, tick: number, targetId: string, cone = Infinity): void {
    const d = this.deps;

    const len = Math.hypot(dirX, dirY);
    if (len < 0.001) return;
    const dirNdx = dirX / len;
    const dirNdy = dirY / len;

    // Drone fires from its own pose, offset 16u along the firing
    // direction so it doesn't self-hit on the next-tick ray.
    const self = d.swarmEntitySnapshot(shooterId);
    if (!self) return;
    // `swarmEntitySnapshot` fills ONE shared scratch: any later lookup (the
    // line-of-fire gate, a hit test) overwrites it with another ship's pose.
    const hullAngle = self.angle, selfX = self.x, selfY = self.y;
    const shooterRec = d.swarmRegistry.get(shooterId);
    const droneKindId = shooterRec?.shipKind ?? DEFAULT_SHIP_KIND;
    const droneKind = getShipKind(droneKindId);
    // Capitals fire turret by turret under WeaponMountTicker fire control
    // (fireMount), never as a hull-aimed salvo.
    if (hasTurretFireControl(droneKind)) return;
    const slotMounts = d.resolveSlotMounts(droneKind);
    if (slotMounts.length === 0) return;
    // Slot-level cooldown gate (mirrors PlayerFireResolver). The slot fires
    // as one trigger; its cooldown is the MAX over its mounts' weapons.
    // Single-slot drones reuse the per-shooter scalar `lastFireClientTick`.
    // First: the AI pilot HOLDS the trigger while aimed (a request every
    // tick), so a reloading gun stops here before the lock and line scans.
    let slotCooldown = 0;
    for (let i = 0; i < slotMounts.length; i++) {
      const c = getWeapon(slotMounts[i]!.weaponId).cooldownTicks;
      if (c > slotCooldown) slotCooldown = c;
    }
    const lastFireCt = d.lastFireClientTick.get(shooterId) ?? NEVER_FIRED;
    if (tick - lastFireCt < slotCooldown) return;
    // Fire control: a pilot target needs a COMPLETED lock by this drone ⇒
    // no shot (the cooldown is not spent).
    if (d.fireBlocked?.(shooterId, targetId)) return;
    // Line of fire: an ally (or its own base) in the way ⇒ hold this tick
    // without spending the cooldown, so a held shot fires the moment the line
    // clears.
    if (d.lineOfFireBlocked?.(shooterId, targetId, selfX, selfY, dirNdx, dirNdy)) return;
    // Fire control: a barrel fires only when it bears on the aim (the pilot's
    // rule, `mountFireTolerance`). Every shot leaves down its drawn barrel, so
    // a gun that doesn't bear would fire visibly off its target (owner
    // 2026-11-14: "turrets aren't turning to shoot the direction they do").
    // None bears ⇒ hold, spending no cooldown (a turret still slewing). The AI
    // pilot's `cone` (the angle the target's hull covers, pilot skill) narrows
    // each barrel's window further: it fires only when the shot will hit.
    // Range: a mount fires only when the target's hull is within its own
    // weapon reach of it, measured from the mount (owner 2026-11-14; a lock
    // alone is no licence to fire from any distance).
    const shape = targetId !== '' && d.targetShape?.(targetId, this._targetShape) === true ? this._targetShape : null;
    const bearMask = this.bearingMask(shooterId, selfX, selfY, hullAngle, slotMounts, dirNdx, dirNdy, shape, cone);
    if (bearMask === 0) return;

    // Energy gate, the player's rule (PlayerFireResolver): the slot trigger
    // costs `resolveSlotEnergyCost` once; a short pool refuses the shot
    // WITHOUT spending the cooldown, so it fires the moment it can pay.
    if (d.trySpendEnergy !== undefined && !d.trySpendEnergy(shooterId, resolveSlotEnergyCost(droneKind))) return;
    d.lastFireClientTick.set(shooterId, tick);

    // Living World P3c — a CHARGE weapon winds up instead of firing: each
    // mount that bears now starts charging in the shared per-mount store
    // (`WeaponMountTicker.charges`, the snapshot's `chargingMask`), and
    // `releaseCharges` fires them `chargeTicks` later.
    const charges = d.mountCharges;
    if (charges !== undefined && slotChargeTicks(slotMounts) > 0) {
      const starts = charges.startsFor(shooterId, slotMounts.length);
      for (let i = 0; i < slotMounts.length; i++) {
        const bears = i > 30 ? (bearMask & (1 << 30)) !== 0 : (bearMask & (1 << i)) !== 0;
        starts[i] = bears ? tick : NOT_CHARGING;
      }
      return;
    }
    this.fireNow(shooterId, -1, bearMask);
  }

  /** Reused target shape for the range gate (#14). */
  private readonly _targetShape: AiFireTargetShape = { x: 0, y: 0, kindId: null, angle: 0, shieldUp: false, radius: 0 };

  /** Bit i set ⇔ slot mount i's barrel (hull + base + slewed angle) bears on
   *  the aim direction within its weapon's window (`mountFireTolerance`, the
   *  pilot's rule, #19), narrowed to `cone` (the target hull's angular size),
   *  AND, with a known `target`, the target's hull is within the mount's own
   *  weapon reach of its world origin (`mountInReach`).
   *  Mounts past bit 30 always count as bearing. */
  private bearingMask(
    shooterId: string, sx: number, sy: number, hullAngle: number, slotMounts: ReadonlyArray<WeaponMount>,
    dirX: number, dirY: number, target: AiFireTargetShape | null, cone: number,
  ): number {
    const angles = this.deps.droneMountAngles.get(shooterId);
    const cosA = Math.cos(hullAngle), sinA = Math.sin(hullAngle);
    let mask = 0;
    for (let i = 0; i < slotMounts.length; i++) {
      if (i > 30) { mask |= 1 << 30; continue; }
      const m = slotMounts[i]!;
      const reach = mountWeaponReach(m);
      if (target !== null) {
        const mx = sx + (m.localX * cosA - m.localY * sinA);
        const my = sy + (m.localX * sinA + m.localY * cosA);
        if (!mountInReach(target.x - mx, target.y - my, reach, target)) continue;
      }
      const a = hullAngle + m.baseAngle + (angles?.[i] ?? 0);
      const tol = mountFireTolerance(m.weaponId, reach);
      if (barrelBearsOn(0, 0, a, dirX, dirY, cone < tol ? cone : tol)) mask |= 1 << i;
    }
    return mask;
  }


  /** Capital fire control: fire ONE mount along its barrel (hull angle +
   *  base angle + the slewed mount angle). Reload, reach and on-target checks
   *  are the caller's (WeaponMountTicker.tickDrone). Pays energy as a player
   *  capital's turret does (PlayerFireResolver per-mount path: a partial
   *  salvo pays its share), i.e. slot cost / mounts per mount. Returns false
   *  when refused (no pose, or the pool can't pay) so the caller keeps the
   *  reload; 'killed' when it fired and one of its beams destroyed what it hit
   *  (the caller's follow-through, `WeaponDefBase.followThroughTicks`); else
   *  true. `passDebris`: the beam passes wreck pieces and scrap (no hit, no
   *  knock-back) and runs on to a ship, structure, rock or its full range
   *  (the kill follow-through: "cut right through"). */
  fireMount(shooterId: string, mountIdx: number, passDebris = false): boolean | 'killed' {
    const d = this.deps;
    const self = d.swarmEntitySnapshot(shooterId);
    if (!self) return false;
    if (d.trySpendEnergy !== undefined) {
      const kind = getShipKind(d.swarmRegistry.get(shooterId)?.shipKind ?? DEFAULT_SHIP_KIND);
      const n = Math.min(d.resolveSlotMounts(kind).length, 31);
      if (n > 0 && !d.trySpendEnergy(shooterId, resolveSlotEnergyCost(kind) / n)) return false;
    }
    this._shotKilled = false;
    this._passDebris = passDebris;
    this.fireNow(shooterId, mountIdx);
    this._passDebris = false;
    return this._shotKilled ? 'killed' : true;
  }
  /** Quad AA: the next barrel to fire, per shooter and mount index. */
  private readonly aaBarrel = new Map<string, Uint8Array>();

  /** Release every salvo-path charge whose wind-up has elapsed (call once per
   *  server tick, after the AI tick). Fires the mounts that bore at the
   *  trigger pull from the shooter's CURRENT pose, down their barrels (where
   *  the gun is drawn), so a target that dodged the wind-up is missed (the
   *  'locked-direction' rule). Capital turrets release their own charges in
   *  `WeaponMountTicker.tickCapitalMounts`. Allocation-free. */
  releaseCharges(tick: number): void {
    const charges = this.deps.mountCharges;
    if (charges === undefined || charges.starts.size === 0) return;
    for (const [id, starts] of charges.starts) {
      const rec = this.deps.swarmRegistry.get(id);
      if (!rec) continue;
      const kind = getShipKind(rec.shipKind ?? DEFAULT_SHIP_KIND);
      if (hasTurretFireControl(kind)) continue;
      const chargeTicks = slotChargeTicks(this.deps.resolveSlotMounts(kind));
      let mask = 0;
      for (let i = 0; i < starts.length; i++) {
        const s = starts[i]!;
        if (s === NOT_CHARGING || tick - s < chargeTicks) continue;
        starts[i] = NOT_CHARGING;
        mask |= 1 << Math.min(i, 30);
      }
      if (mask !== 0) this.fireNow(id, -1, mask);
    }
  }

  /** The shooter left the world. Its charges live in the shared store,
   *  dropped by `WeaponMountTicker.clearDrone` on the same eviction. */
  forget(shooterId: string): void {
    this.aaBarrel.delete(shooterId);
  }

  /** Fire the shooter's active slot now, each mount down its own barrel.
   *  `onlyMount` ≥ 0 fires that mount alone; `mask` picks mounts by bit. */
  private fireNow(shooterId: string, onlyMount = -1, mask = -1): void {
    const d = this.deps;
    const self = d.swarmEntitySnapshot(shooterId);
    if (!self) return;
    // Copy the pose out of the shared scratch NOW: a hit test inside the
    // mount loop looks up other ships through it, and the next barrel then
    // fired from the target's pose and angle (a twin turret's second beam
    // left far off its drawn barrel; aiTurretFacesShot integration test).
    const sx = self.x, sy = self.y, sAngle = self.angle, svx = self.vx, svy = self.vy;
    const shooterRec = d.swarmRegistry.get(shooterId);
    const droneKindId = shooterRec?.shipKind ?? DEFAULT_SHIP_KIND;
    const droneKind = getShipKind(droneKindId);
    const slotMounts = d.resolveSlotMounts(droneKind);
    if (slotMounts.length === 0) return;

    const wireShooterId = shooterRec ? `swarm-${shooterRec.entityId}` : shooterId;
    const droneAngles = d.droneMountAngles.get(shooterId);
    this._shooterId = shooterId;
    this._wireShooterId = wireShooterId;
    const ctx = this._fireCtx;

    // Per-mount weapon resolution (weapons/energy/AI overhaul §1). Each barrel
    // fires its OWN catalogue weapon, range/damage off the resolved def. The
    // per-mode fire dispatch collapses to one virtual call (GEP B3): the weapon
    // flyweight calls back the matching sink method below.
    for (let mIdx = 0; mIdx < slotMounts.length; mIdx++) {
      if (onlyMount >= 0 && mIdx !== onlyMount) continue;
      if (mIdx < 31 && (mask & (1 << mIdx)) === 0) continue;
      const mount = slotMounts[mIdx]!;
      const mountWorld = d.mountWorldOrigin(sx, sy, sAngle, mount);
      const currentMountAngle = droneAngles?.[mIdx] ?? 0;
      // EVERY mount fires down its barrel: hull angle + base + slewed angle
      // (0 for a fixed gun), the angle the client draws the gun and the beam
      // at (PixiRenderer remote beams, #15). Adding the slewed angle to the
      // AI's aim vector fired at twice the hull's bearing error (#572), and a
      // fixed gun fired along the aim vector, up to 26° off its drawn nose gun
      // (owner 2026-11-14: "turrets aren't turning to shoot the direction they
      // do"). Accuracy comes from the bearing gate instead (`bearingMask`).
      const mountFireAngle = sAngle + mount.baseAngle + currentMountAngle;
      const ndx = -Math.sin(mountFireAngle);
      const ndy = Math.cos(mountFireAngle);
      // Barrel tip for a turning turret; chin guns keep the drone clearance.
      const muzzleD = shipShotMuzzle(droneKind, mount, true);
      const rayFromX = mountWorld.x + ndx * muzzleD;
      const rayFromY = mountWorld.y + ndy * muzzleD;

      ctx.fromX = rayFromX;
      ctx.fromY = rayFromY;
      ctx.dirX = ndx;
      ctx.dirY = ndy;
      ctx.shooterVx = svx;
      ctx.shooterVy = svy;
      ctx.mountId = mount.id;
      this._weaponId = mount.weaponId;
      // A naval turret fires a full salvo: one shell per barrel, each from
      // its own drawn barrel tip (shared offsets, core/combat/muzzle.ts).
      const naval = navalTurret(droneKind, mount);
      if (naval === null || naval.barrels <= 1) {
        getWeaponObject(mount.weaponId).resolveFire(ctx, this);
        continue;
      }
      const rightX = ndy, rightY = -ndx;
      if (mount.size === 'AA') {
        // Quad AA: the barrels fire in turn, one per trigger (a stream).
        let cyc = this.aaBarrel.get(shooterId);
        if (cyc === undefined || cyc.length < slotMounts.length) { cyc = new Uint8Array(slotMounts.length); this.aaBarrel.set(shooterId, cyc); }
        const k = cyc[mIdx]! % naval.barrels;
        cyc[mIdx] = k + 1;
        const off = navalBarrelOffset(naval, k);
        ctx.fromX = rayFromX + rightX * off;
        ctx.fromY = rayFromY + rightY * off;
        getWeaponObject(mount.weaponId).resolveFire(ctx, this);
        continue;
      }
      for (let k = 0; k < naval.barrels; k++) {
        const off = navalBarrelOffset(naval, k);
        ctx.fromX = rayFromX + rightX * off;
        ctx.fromY = rayFromY + rightY * off;
        getWeaponObject(mount.weaponId).resolveFire(ctx, this);
      }
    }
  }

  // ─── WeaponFireSink — relocated VERBATIM from the former mode if-tree (GEP B3) ───

  /** Beam: instant lag-comp-free hit test against live player poses; on hit,
   *  applyDamage (internal shooter id); always broadcast laser_fired on the
   *  WIRE shooter id. */
  hitscan(ctx: WeaponFireContext, range: number, damage: number, falloffMinDamageFrac?: number, maxRange?: number): void {
    const d = this.deps;
    // P3.13 — `range` is the OPTIMAL (full-damage) range; the ray reaches
    // `maxRange` (≥ range) and damage falls off reverse-square BEYOND optimal.
    const rayRange = maxRange ?? range;
    const rayFromX = ctx.fromX;
    const rayFromY = ctx.fromY;
    const ndx = ctx.dirX;
    const ndy = ctx.dirY;
    let hitId: string | null = null;
    let wireHitId: string | null = null;
    let hitDist = Infinity;
    for (const [targetId] of d.playerToSlot) {
      const targetShip = d.getActiveShip(targetId);
      if (!targetShip || !targetShip.alive) continue;
      const pose = d.shipPoseCache.get(targetId);
      if (!pose) continue;
      const dist = d.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, rayRange, pose.x, pose.y, pose.angle);
      if (dist !== null && dist < hitDist) {
        hitDist = dist;
        hitId = targetId;
        wireHitId = targetId;
      }
    }

    // Friendly fire (owner decision 2026-11-10): everything else in the path,
    // whatever its side — drones, structures, rocks, scrap, parked hulls.
    // Closest-of-both wins, so an ally in front of the target takes the beam.
    const other = d.nonPlayerRayHit?.(rayFromX, rayFromY, ndx, ndy, Math.min(rayRange, hitDist), this._shooterId, this._passDebris) ?? null;
    if (other !== null && other.dist < hitDist) {
      hitDist = other.dist;
      hitId = other.id;
      wireHitId = other.wireId;
    }

    // Shield-fence plan: an ACTIVE shield wall in front of the target absorbs
    // the beam (the wall takes the hit; the target behind takes nothing). Only
    // walls closer than the resolved target (or the range, with no target) count.
    const scanDist = hitDist === Infinity ? rayRange : hitDist;
    const wallDist = d.blockBeamAtWall?.(rayFromX, rayFromY, ndx, ndy, scanDist, damage) ?? null;
    if (wallDist === null && hitId) {
      // P3.13 — full to optimal `range`, reverse-square falloff to maxRange
      // (server-authoritative; the client never predicts beam damage).
      const effDamage = falloffMinDamageFrac !== undefined
        ? damage * hitscanFalloffFrac(hitDist, range, rayRange, falloffMinDamageFrac)
        : damage;
      // The impact point and direction ride the damage call itself (wreck hit
      // tracker, knock-back; the damage event reports the true impact point).
      if (d.applyDamage(hitId, this._shooterId, effDamage, rayFromX + ndx * hitDist, rayFromY + ndy * hitDist, ndx, ndy, this._weaponId) === true) {
        this._shotKilled = true;
      }
    }

    const blocked = wallDist !== null;
    const endDist = blocked ? wallDist : scanDist;
    const beamEndX = rayFromX + ndx * endDist;
    const beamEndY = rayFromY + ndy * endDist;

    d.broadcast('laser_fired', {
      type: 'laser_fired',
      shooterId: this._wireShooterId,
      mountId: ctx.mountId,
      fromX: rayFromX,
      fromY: rayFromY,
      toX: beamEndX,
      toY: beamEndY,
      hit: blocked || !!hitId,
      targetId: blocked ? undefined : (wireHitId ?? undefined),
    });
  }

  /** Bolt: spawn a server projectile (inherits the drone's velocity). */
  spawnProjectile(
    ctx: WeaponFireContext,
    vx: number,
    vy: number,
    damage: number,
    radius: number,
    maxTicks: number,
    weaponId: WeaponId,
  ): void {
    this.deps.spawnServerProjectile(this._shooterId, ctx.fromX, ctx.fromY, vx, vy, damage, radius, maxTicks, weaponId);
  }

  /** Missile: lock-at-launch + lifecycle owned by MissileSimulation. */
  spawnMissile(ctx: WeaponFireContext, def: MissileWeaponDef): void {
    this.deps.spawnServerMissile(this._shooterId, ctx.fromX, ctx.fromY, ctx.dirX, ctx.dirY, def);
  }
}

/** The salvo path's charge time: the longest `chargeTicks` among the slot's
 *  mounts (the slot fires as one trigger), 0 ⇒ no charge weapon. */
function slotChargeTicks(slotMounts: ReadonlyArray<WeaponMount>): number {
  let t = 0;
  for (let i = 0; i < slotMounts.length; i++) {
    const c = getWeapon(slotMounts[i]!.weaponId).chargeTicks ?? 0;
    if (c > t) t = c;
  }
  return t;
}
