/**
 * The shape of `SectorRoom._internals`, the test-only piercing surface
 * (see src/server/CLAUDE.md "Testing patterns"). Type only: the getter that
 * builds it stays in SectorRoom because it reads private fields.
 */
import type { CutFieldSubsystem } from './CutFieldSubsystem.js';
import type { WreckFieldSource } from './WreckFieldSource.js';
import type { ForceFieldSubsystem } from './ForceFieldSubsystem.js';
import type { SectorSnapshotLingeringHull } from './SectorSnapshot.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { StructureRowView } from './scenarioLayouts.js';
import type { rockViewOf } from './rockCut.js';
import type { FleetCommandSubsystem } from '../fleet/FleetCommandSubsystem.js';
import type { StructureRegistry } from '../structures/StructureRegistry.js';
import type { MineFieldSubsystem } from '../structures/MineFieldSubsystem.js';
import type { LootSubsystem } from '../cargo/LootSubsystem.js';
import type { AiPlayerView, IAiBehaviour, IAiNavRoutes } from '../../core/contracts/IAiBehaviour.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { WeaponId } from '../../core/combat/WeaponCatalogue.js';
import type { LockEntry } from '../../core/combat/lockState.js';
import type { AsteroidResourceId } from '../../shared-types/asteroidResources.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { WreckDescriptor } from '../../shared-types/messages.js';

export interface SectorRoomInternals {
  cutField: CutFieldSubsystem['streamer'] | undefined; cutFieldSub: CutFieldSubsystem | undefined; wreckFieldSource: WreckFieldSource | undefined; serverTick: number;
  /** Room update() calls so far (the AI-pilot cadence; serverTick is the
   *  physics worker's step count and can drift a step or two from it). */
  roomUpdates: number;
  /** Ticks the physics worker's catch-up cap dropped (a starved host). */
  droppedTicks: number;
  /** The shield-wall beam block the player/AI fire resolvers call. */
  blockShotAtWall: (fx: number, fy: number, dx: number, dy: number, maxDist: number, damage: number) => number | null;
  /** PR 3a — which playerId each connected session was bound to (the
   *  account-bound identity integration test asserts on it). */
  sessionToPlayer: ReadonlyMap<string, string>;
  ownerlessShips: Map<string, ReturnType<typeof setTimeout> | null>;
  /** Lingering-hull slot map (shipInstanceId → slot). Lets the resume-as-
   *  existing-ship integration test assert a lingering hull was evicted
   *  before the fresh-spawn restore (playtest 2026-06-10 Issue 6). */
  lingeringSlots: Map<string, number>; forceFields: ForceFieldSubsystem;
  /** Phase 5 (persistence v5) — drive the lingering-hull boot reconstruction
   *  directly (no DB cycle) for the round-trip integration test. */
  restoreLingeringHulls: (rows: readonly SectorSnapshotLingeringHull[]) => void;
  /** RTS — the owned ships' orders on lingering hulls. Tests issue orders
   *  through its owner-checked API (`applyOrder(ownerId, [shipId], order)`). */
  fleet: FleetCommandSubsystem;
  /** Navigation — the AI brains' routes round rock (null ⇒ turn them off, a test's baseline). */
  aiNav: { get: () => IAiNavRoutes | undefined; set: (nav: IAiNavRoutes | undefined) => void };
  /** RTS Part B — the AI pilot brain registered for an id (an owned hull's
   *  shipInstanceId or a swarm id), or null. */
  aiBrainOf: (id: string) => IAiBehaviour | null;
  /** Parked hulls' live poses (shipInstanceId → pose), refreshed each tick. */
  lingeringPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  /** RTS slice 7 — send the owner-only `fleet_status` to every client now
   *  (tests; the timer sends it every other selection-stats fire). */
  sendFleetStatus: () => void;
  aiPlayerScratch: AiPlayerView[];
  postToWorker: (cmd: WorkerCmd) => void;
  /** Fire control test hook: make `targetKey` (`s:<entityId>` | `p:<playerId>`)
   *  a completed lock of `groupId` (every group when absent) for `playerId`,
   *  so a test that isn't about locking can fire (lock-to-fire is universal).
   *  Returns how many groups took it. */
  forceLock: (playerId: string, targetKey: string, groupId?: string) => number;
  /** The weapon-group lock slice of a ship (a pilot by playerId, an AI-flown hull by shipInstanceId). */
  locksOf: (id: string) => ReadonlyArray<{ id: string; l: ReadonlyArray<{ t: string; s: number }> }> | undefined;
  /** The room damage choke point; true iff this call destroyed the target. */
  applyDamage: (
    targetId: string,
    shooterId: string,
    damage: number,
    hitX?: number,
    hitY?: number,
    dirX?: number,
    dirY?: number,
    weaponId?: WeaponId,
  ) => boolean;
  /** GEP P4 — lets the structureEntity integration test find a kind=2 record
   *  and assert it is damageable (seeded into swarmHealth). */
  swarmRegistry: {
    all(): Iterable<{ id: string; kind: number; entityId: number; shipKind?: string }>;
    get(id: string): { id: string; kind: number; entityId: number; shipKind?: string } | null | undefined;
  };
  swarmHealth: Map<string, number>;
  /** Structures plan, Phase 2 — lets the placement integration test assert
   *  the blueprint vs pre-built record state from the player-driven path. */
  structureRegistry: StructureRegistry;
  /** Structures plan, Phase 3 — drive the grid pulse deterministically (no
   *  wall-clock wait) + read the cached snapshot slice. */
  pulseStructureGrid: () => void;
  /** Test view: the pre-A2 per-structure row shape, rebuilt from room state
   *  + the targets slice (structure state no longer rides the snapshot). */
  getStructuresSlice: () => StructureRowView[] | undefined;
  /** Phase 4 WS-B4 — drive a structure UPGRADE build phase directly (no
   *  message round-trip) for the leveling integration test. Returns whether
   *  the upgrade started (the subsystem's owner-agnostic gate). */
  upgradeStructure: (id: string) => boolean;
  /** Phase 5 — drive a MANUAL reconnect (the player's structure-action) so the
   *  integration test can prove an orphaned leaf heals only on an explicit
   *  reconnect, not via the auto-sweep. Returns the subsystem's gate result. */
  reconnectStructure: (id: string) => boolean;
  /** Phase 4 — seed a mineable asteroid for the mining integration test. */
  spawnTestAsteroid: (id: string, x: number, y: number, radius: number, resource?: AsteroidResourceId) => boolean;
  /** Phase 5 — seed a drone + drive the turret tick for the turret test.
   *  `kind` (default 'fighter') lets a test seed a COMPOSITE-kind drone (e.g.
   *  'havok') to exercise scrap-on-death (Phase 2b-ii). */
  spawnTestDrone: (id: string, x: number, y: number, kind?: ShipKindId) => boolean;
  tickStructureTurrets: () => void;
  /** Mount `i`'s lock on structure `id` (for `lockTimeCapS` tests). */
  structureTurretLock: (id: string, i: number) => Readonly<LockEntry> | undefined;
  /** Fence-hit fix: spawn a bolt (integration tests aim it at a fence).
   *  `weaponId` (default 'laser') lets a test fire a real naval shell. */
  spawnTestProjectile: (ownerId: string, x: number, y: number, vx: number, vy: number, weaponId?: WeaponId, damage?: number) => void;
  /** Friendly fire — drive one AI fire (the real `handleAiFire` path). */
  aiFire: (shooterId: string, dirX: number, dirY: number, targetId: string) => void;
  /** NPC line of fire: running counts (checks, broadphase candidates, narrow tests). */
  lineOfFireCounts: () => { checks: number; candidates: number; narrow: number };
  /** NPC line of fire on/off (the slice-1 friendly fire tests turn it off). */
  setNpcLineOfFire: (on: boolean) => void;
  /** AI steering 2c: hand brains the neighbour grid (default on). */
  setAiNeighbours: (on: boolean) => void;
  /** Off ⇒ brains get no `view.debris` (no wreck-piece avoidance): A/B control. */
  setAiWreckAvoid: (on: boolean) => void;
  /** Does NPC `id`'s brain treat `otherId` as hostile (stance or ledger)? */
  npcHostileTo: (id: string, otherId: string) => boolean;
  /** Mine Layers' live mines (integration tests). */
  mineField: MineFieldSubsystem;
  /** A0 scale measurement — rebuild the structures snapshot slice directly. */
  rebuildStructuresSlice: () => void;
  /** The authoritative SAB pose of a swarm entity (null ⇒ unknown id). */
  swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
  /** v4 T2 — an active player's SAB pose and teleport epoch. */
  playerPose: (playerId: string) => { x: number; y: number; angle: number; poseEpoch: number } | null;
  /** Gates: open bits for a gate structure id. */
  gateMask: (id: string) => number;
  /** Unified-hull plan, Phase 4 — assert a structure resolves its OWN
   *  shield/hull (generic optional shield) from the STRUCTURE catalogue, not
   *  the fighter fallback. Returns the layered-damage result (reported
   *  shieldMax/hullMax drive the client stats %). */
  damageSwarmLayered: (
    rec: { id: string; entityId: number; kind?: number; shipKind?: ShipKindId | null; shieldDown?: boolean },
    damage: number,
  ) => { newShield: number; shieldMax: number; hullMax: number; hitLayer: 'shield' | 'hull' } | null;
  /** Living World P1a — the loot subsystem (seed pods, read holds, drive pickup). */
  loot: LootSubsystem;
  /** S2a — a swarm entity's full SAB state (pose, velocity, spin). */
  wreckState: (id: string) => { x: number; y: number; vx: number; vy: number; angle: number; angvel: number } | null;
  /** Salvage PR 5: a wreck piece's hidden integrity (undefined: none); its whole-piece salvage (0: none); its mass (undefined: not a live piece); rock cut's per-hit rock view (one reused object) or null. */
  wreckIntegrity: (id: string) => number | undefined; wreckSalvage: (id: string) => number; wreckMass: (id: string) => number | undefined; rockOf: (id: string) => ReturnType<typeof rockViewOf>;
  /** S2a — a wreck piece's convex parts (body-local), or null. */
  wreckParts: (id: string) => ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> | null;
  /** S2a — fix the fracture seed (null = per death). */
  setWreckSeed: (seed: number | null) => void;
  /** Sub-cap break-up slice 2 — the worker's FLAG_SLEEPING for a swarm
   *  entity (its body has slept SLEEP_HYSTERESIS_TICKS in Rapier), or null. */
  swarmSleeping: (id: string) => boolean | null;
  /** Sub-cap break-up slice 2 — live wreck piece counts (capital FIFO +
   *  sub-cap FIFO) and a smaller sub-cap cap for the eviction test. */
  wreckCounts: () => { total: number; subcap: number };
  setSubcapWreckCap: (cap: number | null) => void;
  /** S2b — the live wreck descriptors (the snapshot's `wrecks[]`). */
  wreckDescriptors: () => readonly WreckDescriptor[];
  /** Wreck fields 0a2c — write the battle-wreck lineage rows now. */
  flushWreckSaves: (all: boolean) => void;
  /** Slice 3 — remove a swarm entity the normal way (a wreck piece reaches
   *  `pieceGone`, so its wreck's descriptor retires once all are gone). */
  evictSwarm: (id: string) => void;
  /** The first non-player thing a ray meets (NPC / turret beam path). */
  rayHit: (fx: number, fy: number, dx: number, dy: number, maxDist: number, skipId: string) => { id: string; dist: number } | null;
}
