/**
 * Per-snapshot remote-ship sync — the chunk of `handleSnapshot` that
 * runs AFTER stats/RTT/lookahead and BEFORE `reconciler.reconcile`.
 *
 *   - `preResetRemoteShips` snapshots each remote's current
 *     predWorld pose into the preReset map, then setShipState's the
 *     remote to its authoritative snapshot pose. The preReset map is
 *     consumed by the post-reconcile lerp-offset computation. Also
 *     stashes the remote's `lastInput` for Stage 3 forward-prediction
 *     during the upcoming replay + the next tickPhysics window, and
 *     mirrors the server's per-mount angles into mirror.ships so the
 *     remote-turret rendering follows the server.
 *
 *   - `applyDroneMountAngles` pushes the slim drone snapshot slice
 *     (`{ id, mountAngles?, shieldDown? }`) into mirror.swarm —
 *     drones are pure binary-wire-interpolated; the JSON snapshot
 *     only carries the per-tick turret + shield state.
 */

import type { SnapshotMessage } from '@shared-types/messages';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { PhysicsWorld } from '@core/physics/World';

type RemoteInput = {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
  reverse: boolean;
};

export interface PreResetEntry {
  x: number;
  y: number;
}

export interface PreResetRemoteCtx {
  predWorld: PhysicsWorld | null;
  mirror: RenderMirror;
  /** Persistent Map + pooled {x,y} entries — peak == remote-ship count. */
  preResetRemotePosScratch: Map<string, PreResetEntry>;
  preResetRemotePosEntries: PreResetEntry[];
  remoteLastInputs: Map<string, RemoteInput>;
  remoteForwardTicks: Map<string, number>;
}

/**
 * Reset every remote ship to its serverTick state BEFORE reconcile,
 * stashing the pre-reset pose so we can compute lerp offsets after.
 * Returns the preReset map (which is the same Map as
 * `ctx.preResetRemotePosScratch`, but typed here for clarity).
 */
export function preResetRemoteShips(
  snap: SnapshotMessage,
  localId: string,
  ctx: PreResetRemoteCtx,
): Map<string, PreResetEntry> {
  const preReset = ctx.preResetRemotePosScratch;
  preReset.clear();
  const preResetEntries = ctx.preResetRemotePosEntries;
  let preResetEntryIdx = 0;
  // step 4: for…in (no tuple-array alloc).
  for (const remoteId in snap.states) {
    if (remoteId === localId) continue;
    if (!ctx.predWorld?.hasShip(remoteId)) continue;
    const state = snap.states[remoteId]!;
    const current = ctx.predWorld.getShipState(remoteId);
    if (current) {
      let entry = preResetEntries[preResetEntryIdx];
      if (!entry) {
        entry = { x: 0, y: 0 };
        preResetEntries[preResetEntryIdx] = entry;
      }
      entry.x = current.x;
      entry.y = current.y;
      preReset.set(remoteId, entry);
      preResetEntryIdx++;
    }
    ctx.predWorld.setShipState(remoteId, state);
    // Stage 3 — capture each remote's last-applied input from the
    // snapshot for forward-prediction during the upcoming replay
    // and the next tickPhysics window.
    if (state.lastInput) {
      ctx.remoteLastInputs.set(remoteId, { ...state.lastInput });
    } else {
      ctx.remoteLastInputs.delete(remoteId);
    }
    // Reset the lookahead-cap counter for this remote — the upcoming
    // replay starts a fresh forward-prediction window from serverTick.
    ctx.remoteForwardTicks.set(remoteId, 0);
    // Phase 4b.3 — push the server's authoritative mount angles into
    // the mirror so the renderer paints the remote ship's turrets at
    // the same rotation the server is computing. Local player is
    // skipped here — `tickLocalMountAim` runs the prediction each
    // tick and the per-frame `updateMirror` rebuild already
    // preserves the predicted angles.
    const mirrorShip = ctx.mirror.ships.get(remoteId);
    if (mirrorShip) {
      if (state.mountAngles && state.mountAngles.length > 0) {
        mirrorShip.mountAngles = state.mountAngles.slice();
      } else if (mirrorShip.mountAngles) {
        mirrorShip.mountAngles = undefined;
      }
    }
  }
  // Drop entries for remotes that are no longer in the snapshot.
  for (const tracked of [...ctx.remoteLastInputs.keys()]) {
    if (!(tracked in snap.states)) {
      ctx.remoteLastInputs.delete(tracked);
      ctx.remoteForwardTicks.delete(tracked);
    }
  }
  return preReset;
}

/**
 * Drone snapshot slice (drone-snapshot-interpolation pivot, 2026-05-18).
 * Drones are PURE snapshot-interpolated from the binary swarm wire — NO
 * client AI re-sim, NO predWorld reconcile anchor, NO relevance cull.
 * `snap.drones[]` is a slim turret/shield slice; the pose flows on the
 * binary channel and renders via `interpolateSwarmPose`.
 *
 * Out-of-interest drones never appear here, so their mountAngles stays
 * undefined (renderer falls back to baseAngle) — unchanged.
 */
export function applyDroneMountAngles(
  snap: SnapshotMessage,
  mirror: RenderMirror,
  // Campaign 2.1 (invariant #16) — invoked for every drone whose slice entry
  // carries `hostile: true` (hostile TO THE RECIPIENT). The caller feeds the
  // client hostility ledger so a mid-wave joiner / dropped `bot_aggro`
  // converges from the snapshot stream alone. Absence of the flag does NOT
  // clear — the ledger's time-decay owns forgetting (same as the event path).
  onHostile?: (entityId: number) => void,
): void {
  if (!snap.drones || snap.drones.length === 0) return;
  for (const d of snap.drones) {
    if (d.hostile === true && onHostile) onHostile(d.id);
    const sw = mirror.swarm?.get(d.id);
    if (!sw) continue;
    if (d.mountAngles && d.mountAngles.length > 0) {
      sw.mountAngles = d.mountAngles.slice();
    } else if (sw.mountAngles) {
      sw.mountAngles = undefined;
    }
    if (d.shieldDown !== undefined) sw.shieldDown = d.shieldDown;
    // Part C — decode the hull-health percent for health-weighted player aim.
    // The server omits `hp` for full-HP drones, so absent ⇒ full (1).
    sw.healthFrac = d.hp !== undefined ? d.hp / 100 : 1;
  }
}

/**
 * Asteroid resource slice (WS-4 Phase 6 / R2.23 enabler). Mirrors the slim
 * `snap.asteroids[]` slice (in-interest MINED rocks only) into the swarm mirror
 * by entityId, so the WS-9 inspector can read a rock's remaining-fraction. Pose
 * stays on the binary channel; this is a slim non-pose field like the drone
 * `hp`. The server emits an entry ONLY while a rock is mined, so an entry's
 * presence IS the "has been mined" signal — there is no full-pool reset to
 * absent (a fully-mined-then-untouched rock keeps its last shipped values until
 * it leaves interest). Absent slice ⇒ no-op.
 */
export function applyAsteroidResources(snap: SnapshotMessage, mirror: RenderMirror): void {
  if (!snap.asteroids || snap.asteroids.length === 0) return;
  for (const a of snap.asteroids) {
    const sw = mirror.swarm?.get(a.id);
    if (!sw) continue;
    if (a.resources !== undefined) sw.resources = a.resources;
    if (a.resourcesMax !== undefined) sw.resourcesMax = a.resourcesMax;
  }
}

/**
 * Public ship-level slice (Phase 4 WS-B1, plan: effervescent-umbrella). The
 * snapshot `states[id].level` carries each hull's PUBLIC level (emit-when > 1,
 * D13). Mirror it onto EVERY ship render entry (local + remote) so the renderer
 * paints the in-world level badge; absent ⇒ level 1 (un-levelled), so we clear
 * a stale value back to undefined. Discrete scalar — purity-clean (Invariant
 * #2). Keyed by the wire's snapshot key (shipInstanceId), which is the
 * `mirror.ships` key (mirrors how `mountAngles` is applied). Alloc-free: a
 * scalar write per ship, no per-frame literal. The single ownership site for
 * the public level mirror field.
 */
export function applyShipLevels(snap: SnapshotMessage, mirror: RenderMirror): void {
  for (const id in snap.states) {
    const ship = mirror.ships.get(id);
    if (!ship) continue;
    const level = snap.states[id]!.level;
    // Only write when it differs to avoid churning the mirror object's hidden
    // class; absent ⇒ level 1 ⇒ clear the badge.
    if (level !== undefined && level > 1) {
      if (ship.level !== level) ship.level = level;
    } else if (ship.level !== undefined) {
      ship.level = undefined;
    }
  }
}

/**
 * Public activated-mount slice (Phase 4 WS-B3, plan: effervescent-umbrella). The
 * snapshot `states[id].mounts` carries each hull's PUBLIC activated latent mounts
 * (emit-when-non-empty). Mirror it onto EVERY ship render entry (local + remote)
 * so the renderer draws the extra turrets; absent / empty ⇒ no activated mounts,
 * so we clear a stale value back to undefined. The renderer reads geometry by
 * `(kind, slotId)` from the catalogue (never on the wire). Keyed by the
 * playerId-translated `snap.states` key (matching `mirror.ships`, run AFTER
 * `routeSnapshotShipStates`). The single ownership site for the activated-mount
 * mirror field — non-spatial discrete data, purity-clean (Invariant #2). Alloc:
 * one `.slice()` ONLY when the list changes (a discrete activation), never per
 * tick for an un-upgraded ship.
 */
export function applyActivatedMounts(snap: SnapshotMessage, mirror: RenderMirror): void {
  for (const id in snap.states) {
    const ship = mirror.ships.get(id);
    if (!ship) continue;
    // Truthy (NOT `!== undefined`): the server sets `entry.mounts = undefined`
    // on its pooled snapshot entry for an un-upgraded ship, and notepack encodes
    // that `undefined` VALUE as nil → the client decodes it as `null` (not
    // undefined). A `!== undefined` guard let `null` through and crashed on
    // `null.length`, breaking the whole inbound snapshot loop (capture
    // 2026-06-21T09-10-53Z-ypqf1a). Match the null-safe sibling readers
    // (`applyDroneMountAngles`, `preResetRemoteShips`).
    // Truthy (NOT `!== undefined`): the client decodes this hull's wire `mounts`
    // as `null` for an un-upgraded ship in some live-sector states (capture
    // 2026-06-21T09-10-53Z-ypqf1a). A `!== undefined` guard let `null` through
    // and crashed on `null.length`, breaking the whole inbound snapshot loop.
    // Match the null-safe sibling readers (`applyDroneMountAngles`,
    // `preResetRemoteShips`). The unit lock for this is in
    // `snapshotRemoteSync.activatedMounts.test.ts`.
    const mounts = snap.states[id]!.mounts;
    if (mounts && mounts.length > 0) {
      // Copy the slim id/weapon pairs (the slice is small + only on a change).
      ship.activatedMounts = mounts.map((m) => ({ slotId: m.slotId, weaponId: m.weaponId }));
    } else if (ship.activatedMounts !== undefined) {
      ship.activatedMounts = undefined;
    }
  }
}
