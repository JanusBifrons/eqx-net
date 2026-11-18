/**
 * The shapes CapitalWreckSubsystem.ts shares with its collaborators
 * (wreckResplit.ts, wreckBurnHits.ts) and the room: its deps, a piece spawn,
 * a live wreck, a piece's knock and wear state. Types only; the subsystem
 * re-exports them.
 */
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { Vec2 } from '../../core/swarm/asteroidShape.js';
import type { WreckDescriptor } from '../../shared-types/messages/snapshotMessages.js';
import type { WreckChildChain } from '../../core/destruction/wreckChildren.js';
import type { BurnLines } from '../../core/destruction/burnLines.js';
import type { WreckPiecePose } from './wreckResplit.js';
import type { WreckSource } from '../../core/destruction/wreckSource.js';
import type { AsteroidResourceId } from '../../shared-types/asteroidResources.js';
import type { WeaponId } from '../../core/combat/WeaponCatalogue.js';

/** Rock cut: the ore a rock's wreck carries. Every piece holds its area's
 *  share of what the rock had left when it broke (`perArea`); a pod made
 *  from one draws that through `OreDraw.cutYield` (the rock's resource). */
export interface WreckOre {
  /** The parent rock's stable id. */
  rockId: string;
  resource: AsteroidResourceId;
  /** Ore units per world unit² of piece. */
  perArea: number;
}

/** Rock cut: a live rock as the cut code reads it (`CapitalWreckDeps.rockOf`). */
export interface WreckRockView {
  /** u16 shape seed and radius (its outline: `generateAsteroidVertices`). */
  shape: number;
  radius: number;
  resource: AsteroidResourceId;
  /** Ore left in it (undefined: an un-seeded, endless rock). */
  resources: number | undefined;
}

export interface WreckPieceSpawn {
  id: string;
  x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
  /** The dead hull's kind; absent for a rock's piece (no ship byte). */
  radius: number; mass: number; parentShipKind: ShipKindId | undefined; pieceIndex: number;
  /** S2b: the wreck this piece belongs to (u16, on the binary wire). */
  wreckId: number;
  parts: ReadonlyArray<ReadonlyArray<Vec2>>;
  /** The physics collider (`WreckPieceGeometry.colliderParts`). */
  colliderParts: ReadonlyArray<ReadonlyArray<Vec2>>; linearDamping: number; angularDamping: number;
  /** Collision groups from the profile (`wreckBodyParams`): capital pieces
   *  collide with each other, sub-cap pieces don't. */
  collisionGroups: number;
  /** Settle-to-sleep thresholds from the profile (`wreckBodyParams`); 0 = off. */
  settleSpeed: number;
  settleSpin: number;
  /** Spawn the body asleep (`SwarmSpawner.spawnWreck` `sleeping`): a piece
   *  laid out at rest (a restored battle piece, a field hull). */
  sleeping?: boolean;
}

/** Where a wreck lineage came from (wreck fields plan, review 3): a ship
 *  death, rock cut or restored battle (`battle`), or an old battlefield
 *  streamed in by chunk (`field`). Set on the lineage root; every re-split
 *  child takes its root's (`addWreck`). It picks the FIFO host list
 *  (`WreckFifos`). */
export type WreckOrigin = 'battle' | 'field';

export interface LiveWreck {
  desc: WreckDescriptor;
  /** Pieces of this wreck still alive. */
  pieces: number;
  /** Every piece id spawned for it (built once at death; the worker skips
   *  the ones already gone). */
  ids: string[];
  /** Total mass of the spawned pieces. */
  mass: number;
  /** Server tick the crack hold ends (the separating kicks are due). */
  holdUntil: number;
  /** §S4: the chain these pieces are the last generation of, the parent
   *  wreck (0 = root) and its live child wrecks (refcount, `retire`). */
  chain: WreckChildChain;
  parent: number;
  children: number;
  /** Lineage: the wreckId of the root wreck (a ship death or a rock break)
   *  every re-split of this chain descends from; a root holds its own id.
   *  Set by `addWreck` / the death path, copied down on every re-split. */
  root: number;
  /** The lineage's origin (its root's; `WreckOrigin`). */
  origin: WreckOrigin;
  /** What the chain was cut from (its root's `wreckSourceOf`, kept so a
   *  hit never rebuilds it). */
  src: WreckSource;
  /** Rock cut: the rock's ore its pieces carry (absent: a ship's wreck). */
  ore?: WreckOre;
}

export interface CapitalWreckDeps {
  serverTick: () => number;
  /** The ship kind of a damage target (drone id, playerId or lingering
   *  shipInstanceId) when its death leaves wreck pieces in this room (a
   *  capital with `capitalWrecks`; a polygon sub-capital with `subcapWrecks`),
   *  else null. */
  wreckKindOf: (targetId: string) => ShipKindId | null;
  /** Who owned a dying hull (the descriptor's `owner`: the livery its
   *  pieces wear on the client): a player hull's playerId (active or
   *  parked), an NPC patrol's faction, else undefined (the kind's
   *  allegiance). Optional: absent ⇒ no owner on the wire. */
  ownerOf?: (targetId: string) => string | undefined;
  /** World position of an entity (the attacker fallback), or null. */
  positionOf: (id: string) => Vec2 | null;
  /** Spawn one wreck body; false = no free slot. */
  spawnPiece: (spec: WreckPieceSpawn) => boolean;
  /** Open / close a worker batch (`PhysicsWorkerProxy.beginBatch`): every
   *  worker command posted between them goes in ONE message, so one wreck's
   *  pieces (with the dead hull's despawn) spawn, and get their kicks, on
   *  the same physics step. Optional: absent ⇒ one message per command. */
  beginBatch?: () => void;
  endBatch?: () => void;
  /** Quietly remove a wreck body (budget cap). */
  removePiece: (id: string) => void;
  /** Is this wreck id still live? (The FIFO skips pieces gone otherwise.) */
  isLive: (id: string) => boolean;
  /** A live piece's current angle (rad), or null when it is gone. */
  pieceAngle: (id: string) => number | null;
  /** Add this velocity (world u/s) and spin (rad/s) to a live piece's body. */
  kickPiece: (id: string, dvx: number, dvy: number, dw: number) => void;
  /** Apply impulse (jx, jy) at world point (px, py) to a live piece's body
   *  (overkill knock-back). Optional: absent ⇒ hits never shove pieces. */
  impulsePiece?: (id: string, jx: number, jy: number, px: number, py: number) => void;
  /** Write a live piece's centre (world) into `out`; false when it is gone.
   *  Optional: absent ⇒ a hit always turns a piece by its full lever arm. */
  pieceCentreInto?: (id: string, out: WreckPiecePose) => boolean;
  /** Apply impulse (jx, jy) at world point (px, py) to the WHOLE wreck as one
   *  rigid body (every piece in `ids`; gone ones are skipped), so the pieces
   *  keep their relative poses: a hit during the crack hold. Optional: absent
   *  ⇒ hold hits shove single pieces like later ones. */
  impulseWreck?: (ids: readonly string[], jx: number, jy: number, px: number, py: number) => void;
  /** Is this live piece asleep (FLAG_SLEEPING)? Optional: absent ⇒ every
   *  hit shoves (no resting-piece knock gate). */
  pieceAsleep?: (id: string) => boolean;
  /** A live piece's pose and motion, or null. Absent ⇒ no re-split (§S4). */
  piecePose?: (id: string) => WreckPiecePose | null;
  /** Alloc-free `piecePose`: write a live piece's pose into `out`; false
   *  when it is gone. Absent ⇒ a cutting hit on a piece burns no line (its
   *  re-split cuts along the breaking shot only). */
  piecePoseInto?: (id: string, out: WreckPiecePose) => boolean;
  /** Write a LIVE tracked hull's pose (x, y, angle; a drone, an active or a
   *  lingering hull) into `out`; false when unknown. Absent ⇒ a cutting hit
   *  on a hull burns no line (its kill split cuts along the killing shot
   *  only). Fracture v12 multi-cut. */
  hullPoseInto?: (id: string, out: WreckPiecePose) => boolean;
  /** Drop a `qty`-unit salvage pod (a worn-out piece too small to split);
   *  with `ore` (a rock's piece) a pod of `qty` units of that rock's ore
   *  instead. Absent ⇒ such a piece just stops wearing. Returns the pod's id
   *  (the piece's locks follow it: `pieceSplit`), when it has one. `root`:
   *  the piece's lineage (`LiveWreck.root`), kept on the pod. */
  dropSalvage?: (qty: number, x: number, y: number, vx: number, vy: number, ore?: WreckOre, root?: number) => string | null | void;
  /** Rock cut: a live rock (kind 0) by id, or null. Absent ⇒ rocks are never
   *  cut (the mining laser only draws their ore). */
  rockOf?: (id: string) => WreckRockView | null;
  /** Piece or rock `parentId` broke into live pieces `ids` (`masses`
   *  parallel), the last `pods` of them ore pods (a worn-out piece: only
   *  its pod): the locks held on it follow them. Once per break. */
  pieceSplit?: (parentId: string, ids: ReadonlyArray<string>, masses: ReadonlyArray<number>, pods?: number) => void;
  /** Wreck fields 0a2c: lineage `root` changed (a wreck spawned, re-split or
   *  lost a piece, or a piece was hit). The battle-wreck save marks it dirty
   *  (`BattleWreckSaves.touch`, no allocation). Absent ⇒ nothing is saved. */
  lineageTouched?: (root: number) => void;
}

/** How hard a hit knocks one piece (fixed at spawn; read per hit, #14). */
export interface PieceKnock {
  /** The piece's mass (its body's mass). */
  mass: number;
  /** Impulse per point of damage: hull mass × `wreckKnockSpeed` ÷ max hull. */
  impulsePerDamage: number;
  /** The most one hit may change its speed (`wreckKnockMax`, u/s). */
  maxDv: number;
  /** The profile's `spinScale`: the share of the hit's lever arm that turns
   *  the piece (1: all of it). */
  spin: number;
  /** Least uncapped speed change (u/s) that wakes a RESTING piece: the
   *  profile's `knockWakeScale` × `wreckKnockMax`. 0 = every hit shoves. */
  wakeDv: number;
  /** §S4: index in its wreck's last generation; hidden integrity (never on the wire). */
  index: number;
  integrity: number;
  /** Fracture v12 multi-cut: the piece's centroid in the dead hull's scaled
   *  math-up frame (its geometry's `cx`, `cy`: where the hull's frame sits
   *  under it), its bounding radius, and its recent cutting-beam lines
   *  (null until its first cutting hit; never inherited by its children). */
  cx: number;
  cy: number;
  radius: number;
  burn: BurnLines | null;
}

/** A tracked hull's hit record (`CapitalWreckSubsystem.noteHit`, pooled). */
export interface HitEntry {
  hasPoint: boolean;
  x: number;
  y: number;
  hasDir: boolean;
  dirX: number;
  dirY: number;
  weaponId: WeaponId | null;
  lastDamage: number;
  shooterId: string;
  /** Damage per bucket; `stamp[i]` is the bucket index it holds. */
  dmg: Float64Array;
  stamp: Int32Array;
  /** Fracture v12 multi-cut: the hull's recent cutting-beam lines (null
   *  until its first cutting hit; cleared when the entry is reused). */
  burn: BurnLines | null;
}

/** `spawnWreck` options. `held`: the pieces hold together for the crack
 *  delay, then get their separating kick (else the kick is in the spawn
 *  motion). `deathTick` (default now): the descriptor's death tick and the
 *  start of the hold. `poses`: by piece index, an exact spawn pose (no
 *  kick). `skipPieces`: piece indices left out. `origin` (default
 *  `battle`): the lineage's origin, its FIFO list. `sleeping`: every piece
 *  spawns asleep (laid out at rest). `owner`: the descriptor's livery owner
 *  as given (a field hull's faction id) instead of `ownerOf`. `cool`: no
 *  `deathTick` on the descriptor (a joiner draws it long dead). */
export interface SpawnWreckOpts {
  readonly held: boolean;
  readonly owner?: string;
  readonly cool?: boolean;
  readonly origin?: WreckOrigin;
  readonly sleeping?: boolean;
  readonly deathTick?: number;
  readonly poses?: ReadonlyMap<number, WreckPiecePose>;
  readonly skipPieces?: ReadonlySet<number>;
}
