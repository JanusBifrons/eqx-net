/**
 * Snapshot ship-states routing (RTS Part A S3: ONE ship list). Re-keys the
 * incoming `snap.states` (shipInstanceId-keyed on the wire) to the mirror's
 * keys: an active ship (and the own welcome ship while pending-join) under
 * its pilot's playerId, every parked / AI-flown hull under its
 * shipInstanceId. Both kinds then go through the SAME downstream paths
 * (`preResetRemoteShips`, `applyShipLevels`, `applyActivatedMounts`, the
 * remote-ship body path). The key rule is `shipMirrorKey`, shared with
 * `syncMirror`.
 *
 * Parked hulls' mirror entries are created here (pose seed, owner,
 * `isActive=false`); identity (kind, displayName) comes from the schema diff
 * in `syncMirror`. A hull's lifetime is this router's: a hull missing from a
 * snapshot (evicted by the 15-min timer, destroyed, re-keyed by a take
 * controls) goes through the ONE drop path (`ctx.dropShip`, i.e.
 * `ColyseusClient.dropRemoteShip`), which also drops its predWorld body.
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '@shared-types/messages';
import { shipMirrorKey, type ShipMirrorKeyLocal } from './shipMirrorKey.js';
import { isParkedHull } from '../render/shipOwnership.js';

/** Reused every snapshot (#14). */
const _keyLocalScratch: ShipMirrorKeyLocal = {
  localPlayerId: null, localShipInstanceId: null, localSpectating: false,
};

export interface ShipRouterCtx {
  mirror: RenderMirror;
  /** The local player chose Spectate / Command: their inactive hull is
   *  PARKED, not a pending join, so it keys by shipInstanceId (the Pilot menu
   *  lists your parked ships). Optional; absent ⇒ false. */
  localSpectating?: boolean;
  /** Persistent scratch — reused across calls to avoid per-snapshot allocs. */
  hullSeenScratch: Set<string>;
  hullEvictScratch: string[];
  /** The ONE remote-ship drop path (mirror entry, body, prediction maps). */
  dropShip: (key: string) => void;
}

/**
 * Translates `snap.states` into mirror-keyed entries (playerId for active
 * ships, shipInstanceId for parked hulls). Mutates `snap.states` in place
 * (Probe 8 alloc-saver — Colyseus parses the message fresh, no aliasing
 * risk).
 *
 * Plan: crispy-kazoo, Commit 8 — local-self exemption (via `shipMirrorKey`).
 * The joiner's OWN ship lands in `snap.states` with `isActive=false` during
 * the pending-join handshake window. It keys by playerId so the bootstrap
 * chain (tryInitPredWorld → firstFrameRendered → sendClientReady) finds
 * `mirror.ships.has(localPlayerId)`. See `tests/e2e/spawn-handshake.spec.ts`.
 */
export function routeSnapshotShipStates(snap: SnapshotMessage, ctx: ShipRouterCtx): void {
  const { mirror, hullSeenScratch, hullEvictScratch } = ctx;
  const statesByKey: SnapshotMessage['states'] = {};
  const hullSeen = hullSeenScratch;
  hullSeen.clear();
  const keyLocal = _keyLocalScratch;
  keyLocal.localPlayerId = mirror.localPlayerId;
  keyLocal.localShipInstanceId = mirror.localShipInstanceId ?? null;
  keyLocal.localSpectating = ctx.localSpectating === true;
  // `for…in` instead of `Object.entries` — no per-snapshot tuple array.
  for (const shipInstanceId in snap.states) {
    const entry = snap.states[shipInstanceId]!;
    // The ONE ship-key rule (`shipMirrorKey`, shared with syncMirror). A null
    // key (own ACTIVE entry while spectating) still feeds the reconciler
    // under the playerId: this slice is pose input, not the drawn mirror.
    const key = shipMirrorKey(shipInstanceId, entry.playerId, entry.isActive !== false, keyLocal);
    if (key === null || key === entry.playerId) {
      statesByKey[entry.playerId] = entry;
      continue;
    }
    // A parked hull: same map, its own key. Pooled entry (Probe 8): pose is
    // only SEEDED here; afterwards it comes from the predWorld body (the
    // remote-ship path), or from the snapshot while the hull has no body.
    statesByKey[shipInstanceId] = entry;
    hullSeen.add(shipInstanceId);
    let hull = mirror.ships.get(shipInstanceId);
    if (!hull) {
      hull = {
        x: entry.x, y: entry.y, vx: entry.vx, vy: entry.vy, angle: entry.angle,
        ownerPlayerId: entry.playerId,
        isActive: false,
      };
      mirror.ships.set(shipInstanceId, hull);
    } else {
      hull.ownerPlayerId = entry.playerId;
      hull.isActive = false;
    }
  }
  // Drop parked hulls that didn't appear in this snapshot. Collect then drop
  // (no mutation mid-iteration), into a persistent scratch (#14). Active
  // ships' lifetime is the schema diff's (`syncMirror`), not this sweep's.
  const toEvict = hullEvictScratch;
  toEvict.length = 0;
  for (const [key, ship] of mirror.ships) {
    if (!hullSeen.has(key) && isParkedHull(mirror, key, ship)) toEvict.push(key);
  }
  for (let i = 0; i < toEvict.length; i++) ctx.dropShip(toEvict[i]!);
  toEvict.length = 0;
  // Probe 8 — swap in the re-keyed states (no spread of the whole snap).
  snap.states = statesByKey;
}

/**
 * Applies the server-authoritative boost + thrust sets to the render
 * mirror. Reset-and-fill on every snapshot — every snapshot is the
 * authoritative truth; locals are layered on top via per-tick
 * prediction.
 */
export function applyBoostingThrustingSets(snap: SnapshotMessage, mirror: RenderMirror): void {
  if (mirror.boostingShips) {
    mirror.boostingShips.clear();
    if (snap.boostingIds) {
      for (const id of snap.boostingIds) mirror.boostingShips.add(id);
    }
  }
  if (mirror.thrustingShips) {
    mirror.thrustingShips.clear();
    if (snap.thrustingIds) {
      for (const id of snap.thrustingIds) mirror.thrustingShips.add(id);
    }
  }
}
