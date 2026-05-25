/**
 * Weapon-mount aiming state for SectorRoom.
 *
 * Step 9 of the hazy-pillow decomposition plan — relocates the 6 mount-
 * angle / sticky-target / target-scratch maps onto a focused owner.
 *
 * Plan invariant #12 (root CLAUDE.md): mount-angle state has exactly
 * one ownership site, and `WeaponMountController.tickSlot` is the only
 * path that may write per-mount rotation angles. After this commit the
 * STORAGE has one owner (MountAimSubsystem); the WRITERS (`tickPlayerMounts`
 * / `tickDroneMounts` in SectorRoom + `tickLocalMountAim` on the client)
 * still call into `pickTarget` + `rotateMountToward` per the contract.
 *
 * Method bodies (`tickPlayerMounts`, `tickDroneMounts`) remain in
 * SectorRoom for now because they consume `shipPoseCache` (still on
 * SectorRoom), `state.ships`, and the swarm registry. They'll migrate
 * here once those collaborators have stable interfaces.
 *
 * Plan invariant note: `tickPlayerMounts` runs in the `playerMounts`
 * phase AFTER `snapshotBroadcast`, so this tick's snapshot ships last
 * tick's angles by design. The migrated tick methods must preserve
 * that ordering — see Trap 5 of the revised plan.
 */

import type { MountTargetView } from '../../core/ai/WeaponMountController.js';

export class MountAimSubsystem {
  /** Authoritative per-mount rotation angle for active player ships.
   *  Keyed by playerId; value is a Float32Array indexed by mount
   *  catalogue order. */
  readonly playerMountAngles = new Map<string, Float32Array>();
  /** Sticky target id per player slot (suppresses oscillation in
   *  `pickTarget`). Cleared on `onLeave` and on death. */
  readonly playerSlotTargets = new Map<string, string | null>();
  /** Reused per-tick drone-candidate list for player turret target
   *  picks — long-lived to avoid per-tick allocation. */
  readonly mountTargetsScratch: MountTargetView[] = [];

  /** Per-drone authoritative mount rotation angles. Keyed by drone id
   *  (`swarm-*`). Only drones whose ship-kind has rotating mounts get
   *  an entry. */
  readonly droneMountAngles = new Map<string, Float32Array>();
  /** Sticky target id per drone slot. */
  readonly droneSlotTargets = new Map<string, string | null>();
  /** Reused per-tick player-candidate list for drone turret picks. */
  readonly droneMountTargetsScratch: MountTargetView[] = [];

  /** Clear all mount-aim state for a player (called on onLeave / death
   *  / transit cleanup). */
  clearForPlayer(playerId: string): void {
    this.playerMountAngles.delete(playerId);
    this.playerSlotTargets.delete(playerId);
  }

  /** Clear all mount-aim state for a drone (called from evictSwarmEntity). */
  clearForDrone(droneId: string): void {
    this.droneMountAngles.delete(droneId);
    this.droneSlotTargets.delete(droneId);
  }
}
