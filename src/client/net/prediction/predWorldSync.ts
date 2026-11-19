/**
 * The prediction world's own bodies, outside the per-frame step: the local
 * ship's body + Reconciler bootstrap (`tryInitPredWorld`, from the welcome /
 * first state), the swarm bodies (`syncSwarmIntoPredWorld`, after every
 * binary `swarm` packet), and the ship re-key / remote-body group
 * (`rekeyShip`, `dropRemoteShip`, `ensureRemoteShipBody`). All run with `ColyseusClient`'s once-built
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
import type { ShipPhysicsState } from '@core/physics/World';
import { forgetRemote } from '../remotePredictionGuard';
import { isOwnedByMe, isParkedHull } from '../../render/shipOwnership.js';
import { moveKey, moveSetKey } from '../../render/shipRekey.js';
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

/**
 * THE one way a remote ship's predWorld body and per-ship prediction state
 * go away (RTS Part A S0; replaced four inline copies: transit, killEntity,
 * the syncMirror departed sweep, the warp-run despawn). Clears the body,
 * `predRemoteShipIds`, the render lerp offset, the forward-prediction
 * inputs / lookahead counter, the prediction guard and the arrival snap.
 *
 * `'gone'` (default) also drops the mirror entry and its history: the ship
 * left. `'outOfWorld'` keeps them: a ship on its warp run is still listed,
 * it just has no body until it lands (`syncRemoteWarpBodies`).
 * Harmless on the local key (the syncMirror sweep may pass it): the local
 * body is never in `predRemoteShipIds`, so it is not despawned here; it has
 * its own ownership site.
 */
/**
 * Welcome-time re-key of our own ship from its parked-hull key (see the
 * welcome handler). With a real welcome ship id, takes EXACTLY that hull —
 * never a same-player OLD hull the player just displaced (seeding the local
 * body at the stale hull's pose was the 2026-06-03 displace bug). Only with
 * NO instance id (engineering rooms) does it fall back to the first parked
 * hull we own. The move is `rekeyShip` (the ONE re-key): the hull's remote
 * body goes BEFORE `tryInitPredWorld` spawns the local one (never two
 * overlapping bodies), and the SAME entry object moves to the playerId, so
 * the local body spawns at the hull's drawn pose and the renderer keeps the
 * ship's sprite, art, turrets and effects (seamless hand-over). Lock:
 * `ColyseusClient.pilotSwap.test.ts`, `tests/e2e/rts-take-controls.spec.ts`.
 */
export function rekeyOwnShipFromHull(c: PredictionStepCtx, playerId: string, welcomeShipInstanceId: string): void {
  let hullKey: string | null = null;
  if (welcomeShipInstanceId !== '') {
    const e = c.mirror.ships.get(welcomeShipInstanceId);
    if (e !== undefined && isParkedHull(c.mirror, welcomeShipInstanceId, e)) hullKey = welcomeShipInstanceId;
  } else {
    for (const [key, e] of c.mirror.ships) {
      if (isParkedHull(c.mirror, key, e) && isOwnedByMe(c.mirror, key, e)) { hullKey = key; break; }
    }
  }
  if (hullKey === null || hullKey === playerId) return;
  const hull = c.mirror.ships.get(hullKey)!;
  rekeyShip(c, hullKey, playerId);
  logEvent('rescued_own_ship_from_lingering', {
    shipInstanceId: hullKey,
    playerId,
    x: hull.x,
    y: hull.y,
  });
}

export function dropRemoteShip(c: PredictionStepCtx, key: string, mode: 'gone' | 'outOfWorld' = 'gone'): void {
  if (c.predRemoteShipIds.delete(key)) c.predWorld?.despawnShip(key);
  c.remoteShipOffsets.delete(key);
  c.remoteLastInputs.delete(key);
  c.remoteForwardTicks.delete(key);
  forgetRemote(c.predGuard, key);
  c.arrivalSnapped.delete(key);
  if (mode === 'gone') {
    c.mirror.ships.delete(key);
    c.remoteHistory.delete(key);
  }
}

/**
 * THE one ship re-key (RTS Part A, seamless take controls). A ship's mirror
 * key changes when someone takes its controls (shipInstanceId -> pilot's
 * playerId) or lets go of them (playerId -> shipInstanceId): the welcome
 * (`rekeyOwnShipFromHull`), Command / Spectate (`dropLocalShipForCommand`),
 * and another player's swap seen by the router / `syncMirror`
 * (`findRekeySource`). The SAME entry object moves (pose, kind, turrets,
 * level, shield state kept), with its body and per-ship prediction state:
 *  - remote -> remote: the body is respawned under the new key at its own
 *    state, offsets / inputs / lookahead / history move with it;
 *  - remote -> local: the remote body goes (`tryInitPredWorld` then spawns
 *    the local body at the entry's drawn pose);
 *  - local -> remote: the local body becomes a remote body at its state (a
 *    real pose, never the schema's: B2) and the reconciler goes.
 * The pair is queued on `mirror.pendingShipRekeys`, so the renderer moves its
 * per-ship state too instead of rebuilding the ship. A stale entry already
 * under `to` is dropped first. Rare (a hand-over), never per frame.
 */
export function rekeyShip(c: PredictionStepCtx, from: string, to: string): void {
  if (from === to) return;
  const entry = c.mirror.ships.get(from);
  if (entry === undefined) return;
  const localId = c.mirror.localPlayerId;
  const pw = c.predWorld;
  if (c.mirror.ships.has(to)) {
    if (to === localId) c.mirror.ships.delete(to);
    else dropRemoteShip(c, to);
  }
  let body: ShipPhysicsState | null = null;
  if (from === localId) {
    if (pw?.hasShip(from)) {
      body = pw.getShipState(from);
      pw.despawnShip(from);
      c.reconciler = null;
    }
  } else {
    if (c.predRemoteShipIds.has(from)) body = pw?.getShipState(from) ?? null;
    if (to !== localId) {
      moveKey(c.remoteShipOffsets, from, to);
      moveKey(c.remoteLastInputs, from, to);
      moveKey(c.remoteForwardTicks, from, to);
      moveKey(c.remoteHistory, from, to);
      moveSetKey(c.arrivalSnapped, from, to);
    }
    dropRemoteShip(c, from, 'outOfWorld');
  }
  c.mirror.ships.delete(from);
  c.mirror.ships.set(to, entry);
  if (to !== localId && body !== null && entry.kind !== undefined && localId !== null) {
    ensureRemoteShipBody(c, to, body, entry.kind);
  }
  moveKey(c.damageFlashFrames, from, to);
  c.rekeyLockState(from, to);
  c.mirror.pendingShipRekeys?.push(from, to);
  logEvent('ship_rekeyed', { from, to });
}

/**
 * THE one way a remote ship's predWorld body is spawned (RTS Part A S0;
 * replaced the syncMirror, tryInitPredWorld-retro and warp-arrival copies).
 * Spawns at `pose` and tracks it in `predRemoteShipIds`; a no-op returning
 * false when the body already exists. Callers keep their own gates (known
 * local id, not on a warp run).
 *
 * ONE spawn rule (RTS Part A blocker B2): a remote body (another pilot's
 * ship OR a parked / AI-flown hull) spawns ONLY from a real SNAPSHOT pose.
 * The callers are the per-snapshot `spawnRemoteShipBodies`, the
 * warp-arrival snap, and `rekeyShip`, which carries a body's OWN state
 * across a re-key (a predicted body is a real pose too). Never the schema
 * diff (which carries no pose: its x/y are 0): a body spawned at (0,0)
 * parked an invisible, shootable ghost at the world origin (the 2026-06-03
 * "laser stops short at (0,0)" bug). Lock:
 * `ColyseusClient.lingeringJitter.test.ts`.
 */
export function ensureRemoteShipBody(c: PredictionStepCtx, key: string, pose: ShipPhysicsState, kind: string): boolean {
  const pw = c.predWorld;
  if (!pw || pw.hasShip(key)) return false;
  pw.spawnShip(key, pose.x, pose.y, kind);
  pw.setShipState(key, pose);
  c.predRemoteShipIds.add(key);
  return true;
}
