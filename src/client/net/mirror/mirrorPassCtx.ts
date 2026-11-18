import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Clock } from '@core/clock/Clock';
import type { GameClock } from '@core/clock/GameClock';
import type { PhysicsWorld } from '@core/physics/World';
import type { Reconciler } from '@core/prediction/Reconciler';
import type { HitPredictionLedger } from '@core/combat/HitPrediction';
import type { AiController } from '@core/ai/AiController';
import type { GhostManager } from '../../combat/GhostProjectile.js';
import type { DisplayPoseHitscan } from '../../combat/displayPoseHitscan.js';
import type { PlacementPreview, PendingPlacement, ShipPose } from '../../structures/structurePlacementClient.js';
import type { InterpolatedPose } from '../swarmInterpolation.js';
import type { RemoteShipOffset } from '../remoteLerpOffsets.js';

/** A predicted damage-number split waiting for its time (`sendFire` seeds them). */
export interface ScheduledDamageSpawn { atMs: number; targetId: string; x: number; y: number; damage: number; tag: string }

/**
 * What the per-frame mirror passes (`updateMirror`) read and write on
 * `ColyseusClient`. Built ONCE (#14): fields the client reassigns are getters
 * (and setters where a pass writes them), so a pass never holds a stale value
 * and no call allocates.
 */
export interface MirrorPassCtx {
  readonly mirror: RenderMirror;
  readonly clock: Clock;
  readonly gameClock: GameClock;
  readonly predWorld: PhysicsWorld | null;
  readonly reconciler: Reconciler | null;
  /** Wall ms of the last frame (visual smoothing). */
  readonly lastFrameMs: number;
  readonly lastLocalTickAtMs: number;
  readonly inputTick: number;
  readonly scheduledDamageSpawns: ScheduledDamageSpawn[];
  pendingPlacement: PendingPlacement | null;
  readonly placementShipScratch: ShipPose;
  readonly placementPreviewScratch: PlacementPreview;
  /** Two-Set swap for the swarm-near diagnostic (written back each frame). */
  swarmNearbyIds: Set<number>;
  swarmNearbySwapScratch: Set<number>;
  readonly swarmInterpScratch: InterpolatedPose;
  readonly lastSnapshotPos: { x: number; y: number } | null;
  readonly predRemoteShipIds: ReadonlySet<string>;
  readonly remoteShipOffsets: Map<string, RemoteShipOffset>;
  readonly ghostManager: GhostManager;
  readonly shellEvents: boolean;
  readonly clockAnchorServerTick: number;
  readonly clockAnchorPerfNow: number;
  readonly damageFlashFrames: Map<string, number>;
  readonly hitLedger: HitPredictionLedger;
  readonly lastHitscanFireMs: number | null;
  readonly skipHitscanVisual: boolean;
  readonly aiController: AiController;
  /** This frame's length in GAME ms (time scale). */
  gameFrameMs(): number;
  placeShells(displayTick: number): void;
  displayHitscan(): DisplayPoseHitscan;
}
