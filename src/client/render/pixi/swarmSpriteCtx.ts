/**
 * The swarm sprite updater's per-frame context and per-sprite build
 * signature (`updateSwarmSprites`, swarmSpriteUpdater.ts).
 */
import type { Container, RenderLayer } from 'pixi.js';
import type { CutFieldLayer } from '../field/CutFieldLayer';
import type { MountVisualManager } from '../MountVisualManager';
import type { ShipArtCtx } from '../art/shipArtSprites.js';
import type { InterpolatedPose } from '../../net/swarmInterpolation';
import type { WreckGeometryStore } from '../../net/wreckGeometryStore';
import type { WreckArtState } from './wreckArt.js';
import type { DyingHullHold } from './dyingHullHold.js';
import type { StructureRigs } from './structureRigs.js';

/** Campaign 3.2 — everything (besides the pose-core kind, tracked separately
 *  in `spriteKinds` for #20 back-compat) that a swarm sprite's VISUAL is built
 *  from. Any component changing under a recycled entityId means the cached
 *  sprite is the wrong picture. */
export interface SpriteBuildSig {
  shipKind: string | null;
  componentIndex: number;
  radius: number;
  /** S2b: a wreck piece's wreck (0 for every other kind). */
  wreckId: number;
  /** An awake cut-field rock's key (-1 for everything else). */
  fieldKey: number;
}

export interface SwarmSpriteCtx {
  /** A3 — the camera's visible rect (pixi space) this frame; structures
   *  outside it are not drawn. Absent ⇒ draw everything. */
  viewBounds?: Float64Array;
  shipContainer: Container;
  sprites: Map<string, Container>;
  /** Machined art (A3): drones of a known ship kind; null service ⇒ today's look. */
  art: ShipArtCtx;
  mountVisuals: MountVisualManager;
  swarmPoseScratch: InterpolatedPose;
  remoteHitTargets: Set<string>;
  localHitTargets: Set<string>;
  seenScratch: Set<string>;
  /** P3.8 — per-structure SLEWED mount (barrel/drill) arc-local angles, keyed by
   *  `swarm-<entityId>`, persisted across frames so the barrel rotates toward
   *  its target instead of SNAPPING. Owned + swept by the renderer (deleted with
   *  the sprite on despawn). */
  structureMountAngles: Map<string, number[]>;
  /** Equinox Phase 3 #20 — parallel to `sprites`: the `kind` each cached sprite
   *  was BUILT for, keyed by `swarm-<entityId>`. The server recycles the dense
   *  u16 entityId (a destroyed structure's id is handed to the next spawn), so a
   *  cached entityId's `kind` byte can FLIP (structure 2 → drone 1). The reaper
   *  sweep only despawns entities ABSENT from the frame (a recycled id stays
   *  present), so without this the stale structure sprite is reused for the new
   *  drone — the "drone renders as a connector/turret" bug. On a kind change the
   *  updater tears the sprite down + rebuilds. Owned + swept by the renderer
   *  (deleted with the sprite on despawn), like `structureMountAngles`. */
  spriteKinds: Map<string, number>;
  /** Campaign 3.2 (review B4) — the FULL build signature each cached sprite
   *  was constructed from. #20's `spriteKinds` guard catches a pose-core kind
   *  flip, but the sprite is BUILT from `(kind, shipKind, componentIndex,
   *  radius)`: a recycled id keeping the same kind while changing SUBTYPE
   *  (connector→turret, fighter→heavy, another scrap component) kept the
   *  stale silhouette. Record allocated ONCE on the create path (#14 — the
   *  per-frame check is a map get + scalar compares); deleted with the
   *  sprite (guard teardown + renderer reaper sweep). */
  spriteBuildSigs: Map<string, SpriteBuildSig>;
  /** P3.8 — seconds since the previous call; the structure-mount slew rate input
   *  (`rotateMountToward` advances ≤ `rotationSpeed * slewDtSec` per call). The
   *  renderer computes it (clamped) from wall-clock; tests inject a fixed value
   *  for a deterministic slew. */
  slewDtSec: number;
  /** Capital destruction S2b: the renderer's wreck geometry, rebuilt from
   *  `mirror.wrecks` (the worker has its own heap). Absent ⇒ wreck pieces are
   *  not drawn. */
  wrecks?: WreckGeometryStore;
  /** Capital destruction S3: per-wreck death clock + break-up sink. Absent ⇒
   *  pieces draw cool and no break-up plays. */
  wreckArt?: WreckArtState;
  /** Macro terrain C2: the cut-field layer. An awake field rock (an asteroid
   *  with `fieldKey`) draws its own cut outline and leaves its chunk mesh.
   *  A placed rock and a cut rock's pieces draw its rock shader too
   *  (`buildRockMesh`). Absent ⇒ they draw as plain asteroids. */
  fieldRocks?: Pick<CutFieldLayer, 'noteAwake' | 'buildRockSprite' | 'buildRockMesh'>;
  /** The renderer's presentation clock (fxNow, ms), which follows the game
   *  speed: wreck death clocks and the cut-edge glow age on it, so they slow
   *  down in slow motion and speed up at 4x. Absent: the wall `now` (tests).
   *  Pose interpolation stays on the wall clock (wall-stamped arrivals). */
  fxNowMs?: number;
  /** Dying capitals held on screen until their wreck pieces are drawn; told
   *  of every piece drawn this frame. Absent ⇒ no hold. */
  dyingHulls?: DyingHullHold;
  /** The camera scale (CSS px per world u) this frame: wreck pieces go to
   *  their far-zoom LOD where ships become icons. Absent: full art (tests). */
  cameraScale?: number;
  /** Where far-zoom wreck specks draw (one batch for all of them). Absent:
   *  in place, inside each piece. */
  wreckFarLayer?: RenderLayer;
  /** Structure restyle 2c (`?rigs=1`): articulated rig parts on structures.
   *  Absent (flag off) ⇒ no rig is created or posed. */
  structureRigs?: StructureRigs;
}
