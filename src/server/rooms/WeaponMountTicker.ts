/**
 * Per-tick weapon-mount aim updater.
 *
 * Owns the per-mount target-pick + slew state for every ship + drone:
 *   - `playerMountAngles` / `droneMountAngles` — Float32Array of slewed
 *     arc-local angles, indexed by mount-catalogue order.
 *   - `playerSlotTargets` / `droneSlotTargets` — sticky pickTarget
 *     prevTargetId hysteresis (10 % distance via STICKY_HYSTERESIS_FACTOR).
 *   - `mountTargetsScratch` + `droneMountTargetsScratch` — pooled
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
  PLAYER_AIM_HEALTH_WEIGHT,
  PLAYER_AIM_SWITCH_MARGIN,
  type MountTargetView,
} from '../../core/ai/WeaponMountController.js';
import { HITSCAN_RANGE } from '../../core/combat/Weapons.js';
import { getDroneMaxHealth } from './droneKindHelpers.js';
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
}

const DT_SEC = 1 / 60;

export class WeaponMountTicker {
  /** Per-mount slewed arc-local angles, keyed by playerId. */
  readonly playerMountAngles = new Map<string, Float32Array>();
  /** Per-drone equivalent. Allocated lazily — drones with all-static
   *  mounts (legacy fighter/scout/heavy) never get an entry. */
  readonly droneMountAngles = new Map<string, Float32Array>();
  /** Sticky targetId per shooter (for pickTarget hysteresis). */
  readonly playerSlotTargets = new Map<string, string | null>();
  readonly droneSlotTargets = new Map<string, string | null>();

  /** Pooled per-tick target lists — drone candidates (rebuilt by tickPlayer).
   *  Logical-length-over-physical-slot pattern (plan: quirky-rabbit,
   *  Phase 5): pre-fix `targets.push({ id, x, y, vx, vy })` minted a
   *  fresh 5-field literal per swarm entity per tick. Now we reuse the
   *  array's slot instances and `targets.length = i` to truncate
   *  logically. Safe per WeaponMountController.pickTarget — it returns
   *  the MountTargetView reference but the caller (tickPlayer below)
   *  only reads `target?.id` (a string), never retaining the view past
   *  the tick. */
  private readonly mountTargetsScratch: MountTargetView[] = [];
  /** Pooled per-tick player candidates (rebuilt by tickDrone). Same
   *  logical-length pattern as `mountTargetsScratch`. */
  private readonly droneMountTargetsScratch: MountTargetView[] = [];
  /** WS-B3 — reused per-player firing-mount-id set (alloc-free, invariant #14).
   *  Rebuilt per player in `tickPlayer` from `resolveInstanceFireMounts`. */
  private readonly _firingIdsScratch = new Set<string>();

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
   * Drone candidate list is rebuilt once and shared across all players.
   * No-op when no players are bound to slots.
   */
  tickPlayer(): void {
    const d = this.deps;
    if (d.playerToSlot.size === 0) return;

    // Build the drone candidate list once per tick — same list re-used
    // for every player's pickTarget call. Logical-length over physical
    // slot: reuse view instances across ticks (Phase 5 — invariant #14).
    const targets = this.mountTargetsScratch;
    const swarmHealth = d.swarmHealth();
    let count = 0;
    for (const rec of d.swarmRegistry.all()) {
      if (rec.kind !== 1) continue;
      const b = slotBase(rec.slot);
      // Part C — carry drone health so the player turret can focus the wounded.
      // Per-drone (shared across players); hostility is per-player (callback
      // below). maxHealth from the kind; undefined when unknown ⇒ distance-only.
      const maxHp = getDroneMaxHealth(rec.shipKind) ?? undefined;
      const curHp = maxHp !== undefined ? swarmHealth.get(rec.id) : undefined;
      WeaponMountTicker.writeTargetSlot(
        targets, count, rec.id,
        d.sabF32[b + SLOT_X_OFF]!,
        d.sabF32[b + SLOT_Y_OFF]!,
        d.sabF32[b + SLOT_VX_OFF]!,
        d.sabF32[b + SLOT_VY_OFF]!,
        curHp, maxHp,
      );
      count++;
    }
    targets.length = count;

    for (const [playerId] of d.playerToSlot) {
      const ship = d.getActiveShip(playerId);
      if (!ship?.alive) continue;
      const pose = d.shipPoseCache.get(playerId);
      if (!pose) continue;
      // WS-B3 — the angle index space is the FULL per-instance list
      // `[...kind.mounts, ...activated]`; only the FIRING subset (active slot +
      // activated) aims, the rest slew to base. For un-upgraded single-slot
      // ships `mounts` == the active slot == the catalogue order, so this is
      // byte-identical to the pre-WS-B3 active-slot-only loop.
      const mounts = d.resolveInstanceMounts(ship);
      if (mounts.length === 0) continue;
      // Firing-set ids — only these track the target. Reused scratch set.
      const firingIds = this._firingIdsScratch;
      firingIds.clear();
      for (const m of d.resolveInstanceFireMounts(ship)) firingIds.add(m.id);

      const prevTargetId = this.playerSlotTargets.get(playerId) ?? null;
      // Part C — hostile-only (per-player ledger), health-weighted, commitment-
      // sticky aim. Identical options to the client's `tickLocalMountAim` so the
      // predicted beam and this authoritative mount angle agree (lockstep).
      const target = pickTarget(
        pose.x, pose.y, targets, prevTargetId,
        (id) => {
          // Same hostility source as HostileDroneBehaviour / tickDrone: the
          // drone's `hostileTo` set. Mirrors the client's `isHostileToLocal`
          // (kept in sync via the damage/bot_aggro markHostile mirror), so the
          // server + client picks agree.
          const b = d.aiController.getBehaviour(id);
          if (!b) return false;
          const ho = (b as { hostileTo?: Set<string> }).hostileTo;
          return ho ? ho.has(playerId) : false;
        },
        {
          maxDistance: HITSCAN_RANGE,
          healthWeight: PLAYER_AIM_HEALTH_WEIGHT,
          switchMargin: PLAYER_AIM_SWITCH_MARGIN,
        },
      );
      this.playerSlotTargets.set(playerId, target?.id ?? null);

      let angles = this.playerMountAngles.get(playerId);
      if (!angles || angles.length !== mounts.length) {
        angles = new Float32Array(mounts.length);
        this.playerMountAngles.set(playerId, angles);
      }

      if (target === null) {
        // No target in range — slew every mount back to forward (0 in
        // arc-local frame). Matches user-requested behaviour: "return
        // the weapons to aiming forwards when an enemy ship is out of
        // range".
        for (let i = 0; i < mounts.length; i++) {
          angles[i] = rotateMountToward(angles[i]!, 0, mounts[i]!, DT_SEC);
        }
        continue;
      }

      const cosA = Math.cos(pose.angle);
      const sinA = Math.sin(pose.angle);
      for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i]!;
        // Non-firing instance mounts (e.g. a future inactive slot's mounts)
        // slew back to base — only the firing set tracks the target.
        if (!firingIds.has(mount.id)) {
          angles[i] = rotateMountToward(angles[i]!, 0, mount, DT_SEC);
          continue;
        }
        const mountWorldX = pose.x + (mount.localX * cosA - mount.localY * sinA);
        const mountWorldY = pose.y + (mount.localX * sinA + mount.localY * cosA);
        const dx = target.x - mountWorldX;
        const dy = target.y - mountWorldY;
        const worldBearing = Math.atan2(-dx, dy);
        const mountLocalBearing = wrapPi(worldBearing - pose.angle - mount.baseAngle);
        angles[i] = rotateMountToward(angles[i]!, mountLocalBearing, mount, DT_SEC);
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

      const prevTargetId = this.droneSlotTargets.get(rec.id) ?? null;
      const target = pickTarget(droneX, droneY, targets, prevTargetId, isHostile, {
        maxDistance: HITSCAN_RANGE,
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

  /** Cleanup hook: drop all per-player state on leave/transit/death. */
  clearPlayer(playerId: string): void {
    this.playerMountAngles.delete(playerId);
    this.playerSlotTargets.delete(playerId);
  }

  /** Cleanup hook: drop all per-drone state on eviction/destroy/shed. */
  clearDrone(droneId: string): void {
    this.droneMountAngles.delete(droneId);
    this.droneSlotTargets.delete(droneId);
  }
}
