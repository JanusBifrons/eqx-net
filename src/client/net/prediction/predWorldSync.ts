/**
 * The prediction world's own bodies, outside the per-frame step: the local
 * ship's body + Reconciler bootstrap (`tryInitPredWorld`, from the welcome /
 * first state) and the swarm bodies (`syncSwarmIntoPredWorld`, after every
 * binary `swarm` packet). Both run with `ColyseusClient`'s once-built
 * `PredictionStepCtx` (#14); the client keeps one-line delegates.
 */
import { Reconciler } from '@core/prediction/Reconciler';
import { getShipKind } from '@shared-types/shipKinds';
import { SWARM_KIND_WRECK } from '@shared-types/swarmWireFormat';
import { PREDWORLD_STRUCTURE_RADIUS, PREDWORLD_WRECK_RADIUS } from '../../../shared-types/structureBudgets.js';
import { wantPredBody } from '../../structures/predStructureStreaming.js';
import { useUIStore } from '../../state/store';
import { logEvent } from '../../debug/ClientLogger';
import { authoritativeSwarmStateAt, isRemoteMovingSwarmKind } from '../snapshotRemoteSync.js';
import type { PredictionStepCtx } from './predictionStepCtx.js';

/** Spawn the local ship's predWorld body + Reconciler once its mirror entry exists. */
export function tryInitPredWorld(c: PredictionStepCtx, playerId: string): void {
  if (!c.predWorld || c.predWorld.hasShip(playerId)) return;
  const existing = c.mirror.ships.get(playerId);
  if (!existing) {
    // Telemetry: tryInitPredWorld was called but the local ship's
    // mirror entry isn't ready yet. Common during the 1-tick window
    // between welcome and the first state-diff for the local ship.
    logEvent('predworld_init_deferred', { playerId, reason: 'no-mirror-entry' });
    return;
  }
  c.predWorld.spawnShip(playerId, existing.x, existing.y, existing.kind);
  c.predWorld.setShipState(playerId, existing);
  c.reconciler = new Reconciler(c.predWorld, playerId, c.clock);
  logEvent('predworld_init', {
    playerId,
    x: existing.x, y: existing.y, kind: existing.kind ?? null,
  });
  // Join-render diagnostic: this is the moment the local ship's
  // pose is observable in the mirror at server-authoritative coords.
  // Fire ONCE per (re)connect — `resetPredictionState` resets the latch.
  if (!c.localPoseResolvedLogged) {
    c.localPoseResolvedLogged = true;
    const msSinceWelcome = c.welcomePerfNow > 0
      ? Math.round(c.clock.now() - c.welcomePerfNow)
      : -1;
    logEvent('local_pose_resolved', {
      playerId,
      x: existing.x,
      y: existing.y,
      kind: existing.kind ?? null,
      msSinceWelcome,
    });
  }
  // Plan: crispy-kazoo, Commit 2 — surface the localPoseResolved
  // gate to Zustand so `computeBootstrapReadyFromState` flips true
  // when the predWorld + reconciler are live. Idempotent; the
  // setter is a no-op if already true.
  useUIStore.getState().setLocalPoseResolved(true);
  logEvent('cc_predworld_init', { x: existing.x, y: existing.y });
  // Remote ships (other pilots and parked hulls) get their bodies from the
  // next snapshot (`spawnRemoteShipBodies`): one spawn rule, snapshot pose
  // only (B2). The old retro spawn here used the mirror's pose, which for a
  // ship known only from the schema diff was (0,0).
  // Swarm entries: a binary `swarm` packet may have arrived
  // before predWorld existed; bring those bodies up now.
  syncSwarmIntoPredWorld(c);
}

/**
 * Sync swarm entries into the prediction world. Called after every binary
 * `swarm` packet decode. New entries spawn predWorld bodies (so the local
 * ship can collide with them and the local hitscan can target them);
 * existing entries get setShipState; entries that vanish from the mirror
 * get despawned. The predWorld key is `swarm-${entityId}`, matching the
 * sprite key in PixiRenderer and the `targetId` the server emits in
 * `laser_fired` for swarm hits.
 */
export function syncSwarmIntoPredWorld(c: PredictionStepCtx): void {
  if (!c.predWorld || !c.mirror.swarm) return;
  // 2026-05-25 heap-growth gate step 5: persistent scratch Set +
  // cached key strings (shared with the updateMirror kinematic loop).
  const seen = c.swarmSyncSeenScratch;
  seen.clear();
  const keyCache = c.swarmBodyKeyCache;
  // Generic Entity Pipeline B4: route construction through the client
  // EntityFactory (the OOP peer of the server leaves). The reused ctx keeps
  // this allocation-free (invariant #14); `ColyseusClient` stays the owner of
  // predSwarmKeys / _swarmBodyKeyCache / _aiRegisteredIds — the leaves only
  // read the ctx and call predWorld / aiController. `staticBody` (lock + pose)
  // is now derived from the core descriptor inside the leaf base; the per-kind
  // collider / mass / AI-ledger / shield-swap details live in the leaves.
  const ctx = c.clientSpawnCtx;
  ctx.predWorld = c.predWorld;
  // A3 — structures stream in by distance from the local ship (every
  // correction replays the whole prediction world). No local ship ⇒ keep all.
  const localId = c.mirror.localPlayerId;
  const me = localId ? c.mirror.ships.get(localId) : undefined;
  // Wreck pieces stream by the GAP between hulls: the local hull's radius
  // (213 u for a 2× crossguard) is not part of the PREDWORLD_WRECK_RADIUS
  // travel budget.
  const myHull = me ? getShipKind(me.kind ?? null).radius : 0;
  for (const [entityId, entry] of c.mirror.swarm) {
    // HC#2: an unrecognised pose-core kind resolves to `null` and is SKIPPED —
    // it never falls through to the drone path (the old `else`-is-drone branch
    // that would mis-register a kind=2 structure as a HostileDroneBehaviour).
    const leaf = c.entityFactory.leafFor(entry.kind);
    if (leaf === null) continue;
    let key = keyCache.get(entityId);
    if (key === undefined) {
      key = `swarm-${entityId}`;
      keyCache.set(entityId, key);
    }
    // S2b: a wreck piece needs its wreck's descriptor for its geometry; until
    // it arrives (≤ 0.5 s for a late joiner) the piece has no body yet.
    if (entry.kind === SWARM_KIND_WRECK && (entry.wreckId === undefined || !c.wrecks.has(entry.wreckId))) continue;
    // Wreck pieces stream in the same way (soak 2026-11-13: ~700 pieces in
    // the predWorld put 56 % of the client main thread into Rapier's step).
    // A piece only matters to prediction where the local ship can touch it.
    if ((entry.kind === 2 || entry.kind === SWARM_KIND_WRECK) && me) {
      const wreck = entry.kind === SWARM_KIND_WRECK;
      const edge = Math.hypot(entry.x - me.x, entry.y - me.y) - entry.radius - (wreck ? myHull : 0);
      const radius = wreck ? PREDWORLD_WRECK_RADIUS : PREDWORLD_STRUCTURE_RADIUS;
      if (!wantPredBody(c.predWorld.hasShip(key), edge, radius)) continue; // unseen ⇒ swept below
    }
    seen.add(key);
    ctx.entityId = entityId;
    ctx.key = key;
    ctx.entry = entry;
    if (!c.predWorld.hasShip(key)) {
      ctx.registeredAiId = null;
      leaf.spawnBody(ctx);
      // Fold any AI-ledger registration the leaf made (drone only) into the
      // client-owned set — single cache ownership stays here.
      if (ctx.registeredAiId !== null) {
        c.aiRegisteredIds.add(ctx.registeredAiId);
      }
      c.predSwarmKeys.add(key);
      if (isRemoteMovingSwarmKind(entry.kind)) {
        c.movingSwarmKeys.add(key);
        // Seed the new body with its latest server state (velocity
        // included) so it moves from birth; the next snapshot's
        // remote-entity anchor puts it on the prediction timeline.
        if (authoritativeSwarmStateAt(entry, entry.lastUpdateTick, c.swarmAnchorScratch)) {
          c.predWorld.setShipState(key, c.swarmAnchorScratch);
        }
      }
    }
    // Idempotent per-sync upkeep: shield-collider swap (drone) or static
    // repose (asteroid / structure). Drones and scrap are NOT re-posed
    // here: their body pose has ONE writer, the per-snapshot remote-entity
    // anchor (`anchorRemoteSwarmBodies`); the leaf's onSync only swaps the
    // shield collider (same body, pose and velocity kept).
    leaf.onSync(ctx);
  }
  // Sweep predWorld bodies whose entityId no longer appears in mirror.swarm.
  for (const key of c.predSwarmKeys) {
    if (!seen.has(key)) {
      c.predWorld.despawnShip(key);
      c.predSwarmKeys.delete(key);
      c.movingSwarmKeys.delete(key);
      // If the swept body was a drone, unregister it from the hostility
      // ledger (`_aiController` is ledger-only post-pivot — never ticked).
      // Numeric entityId is encoded in the key as `swarm-${id}`.
      const idStr = key.startsWith('swarm-') ? key.slice(6) : '';
      const id = Number(idStr);
      if (Number.isFinite(id)) {
        // Step 5 cleanup: also evict the cached key string so the
        // cache doesn't grow unbounded across entity churn.
        c.swarmBodyKeyCache.delete(id);
      }
      if (Number.isFinite(id) && c.aiRegisteredIds.has(id)) {
        c.aiController.unregister(`${id}`);
        c.aiRegisteredIds.delete(id);
      }
    }
  }
}
