/**
 * Snapshot ship-states routing — splits incoming `snap.states` into
 * (a) active player-keyed entries the rest of `handleSnapshot` uses
 * and (b) lingering (inactive) hulls routed to the mirror's
 * shipInstanceId-keyed `lingeringShips` map.
 *
 * Why: the wire keys by `shipInstanceId` (Phase 6a) — same playerId
 * can have an active and a lingering hull simultaneously. The
 * predWorld + reconciler use `playerId` internally for active hulls
 * (Phase 6b C-ii strategy), so we re-key actives into a separate
 * object and route lingers to their own map. Identity fields (kind,
 * displayName) flow via the Colyseus schema diff in `syncMirror`;
 * this only refreshes pose per snapshot.
 *
 * The lingering map is reconciled at the end: any id missing from
 * this snapshot is evicted (15-min server timeout, or destroyed)
 * along with its predWorld body via the `LingeringPredBodyManager`.
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '@shared-types/messages';
import type { PhysicsWorld } from '@core/physics/World';
import type { LingeringPredBodyManager } from './LingeringPredBodyManager.js';

export interface ShipRouterCtx {
  mirror: RenderMirror;
  predWorld: PhysicsWorld | null;
  lingerBodies: LingeringPredBodyManager;
  tryEnsureLingerPredBody: (shipInstanceId: string) => void;
  /** Persistent scratch — reused across calls to avoid per-snapshot allocs. */
  lingeringSeenScratch: Set<string>;
  lingeringToEvictScratch: string[];
}

/**
 * Translates `snap.states` (shipInstanceId-keyed wire format) into
 * playerId-keyed active entries, routing lingering (inactive) hulls
 * into `mirror.lingeringShips`. Mutates `snap.states` in place
 * (Probe 8 alloc-saver — Colyseus parses the message fresh, no
 * aliasing risk).
 *
 * Plan: crispy-kazoo, Commit 8 — local-self exemption.
 * The joiner's OWN ship lands in `snap.states` with `isActive=false`
 * during the pending-join handshake window. Without the exemption,
 * own ship gets routed to `lingeringShips` and the bootstrap chain
 * (tryInitPredWorld → firstFrameRendered → sendClientReady) stalls
 * forever because `mirror.ships.has(localPlayerId)` stays false.
 * Routing the OWN ship to `mirror.ships` regardless of `isActive` keeps
 * the local player's predWorld + render path intact; other clients
 * still filter the same entry out for THEIR own translators (it's
 * just not THEIR localPlayerId). See `tests/e2e/spawn-handshake.spec.ts`
 * for the regression lock.
 */
export function routeSnapshotShipStates(snap: SnapshotMessage, ctx: ShipRouterCtx): void {
  const { mirror, predWorld, lingerBodies, tryEnsureLingerPredBody,
    lingeringSeenScratch, lingeringToEvictScratch } = ctx;
  const statesByPlayerId: SnapshotMessage['states'] = {};
  if (!mirror.lingeringShips) mirror.lingeringShips = new Map();
  // 2026-05-25 heap-growth gate step 1: reuse persistent Set scratch
  // instead of `new Set<string>()` per snapshot.
  const lingeringSeen = lingeringSeenScratch;
  lingeringSeen.clear();
  const localPlayerId = mirror.localPlayerId;
  const localShipInstanceId = mirror.localShipInstanceId ?? null;
  // 2026-05-25 heap-growth gate step 4: `for…in` instead of
  // `Object.entries` — saves the per-snapshot [key,value] tuple array.
  for (const shipInstanceId in snap.states) {
    const entry = snap.states[shipInstanceId]!;
    // Own-ship identification keys on shipInstanceId, NOT playerId: a
    // displaced player owns BOTH a lingering hull and a fresh active ship
    // under one playerId. Only the welcome ship (matching localShipInstanceId)
    // keeps the pending-join active exemption; the player's DISPLACED hulls
    // route to lingeringShips like any other parked hull — so the OWNER SEES
    // their pool in-world (2026-06-03 "I can't see the lingering ships") and
    // they never clobber the active ship at statesByPlayerId[playerId] (the
    // 2026-06-03 "pinned in my old interceptor" bug was the playerId-only
    // exemption letting a displaced hull win that key).
    const isOwnPlayer = localPlayerId !== null && entry.playerId === localPlayerId;
    const isOwnActiveShip =
      isOwnPlayer && localShipInstanceId !== null && shipInstanceId === localShipInstanceId;
    if (entry.isActive === false && isOwnActiveShip) {
      // Own joining ship MUST stay in `mirror.ships` even while pending-join
      // (isActive=false on server). Without this the bootstrap chain stalls
      // on rendererFirstFrameRendered.
      statesByPlayerId[entry.playerId] = entry;
      continue;
    }
    if (entry.isActive === false) {
      // Route to the lingering map. We update pose every snapshot;
      // identity fields come from the schema diff and are preserved.
      // Probe 8 (mobile-perf-investigation, 2026-05-24) — pool the
      // lingering entry in place. Same rationale as Probe 7's ship
      // pooling: kind / displayName preserved by NOT touching them.
      let lingerEntry = mirror.lingeringShips.get(shipInstanceId);
      if (!lingerEntry) {
        lingerEntry = {
          x: entry.x, y: entry.y, vx: entry.vx, vy: entry.vy,
          angle: entry.angle,
          ownerPlayerId: entry.playerId,
        };
        mirror.lingeringShips.set(shipInstanceId, lingerEntry);
      } else {
        lingerEntry.x = entry.x;
        lingerEntry.y = entry.y;
        lingerEntry.vx = entry.vx;
        lingerEntry.vy = entry.vy;
        lingerEntry.angle = entry.angle;
        lingerEntry.ownerPlayerId = entry.playerId;
      }
      lingeringSeen.add(shipInstanceId);
      // Phase 6b — spawn / refresh the predWorld body so the local
      // player can collide with the parked hull (mirrors the wreck
      // pattern in syncWreckPoses). The helper handles the race
      // between this site (pose) and syncMirror (kind) — see its
      // doc comment.
      tryEnsureLingerPredBody(shipInstanceId);
      continue;
    }
    statesByPlayerId[entry.playerId] = entry;
  }
  // Remove lingering hulls that didn't appear in this snapshot (evicted
  // by the 15-min timer, or destroyed) — plus despawn their predWorld
  // bodies so the local player stops colliding with ghosts.
  // 2026-05-25 heap-growth gate step 1: collect ids to evict into a
  // persistent scratch array instead of `[...keys()]` spread alloc.
  // Two-phase (collect then evict) so we don't mutate the Map mid-iter.
  const toEvict = lingeringToEvictScratch;
  toEvict.length = 0;
  for (const id of mirror.lingeringShips.keys()) {
    if (!lingeringSeen.has(id)) toEvict.push(id);
  }
  for (const id of toEvict) {
    mirror.lingeringShips.delete(id);
    if (predWorld) lingerBodies.despawn(id, predWorld);
  }
  // Probe 8 — mutate snap.states in place rather than spreading into
  // a new object. `snap` is the parameter from `room.onMessage` and
  // is owned by us for the duration of this handler — Colyseus
  // freshly-parses it per message, no aliasing concern. Saves one
  // object allocation per snapshot (the spread also copied references
  // to all the other snap fields — projectiles, wrecks, drones,
  // boostingIds, etc.).
  snap.states = statesByPlayerId;
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
