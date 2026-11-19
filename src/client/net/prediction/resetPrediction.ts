/**
 * The sector-handoff prediction reset (`resetPredictionState`), called by the
 * `transit_ready` handler through `ColyseusClient`'s one-line delegate. Runs
 * once per handoff, never per frame.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { PhysicsWorld } from '@core/physics/World';
import type { Reconciler } from '@core/prediction/Reconciler';
import type { AiController } from '@core/ai/AiController';
import { createWelford, type WelfordState } from '@core/math/Welford';
import { createLookaheadController, type LookaheadController } from '../lookaheadController';
import { createDropDetector, type DropDetector } from '../snapshotDropDetector';
import type { WreckGeometryStore } from '../wreckGeometryStore.js';
import type { CutFieldClient } from '../CutFieldClient.js';
import type { DrawnShellTiming } from '../drawnShellTiming';
import type { DataChannelTransport } from '../dataChannelTransport.js';

const NO_LOCKED_BY: ReadonlyArray<{ t: string; s: number; p: number }> = [];

/** What the reset writes on `ColyseusClient`. Built ONCE (#14): reassigned
 *  fields are getters/setters. */
export interface PredictionResetCtx {
  readonly mirror: RenderMirror;
  readonly wrecks: WreckGeometryStore;
  readonly cutField: Pick<CutFieldClient, 'stop'>;
  readonly shellTiming: Pick<DrawnShellTiming, 'reset'>;
  readonly predWorld: PhysicsWorld | null;
  readonly aiController: Pick<AiController, 'unregister'>;
  readonly aiRegisteredIds: Set<number>;
  readonly predWalls: Map<number, { id: string }>;
  readonly recentIntervals: number[];
  readonly recentCorrFlags: number[];
  /** The pending visual damage splits (only emptied here). */
  readonly scheduledDamageSpawns: { length: number };
  energySeeded: boolean;
  localPoseEpoch: number;
  warpRequest: { x: number; y: number } | null;
  rttWelford: WelfordState;
  lookaheadCtrl: LookaheadController;
  dropDetector: DropDetector;
  leadTicks: number;
  anchorInitialised: boolean;
  anchorFreshAtMs: number;
  stallHoldSinceMs: number;
  lastSnapshotAt: number;
  swarmBinaryLastMs: number;
  swarmBinaryEwma: number;
  reconciler: Reconciler | null;
  lastStatAllocKey: string;
  localPoseResolvedLogged: boolean;
  lastLocalTickAtMs: number;
  dataChannelTransport: DataChannelTransport | null;
  applyLocalDisabled(ms: number): void;
}

/**
 * Wipe the Stage 4 prediction-loop state so the next snapshot from a
 * fresh sector room behaves like a first-connect snapshot.
 *
 * Why this exists: the `transit_ready` handler hot-swaps the room's
 * WebSocket via `consumeSeatReservation` but reuses the same
 * `ColyseusClient` instance. Without an explicit reset, the welford
 * RTT mean/σ, the spring-smoothed `leadTicks`, the snapshot-interval
 * EWMA, the drop detector, and the clock anchor all carry across
 * the 5+ s transit gap. The first wave of post-transit snapshots
 * push gap-contaminated `lastRtt` samples (clamped to 250 ms by Stage 4
 * hotfix #1, but still pushed when `intervalMs` lands back in the
 * [35, 75] band by hotfix #3) into the surviving welford, the running
 * mean drifts up, `mean + 2σ` saturates the 30-tick `CEILING_TICKS`
 * cap in `lookaheadController`, and the client predicts ~600 ms
 * ahead of authoritative state. Symptoms: `srvTick − ackedTick` locks
 * at ~−37 for the rest of the session, the local ship renders far
 * from where the server thinks it is, large reconcile drifts, and
 * 60–70% of snapshots produce a correction that lerping must mask.
 *
 * Diagnosed from cap `2026-05-09T07-49-57-470Z-81numi` (post-warp,
 * 67% correction rate, every snapshot at offset −37); cap
 * `2026-05-09T07-51-26-622Z-wc5fm0` (steady-state long after the same
 * session, offset settled to −15) is the clean baseline.
 *
 * Spatial seed (2026-05-16 fix). The pre-2026-05-16 version reset only
 * the RTT/timing state above and left the local `predWorld` ship body
 * + the `Reconciler` instance untouched. The `transit_ready`
 * mirror-cleanup loop preserves the local ship, so `tryInitPredWorld`
 * early-returned on `predWorld.hasShip(localId)` at the destination and
 * the body arrived still at the SOURCE-sector pose. The destination's
 * first `handleSnapshot` then reconciled that stale body against the
 * arrival pose, surfacing the entire source→destination delta as
 * "drift" (210-380 u on-device, diag
 * `2026-05-16T11-59-43-103Z-tl56wa`), which the reconciler lerped out
 * over ~1.3 s post-curtain — the warp-out jank. So this also despawns
 * the local predWorld body and NULLS the reconciler: the destination's
 * first state-diff / snapshot reseeds via the existing
 * `tryInitPredWorld` path AT THE AUTHORITATIVE ARRIVAL POSE (which
 * rebuilds the `Reconciler`), making the "fresh-connect seed" the
 * comment above promises true for the spatial body too. Nulling the
 * reconciler also subsumes the old `reconciler.lastRtt = 0` (there is
 * no surviving reconciler to re-poison the welford). `handleSnapshot`
 * + `tickPhysics` both already guard `!this.reconciler` (the
 * pre-first-welcome state) — the fix re-enters that well-tested state,
 * it does not invent one. One ownership site; no second correction
 * path (Invariant #12 philosophy). Locked by
 * `ColyseusClient.transitArrivalDrift.test.ts`.
 */
export function resetPredictionState(ctx: PredictionResetCtx): void {
  // S2b: wrecks belong to the old sector (clears mirror.wrecks too).
  ctx.wrecks.clear();
  ctx.cutField.stop(); // the cut field belongs to the old sector; the next welcome re-arms it
  // Deaths held for their drawn shell belong to the old sector too.
  ctx.shellTiming.reset();
  // Fire control: NPC locks belong to the old sector.
  ctx.mirror.localLockedBy = NO_LOCKED_BY;
  // A new sector / ship: seed the energy pool again from the new ship.
  ctx.energySeeded = false;
  // v4 T2 — a new sector's first snapshot only records the teleport epoch.
  ctx.localPoseEpoch = -1;
  // v4 A — a disable belongs to the room that applied it.
  ctx.applyLocalDisabled(0);
  // Phase 4 — a warp drop point belongs to its sector.
  ctx.warpRequest = null;
  ctx.rttWelford = createWelford();
  ctx.lookaheadCtrl = createLookaheadController(6);
  ctx.dropDetector = createDropDetector();
  ctx.leadTicks = 6;
  ctx.anchorInitialised = false;
  ctx.anchorFreshAtMs = -Infinity;
  ctx.stallHoldSinceMs = -1;
  ctx.lastSnapshotAt = 0;
  ctx.recentIntervals.length = 0;
  ctx.recentCorrFlags.length = 0;
  // Drone display-delay cadence tracking — reset so the destination
  // sector's binary cadence is learned fresh (a stale cross-warp gap
  // must not seed the adaptive delay at the ceiling).
  ctx.swarmBinaryLastMs = -1;
  ctx.swarmBinaryEwma = 0;
  // Spatial seed (2026-05-16) — see the method doc comment. Despawn the
  // local predWorld ship body and drop the Reconciler so the
  // destination's first state-diff / snapshot reseeds the body AT THE
  // AUTHORITATIVE ARRIVAL POSE via `tryInitPredWorld` (which rebuilds
  // the Reconciler). Without this the body carries the source pose into
  // the destination and the first reconcile lerps out the full
  // inter-sector delta — the warp-out drift jank. Subsumes the old
  // `reconciler.lastRtt = 0` (no surviving reconciler to re-poison the
  // welford).
  const localId = ctx.mirror.localPlayerId;
  if (localId && ctx.predWorld?.hasShip(localId)) {
    ctx.predWorld.despawnShip(localId);
  }
  ctx.reconciler = null;
  // Phase 4 WS-B2 — the local predWorld body is despawned, so its physics stat
  // multipliers go with it; clear the guard so the destination's first
  // own-ship `statAlloc` slice re-anchors the fresh body (otherwise an
  // identical key would suppress the re-push and the new body would run
  // un-upgraded prediction).
  ctx.lastStatAllocKey = '';
  // Phase 3 — drop AI registrations on sector handoff. The destination
  // sector has a different swarm; old behaviours would hold stale
  // `lastFireTick` and target stale player IDs that may not exist there.
  for (const id of ctx.aiRegisteredIds) {
    ctx.aiController.unregister(`${id}`);
  }
  ctx.aiRegisteredIds.clear();
  // Shield-fence plan — drop predWorld shield-wall colliders on handoff; the
  // destination sector's fences re-sync from its own structure slice.
  for (const w of ctx.predWalls.values()) ctx.predWorld?.removeWall(w.id);
  ctx.predWalls.clear();
  // Join-render diagnostic latch — re-arm so the destination room's
  // `tryInitPredWorld` success fires a fresh `local_pose_resolved`.
  ctx.localPoseResolvedLogged = false;

  // Render-jitter-fix Phase 1 (2026-05-21): the dead-reckon anchor is
  // part of the prediction window — its sample is from the source
  // sector's predWorld and dead-reckoning forward from it across a
  // transit gap would produce nonsense motion. Reset to -1 sentinel;
  // next physics tick post-transit re-stamps it.
  ctx.lastLocalTickAtMs = -1;

  // Phase 2 swift-otter — close the DataChannel transport on sector
  // handoff. The source room's PeerConnection is torn down; the
  // destination room's welcome handler will start a fresh one when
  // the `_webrtcEnabled` flag is set. Reset the reordering guard so
  // the destination's serverTick is accepted.
  if (ctx.dataChannelTransport) {
    ctx.dataChannelTransport.close('sector-handoff');
    ctx.dataChannelTransport = null;
  }

  // Smooth-beam (2026-05-22): drop scheduled visual splits. The source
  // sector's prediction state is dead; any pending splits would spawn
  // damage numbers at coordinates from the source pose against the
  // destination mirror.
  ctx.scheduledDamageSpawns.length = 0;

  // Effects subsystem (M9 — plan wiggly-puppy). The pendingEffectTriggers
  // queue holds source-sector world coords; draining them in the
  // destination would spawn effects at the wrong place. Drop them.
  // Per-entity continuous emitters + shield rings live in the renderer's
  // EffectsService instance, which the renderer cleans up on its own
  // (PixiRenderer.dispose or syncEngine/ShieldAura's diff-against-empty-
  // mirror on the first destination frame). The mirror.ships clear that
  // happens elsewhere will already empty the diff sets that drive the
  // setContinuous calls, so emitters get unregistered naturally.
  if (ctx.mirror.pendingEffectTriggers) ctx.mirror.pendingEffectTriggers.length = 0;
}
