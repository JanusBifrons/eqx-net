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
 *     The SAME step anchors the other remote moving entities, drones
 *     and scrap (`anchorRemoteSwarmBodies`), from their latest
 *     authoritative binary-wire state. One paradigm for every remote
 *     moving entity: predWorld collision runs on the predicted timeline
 *     from the latest server state; rendering is per entity type
 *     (remote ships: predWorld + decaying lerp offset; drones/scrap:
 *     the display-delayed interpolated pose). See
 *     docs/architecture/drone-snapshot-interpolation.md.
 *
 *   - `applyDroneMountAngles` pushes the slim drone snapshot slice
 *     (`{ id, mountAngles?, shieldDown? }`) into mirror.swarm —
 *     drones are pure binary-wire-interpolated; the JSON snapshot
 *     only carries the per-tick turret + shield state.
 */

import type { SnapshotMessage } from '@shared-types/messages';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '@core/contracts/IRenderer';
import type { PhysicsWorld, ShipPhysicsState } from '@core/physics/World';
import { SWARM_KIND_DRONE, SWARM_KIND_SCRAP, SWARM_KIND_WRECK } from '@shared-types/swarmWireFormat';

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
  /** `swarm-${id}` body keys (`ColyseusClient._swarmBodyKeyCache`). With the
   *  scratch below, turns on the drone/scrap half of the anchor. */
  swarmBodyKeys?: ReadonlyMap<number, string>;
  /** Reused state object for the drone/scrap anchor (#14). */
  swarmAnchorScratch?: ShipPhysicsState;
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
  // The same anchor for the other remote MOVING entities (drones, scrap):
  // latest authoritative state at this snapshot's serverTick. The replay and
  // every tickPhysics step then carry them on the prediction timeline exactly
  // like the remote ships above.
  if (ctx.predWorld && ctx.mirror.swarm && ctx.swarmBodyKeys && ctx.swarmAnchorScratch) {
    anchorRemoteSwarmBodies(ctx.predWorld, ctx.mirror.swarm, snap.serverTick, ctx.swarmBodyKeys, ctx.swarmAnchorScratch);
  }
  return preReset;
}

/** True for the swarm kinds that MOVE and get a dynamic predWorld body that
 *  follows the remote-entity anchor: drones (1), scrap (3) and capital wreck
 *  pieces (4, S2b). Asteroids (0)
 *  and structures (2) keep their own static/locked handling. */
export function isRemoteMovingSwarmKind(kind: number): boolean {
  return kind === SWARM_KIND_DRONE || kind === SWARM_KIND_SCRAP || kind === SWARM_KIND_WRECK;
}

/**
 * Fill `out` with the entity's AUTHORITATIVE server state at `tick`, read off
 * the decoder-fed pose ring (never the interpolated, display-delayed
 * `entry.x/y`, which `updateMirror` overwrites every frame). The binary swarm
 * wire and the JSON snapshot run on the same server tick counter but at
 * different cadences, so the ring may not hold `tick` exactly: then the newest
 * pose at or before `tick` (else the oldest after it) is carried to `tick` with
 * its own velocity, over at most `MAX_ALIGN_TICKS`. Returns false when the ring
 * is empty. Allocation-free.
 */
export function authoritativeSwarmStateAt(entry: SwarmRenderState, tick: number, out: ShipPhysicsState): boolean {
  const ring = entry.poseRing;
  let best: PoseRingEntry | null = null;
  let after: PoseRingEntry | null = null;
  for (let i = 0; i < ring.length; i++) {
    const s = ring[i]!;
    if (s.empty) continue;
    if (s.serverTick <= tick) {
      if (best === null || s.serverTick > best.serverTick) best = s;
    } else if (after === null || s.serverTick < after.serverTick) {
      after = s;
    }
  }
  const src = best ?? after;
  if (src === null) return false;
  let dTicks = tick - src.serverTick;
  if (dTicks > MAX_ALIGN_TICKS) dTicks = MAX_ALIGN_TICKS;
  else if (dTicks < -MAX_ALIGN_TICKS) dTicks = -MAX_ALIGN_TICKS;
  const dt = dTicks / 60;
  out.x = src.x + src.vx * dt;
  out.y = src.y + src.vy * dt;
  out.vx = src.vx;
  out.vy = src.vy;
  out.angle = src.angle + src.angvel * dt;
  out.angvel = src.angvel;
  return true;
}

/** Cap on how far `authoritativeSwarmStateAt` carries a pose to the anchor
 *  tick (the out-of-interest wire cadence is every 6 ticks). */
const MAX_ALIGN_TICKS = 12;

/**
 * Anchor every remote drone/scrap predWorld body to its latest authoritative
 * server state at `anchorTick` — the same reset `preResetRemoteShips` does for
 * remote player ships, and part of that one step. After it the reconciler
 * replay and the per-tick `tickPhysics` steps move the bodies forward on the
 * local prediction's timeline; nothing re-poses them per frame, so the local
 * ship's own push on a drone or scrap survives until the next snapshot (as the
 * server keeps it). Drawing is separate: sprites still read the interpolated
 * pose (`updateMirror`). `keyCache` is `ColyseusClient._swarmBodyKeyCache`;
 * an entity with no cached key has no body yet. Allocation-free (#14).
 */
export function anchorRemoteSwarmBodies(
  predWorld: PhysicsWorld,
  swarm: ReadonlyMap<number, SwarmRenderState>,
  anchorTick: number,
  keyCache: ReadonlyMap<number, string>,
  scratch: ShipPhysicsState,
): void {
  for (const [entityId, entry] of swarm) {
    if (!isRemoteMovingSwarmKind(entry.kind)) continue;
    const key = keyCache.get(entityId);
    if (key === undefined || !predWorld.hasShip(key)) continue;
    if (!authoritativeSwarmStateAt(entry, anchorTick, scratch)) continue;
    // A body the server reports asleep stays asleep here too (#15: the client
    // twin matches the server body). Waking every piece on every snapshot made
    // each one an awake body in every replayed and predicted step: the soak's
    // client CPU profile at ~500 wreck pieces spent 56 % of the main thread in
    // Rapier's step (capital-destruction.md "Client cost per wreck piece").
    // The local ship touching it still wakes it (Rapier wakes on contact).
    if (entry.sleeping) predWorld.setShipStateAsleep(key, scratch);
    else predWorld.setShipState(key, scratch);
  }
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
/** Entity ids marked `charging` by the previous snapshot (reused — #14). */
const chargingIds = new Set<number>();
/** Entity ids named as elites by the previous snapshot (reused — #14). */
const eliteIds = new Set<number>();
/** Entity ids warping per the previous snapshot (reused — #14). */
const warpIds = new Set<number>();

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
  // P3c — the charge telegraph: the server omits a drone with nothing to
  // report, so last snapshot's chargers are cleared first and re-marked below.
  if (chargingIds.size > 0) {
    for (const id of chargingIds) {
      const sw = mirror.swarm?.get(id);
      if (sw) sw.charging = false;
    }
    chargingIds.clear();
  }
  // P4a — elite names clear on absence the same way (an elite always reports
  // while in interest, so absence = gone / out of interest).
  if (eliteIds.size > 0) {
    for (const id of eliteIds) {
      const sw = mirror.swarm?.get(id);
      if (sw) sw.eliteName = undefined;
    }
    eliteIds.clear();
  }
  // W2a — an NPC warp phase clears on absence (the server omits idle drones).
  if (warpIds.size > 0) {
    for (const id of warpIds) {
      const sw = mirror.swarm?.get(id);
      if (sw) sw.warp = undefined;
    }
    warpIds.clear();
  }
  if (!snap.drones || snap.drones.length === 0) return;
  for (const d of snap.drones) {
    if (d.hostile === true && onHostile) onHostile(d.id);
    const sw = mirror.swarm?.get(d.id);
    if (!sw) continue;
    if (d.charging === true) {
      sw.charging = true;
      chargingIds.add(d.id);
    }
    if (d.elite !== undefined) {
      sw.eliteName = d.elite;
      eliteIds.add(d.id);
    }
    if (d.warp !== undefined) {
      sw.warp = d.warp;
      warpIds.add(d.id);
    }
    // v4 M2 — a patrol ship's faction never changes, so it is kept once seen.
    if (d.fac !== undefined) sw.faction = d.fac;
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
 * Phase 4 warp-to (#16): mirror each ship's PUBLIC warp phase (`states[].warp`:
 * 1 spool, 2 run; absent = idle) onto its render entry. Writes only on change.
 * The local ship's entry is overwritten each frame by its predicted phase.
 */
export function applyShipWarp(snap: SnapshotMessage, mirror: RenderMirror): void {
  for (const id in snap.states) {
    const ship = mirror.ships.get(id);
    if (!ship) continue;
    const w = snap.states[id]!.warp;
    if (ship.warp !== w) ship.warp = w;
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
