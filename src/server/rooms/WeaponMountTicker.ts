/**
 * Per-tick weapon-mount aim updater.
 *
 * Owns the per-mount target-pick + slew state for every ship + drone:
 *   - `playerMountAngles` / `droneMountAngles` — Float32Array of slewed
 *     arc-local angles, indexed by mount-catalogue order.
 *   - `playerSlotTargets` / `droneSlotTargets` — sticky pickTarget
 *     prevTargetId hysteresis (10 % distance via STICKY_HYSTERESIS_FACTOR).
 *   - `droneMountTargetsScratch` — pooled
 *     MountTargetView arrays, rebuilt once per tick and shared across all
 *     shooters that tick.
 *
 * Composes the pure `pickTarget` / `rotateMountToward` helpers from
 * `@core/ai/WeaponMountController` (the canonical single-write-path per
 * src/core/CLAUDE.md "WeaponMountController contract"). Reads SAB poses
 * for drones (where the kinematic body is live in the worker) and
 * `shipPoseCache` for players (where the main thread already cached the
 * pose from the SAB at the top of the tick).
 *
 * Server-side single write path for mount angles (Invariant #12). The
 * client's `tickLocalMountAim` is the matching client-side single
 * writer; both call into the same pure controller for determinism.
 */

import {
  pickTarget,
  rotateMountToward,
  wrapPi,
  type MountTargetView,
} from '../../core/ai/WeaponMountController.js';

import { mountTargetReach, mountWeaponReach, hasTurretFireControl } from '../../core/combat/mountReach.js';
import { mountLineClear, mountPriority, targetClass } from '../../core/combat/mountTargeting.js';
import { leadArcBearing, mountCanEngage, onTarget } from '../../core/combat/mountFireControl.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';

import {
  DEFAULT_SHIP_KIND,
  getShipKind,
  type ShipKind,
  type ShipKindId,
  type WeaponMount,
} from '../../shared-types/shipKinds.js';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import type { ShipState } from './schema/SectorState.js';

/** Narrow view of the per-tick cached player pose the room maintains. */
export interface ShipPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

/** Narrow view of the swarm-registry record the ticker needs. */
export interface SwarmRecord {
  id: string;
  slot: number;
  kind: number;
  shipKind?: ShipKindId | null;
}

/** Narrow view of `swarmRegistry` the ticker iterates. */
export interface SwarmRecordSource {
  all(): Iterable<SwarmRecord>;
  size(): number;
}

/** Narrow view of `aiController` for hostility-filter lookup. */
export interface BehaviourLookup {
  getBehaviour(entityId: string): unknown;
}

/** Narrow view of the per-player slot map the ticker reads. */
export interface PlayerSlotSource {
  size: number;
  // Iterable [playerId, _] pairs — same shape as Map<string, number>.
  [Symbol.iterator](): IterableIterator<[string, number]>;
}

export interface WeaponMountTickerDeps {
  /** SAB Float32 view — drones read pose from here, slot-indexed. */
  sabF32: Float32Array;
  /** Iterable of `[playerId, slot]` (i.e. the `playerToSlot` Map). */
  playerToSlot: PlayerSlotSource;
  /** Source for swarm records (drones; asteroids are filtered out by kind). */
  swarmRegistry: SwarmRecordSource;
  /** Per-tick cached player poses (already SAB-read at top of update()). */
  shipPoseCache: Map<string, ShipPose>;
  /** Returns the active ShipState for a playerId or undefined for lingering/missing. */
  getActiveShip: (playerId: string) => ShipState | undefined;
  /** Hostility ledger lookup — driven by `markHostile`/`purgeHostility`. */
  aiController: BehaviourLookup;
  /** Drone hull health, keyed by swarm id — for health-weighted player aim
   *  (Part C). Same source as the snapshot `hp` percent, so the predicted
   *  client aim (which reads the synced `hp`) and this server aim agree.
   *  LAZY accessor: the backing map (shieldHullRouter.swarmHealth) is built
   *  AFTER this ticker in SectorRoom's constructor, so resolve it per-tick. */
  swarmHealth: () => Map<string, number>;
  /** Resolves the active-slot mount list for a kind (composes mountGeometry).
   *  Used by the DRONE path (drones never carry activated latent mounts). */
  resolveSlotMounts: (kind: ShipKind, slotId?: string) => ReadonlyArray<WeaponMount>;
  /** WS-B3 — the PLAYER's full per-instance mount list `[...kind.mounts,
   *  ...activated latent]` (the `mountAngles[]` index space — base mounts keep
   *  catalogue indices, activated append). Reads `ship.mounts`. */
  resolveInstanceMounts: (ship: ShipState) => ReadonlyArray<WeaponMount>;
  /** WS-B3 — the PLAYER's FIRING mount set `[...active-slot, ...activated]` —
   *  only these aim at the target; every other instance mount slews to base.
   *  Reads `ship.mounts` + the active slotId. */
  resolveInstanceFireMounts: (ship: ShipState) => ReadonlyArray<WeaponMount>;
  /** Capital fire control (plan prancy-squishing-donut Phase 3). The current
   *  server tick, for per-mount reload timing. Optional: absent ⇒ no turret
   *  fire control (unit harnesses that only test aim). */
  currentTick?: () => number;
  /** Called when a pilot's turret state is cleared (leave, respawn, evict). */
  onClearPlayer?: (playerId: string) => void;
  /** Fire control: the lock target pose for one of the pilot's mounts (false =
   *  none: the mount slews home). Absent (aim-only unit harnesses) ⇒ none. */
  aimTargetFor?: (playerId: string, mountId: string, out: { x: number; y: number; vx: number; vy: number }) => boolean;
  /** Fire ONE mount of a capital drone along its barrel (the resolver reads
   *  the slewed angle). Called only when that mount is on target, in reach
   *  and reloaded. */
  fireDroneMount?: (droneId: string, mountIdx: number) => void;
}

const DT_SEC = 1 / 60;
/** The on-target rules live with the shared fire control (plan
 *  coastal-defences: capitals and defence structures use one set);
 *  re-exported for existing callers. */
export { TURRET_FIRE_TOLERANCE, TURRET_FIRE_MISS } from '../../core/combat/mountFireControl.js';
/** A capital turret searches for a new target this often (ticks), staggered. */
export const RETARGET_TICKS = 30;
/** ...and keeps aiming at a target it briefly can't engage for this long. */
export const TARGET_HOLD_TICKS = 60;

export class WeaponMountTicker {
  /** Per-mount slewed arc-local angles, keyed by playerId. */
  readonly playerMountAngles = new Map<string, Float32Array>();
  /** Per-drone equivalent. Allocated lazily — drones with all-static
   *  mounts (legacy fighter/scout/heavy) never get an entry. */
  readonly droneMountAngles = new Map<string, Float32Array>();
  /** Sticky targetId per shooter (for pickTarget hysteresis). */
  readonly playerSlotTargets = new Map<string, string | null>();

  readonly droneSlotTargets = new Map<string, string | null>();
  /** Capital fire control: last fire tick per mount, keyed by drone id. */
  readonly droneMountReload = new Map<string, Int32Array>();

  /** Pooled per-tick player candidates (rebuilt by tickDrone). Logical-length
   *  over physical slot (plan: quirky-rabbit, Phase 5): slots are reused and
   *  `targets.length = n` truncates, so no literal per candidate per tick. */
  private readonly droneMountTargetsScratch: MountTargetView[] = [];
  /** Ship kind of each droneMountTargetsScratch entry (same index). */
  private readonly droneTargetKinds: string[] = [];
  /** Capitals: tick each mount last could engage its target, keyed by drone id. */
  readonly droneMountLastOk = new Map<string, Int32Array>();
  /** Capitals: each mount's current target id, keyed by drone id. */
  readonly droneMountTargetIds = new Map<string, (string | null)[]>();

  /** Fire control: reused lock-target pose (alloc-free, #14). */
  private readonly _fcTarget = { x: 0, y: 0, vx: 0, vy: 0 };

  /** Acquire-or-create a MountTargetView slot. Subsequent calls
   *  overwrite the SAME instance, eliminating per-tick literal allocs.
   *
   *  The MountTargetView contract (`src/core/ai/WeaponMountController.ts`)
   *  declares its fields `readonly` so consumers can't mutate the
   *  shared view between picks. We violate that at THIS write site
   *  ONLY — the cast to `MutableMountTargetView` is local; downstream
   *  readers (`pickTarget`) still see the readonly interface and can't
   *  mutate. The consumers also don't retain references past the
   *  tick (verified: `pickTarget` returns `target?.id` upstream of
   *  storage), so the reuse is invisible to them. */
  private static writeTargetSlot(
    arr: MountTargetView[],
    i: number,
    id: string,
    x: number,
    y: number,
    vx: number,
    vy: number,
    health?: number,
    maxHealth?: number,
  ): void {
    type MutableMountTargetView = { -readonly [K in keyof MountTargetView]: MountTargetView[K] };
    const slot = arr[i] as MutableMountTargetView | undefined;
    if (!slot) {
      arr[i] = { id, x, y, vx, vy, health, maxHealth };
      return;
    }
    slot.id = id;
    slot.x = x;
    slot.y = y;
    slot.vx = vx;
    slot.vy = vy;
    // Always assign (reused scratch) so a slot that previously held health
    // doesn't leak a stale value into a target that now has none.
    slot.health = health;
    slot.maxHealth = maxHealth;
  }

  constructor(private readonly deps: WeaponMountTickerDeps) {}

  /**
   * Compute every player's mount angles for this tick.
   *
   * Lock-to-fire is universal: each mount aims at ITS weapon group's lock
   * target (the first LOCKED one, else the one being acquired, so turrets
   * pre-slew), and a group with no target slews home. There is no player
   * auto-target any more. Same rule as the client's `fcTickMountAngles`
   * (#12/#15). No-op when no players are bound to slots.
   */
  tickPlayer(): void {
    const d = this.deps;
    if (d.playerToSlot.size === 0) return;
    const t = this._fcTarget;
    for (const [playerId] of d.playerToSlot) {
      const ship = d.getActiveShip(playerId);
      if (!ship?.alive) continue;
      const pose = d.shipPoseCache.get(playerId);
      if (!pose) continue;
      // WS-B3 — the angle index space is the FULL per-instance list
      // `[...kind.mounts, ...activated]`.
      const mounts = d.resolveInstanceMounts(ship);
      if (mounts.length === 0) continue;
      let angles = this.playerMountAngles.get(playerId);
      if (!angles || angles.length !== mounts.length) {
        angles = new Float32Array(mounts.length);
        this.playerMountAngles.set(playerId, angles);
      }
      const cosA = Math.cos(pose.angle);
      const sinA = Math.sin(pose.angle);
      for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i]!;
        if (!d.aimTargetFor || !d.aimTargetFor(playerId, mount.id, t)) {
          angles[i] = rotateMountToward(angles[i]!, 0, mount, DT_SEC);
          continue;
        }
        const mx = pose.x + (mount.localX * cosA - mount.localY * sinA);
        const my = pose.y + (mount.localX * sinA + mount.localY * cosA);
        const bearing = Math.atan2(-(t.x - mx), t.y - my);
        angles[i] = rotateMountToward(angles[i]!, wrapPi(bearing - pose.angle - mount.baseAngle), mount, DT_SEC);
      }
    }
  }

  /**
   * Compute every drone's mount angles for this tick.
   *
   * Mirrors `tickPlayer` but iterates the swarm registry: each drone
   * whose ship-kind has at least one rotating mount runs `pickTarget`
   * (with player ships as candidates, filtered through the drone's
   * `hostileTo` set via `aiController.getBehaviour`), then slews each
   * mount toward the picked bearing via `rotateMountToward`.
   *
   * Drones whose kind has no rotating mounts (legacy fighter/scout/
   * heavy — single 'forward' mount with zero arc) are skipped entirely;
   * their `droneMountAngles` entry is never allocated, saving compute
   * and snapshot bytes (the wire field is omitted for empty arrays).
   *
   * Hostility model: only players the drone has been damaged by are in
   * view. A drone with no hostile players slews its mounts back toward
   * 0 (forward).
   */
  tickDrone(): void {
    const d = this.deps;
    if (d.swarmRegistry.size() === 0) return;

    // Build the player candidate list once per tick (shared across all
    // drones). Logical-length over physical slot as above.
    const targets = this.droneMountTargetsScratch;
    let count = 0;
    for (const [pid] of d.playerToSlot) {
      const ship = d.getActiveShip(pid);
      if (!ship?.alive) continue;
      const pose = d.shipPoseCache.get(pid);
      if (!pose) continue;
      WeaponMountTicker.writeTargetSlot(targets, count, pid, pose.x, pose.y, pose.vx, pose.vy);
      this.droneTargetKinds[count] = ship.kind;
      count++;
    }
    targets.length = count;

    for (const rec of d.swarmRegistry.all()) {
      if (rec.kind !== 1) continue; // asteroids: no turrets
      const kindId = rec.shipKind ?? DEFAULT_SHIP_KIND;
      const kind = getShipKind(kindId);
      const mounts = d.resolveSlotMounts(kind);
      // Skip drones whose mounts are all static — they have nothing to
      // slew. This is the common case, so the early bail is the hot
      // path.
      let hasRotatingMount = false;
      for (const m of mounts) {
        if (m.rotationSpeed > 0 && m.arcMax > m.arcMin) {
          hasRotatingMount = true;
          break;
        }
      }
      if (!hasRotatingMount) {
        // Defensive cleanup if a drone's kind ever loses its rotation
        // (catalogue change mid-life — currently impossible).
        if (this.droneMountAngles.has(rec.id)) this.droneMountAngles.delete(rec.id);
        if (this.droneSlotTargets.has(rec.id)) this.droneSlotTargets.delete(rec.id);
        continue;
      }

      const b = slotBase(rec.slot);
      const droneX = d.sabF32[b + SLOT_X_OFF]!;
      const droneY = d.sabF32[b + SLOT_Y_OFF]!;
      const droneAngle = d.sabF32[b + SLOT_ANGLE_OFF]!;

      // Hostility filter — same source of truth as HostileDroneBehaviour.
      // The behaviour instance lives inside `AiController`; query via
      // the controller's accessor.
      const behaviour = d.aiController.getBehaviour(rec.id);
      const isHostile = (playerId: string): boolean => {
        if (!behaviour) return false;
        const ho = (behaviour as unknown as { hostileTo?: Set<string> }).hostileTo;
        return ho ? ho.has(playerId) : false;
      };

      // Capitals: every turret picks its own target (review round 2026-11-07).
      if (hasTurretFireControl(kind) && d.fireDroneMount !== undefined && d.currentTick !== undefined) {
        this.tickCapitalMounts(rec.id, kind, mounts, b, droneX, droneY, droneAngle, targets, isHostile);
        continue;
      }

      const prevTargetId = this.droneSlotTargets.get(rec.id) ?? null;
      const target = pickTarget(droneX, droneY, targets, prevTargetId, isHostile, {
        maxDistance: mountTargetReach(kind, mounts),
      });
      this.droneSlotTargets.set(rec.id, target?.id ?? null);

      let angles = this.droneMountAngles.get(rec.id);
      if (!angles || angles.length !== mounts.length) {
        angles = new Float32Array(mounts.length);
        this.droneMountAngles.set(rec.id, angles);
      }

      if (target === null) {
        for (let i = 0; i < mounts.length; i++) {
          angles[i] = rotateMountToward(angles[i]!, 0, mounts[i]!, DT_SEC);
        }
        continue;
      }

      const cosA = Math.cos(droneAngle);
      const sinA = Math.sin(droneAngle);
      for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i]!;
        const mountWorldX = droneX + (mount.localX * cosA - mount.localY * sinA);
        const mountWorldY = droneY + (mount.localX * sinA + mount.localY * cosA);
        const dx = target.x - mountWorldX;
        const dy = target.y - mountWorldY;
        const worldBearing = Math.atan2(-dx, dy);
        const mountLocalBearing = wrapPi(worldBearing - droneAngle - mount.baseAngle);
        angles[i] = rotateMountToward(angles[i]!, mountLocalBearing, mount, DT_SEC);
      }
    }
  }

  /** Can this capital mount engage target t right now? Hostile, in reach, in
   *  arc, a clear line of fire and slow enough across its sights to track. */
  private canEngage(
    kind: ShipKind, mount: WeaponMount, t: MountTargetView, mx: number, my: number, ang: number,
    reach: number, selfVx: number, selfVy: number, isHostile: (id: string) => boolean,
  ): boolean {
    if (!isHostile(t.id)) return false;
    const dx = t.x - mx, dy = t.y - my;
    // Reach, arc and tracking: the shared fire control (structures use it too).
    if (!mountCanEngage(mount, ang, dx, dy, reach, t.vx - selfVx, t.vy - selfVy)) return false;
    return mountLineClear(kind, mount, wrapPi(Math.atan2(-dx, dy) - ang));
  }

  /**
   * Capital turret fire control (review round 2026-11-07). Every mount picks
   * its OWN target: the hostile its size prefers most (mains: capitals;
   * secondaries: sub-capitals and small capitals; AA: small craft), among
   * those within its gun's reach, inside its arc, on a line of fire that
   * leaves the hull outwards, and slow enough across its sights to track. It leads that target with its own shell speed, and fires
   * on its own reload when on target. Sticky: a mount keeps its target while
   * it stays valid. Alloc-free after the first tick per drone (#14).
   */
  private tickCapitalMounts(
    droneId: string, kind: ShipKind, mounts: ReadonlyArray<WeaponMount>, b: number,
    x: number, y: number, ang: number, targets: MountTargetView[], isHostile: (id: string) => boolean,
  ): void {
    const d = this.deps;
    const n = mounts.length;
    let angles = this.droneMountAngles.get(droneId);
    if (!angles || angles.length !== n) { angles = new Float32Array(n); this.droneMountAngles.set(droneId, angles); }
    let per = this.droneMountTargetIds.get(droneId);
    if (!per || per.length !== n) { per = new Array<string | null>(n).fill(null); this.droneMountTargetIds.set(droneId, per); }
    let reload = this.droneMountReload.get(droneId);
    if (!reload || reload.length !== n) { reload = new Int32Array(n).fill(-1_000_000); this.droneMountReload.set(droneId, reload); }
    let lastOk = this.droneMountLastOk.get(droneId);
    if (!lastOk || lastOk.length !== n) { lastOk = new Int32Array(n); this.droneMountLastOk.set(droneId, lastOk); }
    const tick = d.currentTick!();
    const selfVx = d.sabF32[b + SLOT_VX_OFF]!, selfVy = d.sabF32[b + SLOT_VY_OFF]!;
    const cosA = Math.cos(ang), sinA = Math.sin(ang);
    const kinds = this.droneTargetKinds;
    for (let i = 0; i < n; i++) {
      const mount = mounts[i]!;
      const mx = x + (mount.localX * cosA - mount.localY * sinA);
      const my = y + (mount.localX * sinA + mount.localY * cosA);
      const reach = mountWeaponReach(mount);
      // STICKY (user, 2026-11-07: "don't constantly retarget"): a turret
      // re-checks only its own target each tick. If that target briefly can't
      // be engaged it keeps aiming at it for TARGET_HOLD_TICKS before letting
      // go, and it searches for a new one only when it has none, every
      // RETARGET_TICKS, staggered across mounts. Cheap and steady.
      let best = -1;
      let engageable = false;
      const prev = per[i];
      if (prev !== null) {
        for (let j = 0; j < targets.length; j++) if (targets[j]!.id === prev) { best = j; break; }
        if (best >= 0) engageable = this.canEngage(kind, mount, targets[best]!, mx, my, ang, reach, selfVx, selfVy, isHostile);
        if (engageable) lastOk[i] = tick;
        else if (best < 0 || tick - lastOk[i]! > TARGET_HOLD_TICKS) { best = -1; per[i] = null; }
      }
      if (best < 0 && (tick + i * 7) % RETARGET_TICKS === 0) {
        // Search: lowest (priority, distance) among targets it can engage.
        let bestPri = Infinity, bestD2 = Infinity;
        for (let j = 0; j < targets.length; j++) {
          const t = targets[j]!;
          if (!this.canEngage(kind, mount, t, mx, my, ang, reach, selfVx, selfVy, isHostile)) continue;
          const dx = t.x - mx, dy = t.y - my;
          const d2 = dx * dx + dy * dy;
          const pri = mountPriority(mount.size, targetClass(getShipKind(kinds[j] ?? DEFAULT_SHIP_KIND)));
          if (pri < bestPri || (pri === bestPri && d2 < bestD2)) { bestPri = pri; bestD2 = d2; best = j; }
        }
        if (best >= 0) { engageable = true; lastOk[i] = tick; }
      }
      if (best < 0) {
        per[i] = null;
        angles[i] = rotateMountToward(angles[i]!, 0, mount, DT_SEC);
        continue;
      }
      const t = targets[best]!;
      per[i] = t.id;
      // First-order intercept with this gun's shell speed (shells inherit the
      // hull's velocity, so lead on the RELATIVE velocity).
      const w = getWeapon(mount.weaponId);
      const dx = t.x - mx, dy = t.y - my;
      const dist = Math.hypot(dx, dy);
      const want = leadArcBearing(dx, dy, t.vx - selfVx, t.vy - selfVy, w.mode === 'hitscan' ? 0 : w.speed, ang, mount.baseAngle);
      angles[i] = rotateMountToward(angles[i]!, want, mount, DT_SEC);
      if (!engageable) continue; // held through a brief loss: aim, don't fire
      if (tick - reload[i]! < w.cooldownTicks) continue;
      // On target = the shot would pass within TURRET_FIRE_MISS of the aim
      // point (an angle alone is a 250 u miss at 5,000 u).
      if (!onTarget(want, angles[i]!, dist)) continue;
      if (!mountLineClear(kind, mount, mount.baseAngle + angles[i]!)) continue;
      reload[i] = tick;
      d.fireDroneMount!(droneId, i);
    }
  }

  /** Cleanup hook: drop all per-player state on leave/transit/death. */
  clearPlayer(playerId: string): void {
    this.playerMountAngles.delete(playerId);
    this.playerSlotTargets.delete(playerId);

    this.deps.onClearPlayer?.(playerId);
  }

  /** Cleanup hook: drop all per-drone state on eviction/destroy/shed. */
  clearDrone(droneId: string): void {
    this.droneMountAngles.delete(droneId);
    this.droneSlotTargets.delete(droneId);
    this.droneMountReload.delete(droneId);
    this.droneMountTargetIds.delete(droneId);
    this.droneMountLastOk.delete(droneId);
  }
}
