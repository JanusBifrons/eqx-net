/**
 * Owns the lifecycle + message-routing for this room's physics WORLD, hosted
 * on the shared worker pool (PhysicsWorkerPool.ts, 2026-11-07: one worker
 * per sector cost ~37 MB each before any body).
 *
 * Encapsulates:
 *   - attaching / detaching the world on the pool
 *   - the `READY` handshake (Promise resolution gate)
 *   - the `SLEEP_TRANSITION` and `CONTACT_BATCH` message routing
 *   - error / exit handlers with structured logger output
 *   - the postMessage typed-command facade (`postCommand`)
 *   - `terminate()` lifecycle hook used by `onDispose`
 *
 * The room provides the message handlers via injected callbacks so
 * SectorRoom no longer references the Worker instance directly. The
 * single-writer / single-owner contract is preserved: this is the
 * only place that constructs the Worker, the only place the room's
 * physicsWorker reference is established.
 *
 * Extracted from SectorRoom (commit 20 of v3 refactor plan).
 */

import type { Logger } from 'pino';
import type { Vec2 } from '../../core/swarm/asteroidShape.js';
import type { ForceField } from '../../core/physics/forceFields.js';
import { getPhysicsWorkerPool, type PooledWorld } from './PhysicsWorkerPool.js';

/**
 * The closed-set discriminated union of worker commands. Mirrored from
 * `src/core/CLAUDE.md` "Physics Worker — Worker→Main Message Variants"
 * (main → worker direction). Adding a new variant must touch:
 *   - this union
 *   - the worker's command-dispatch site (`src/core/physics/worker.ts`)
 *   - this header docstring
 */
export type WorkerCmd =
  | { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number; kindId?: string }
  | { type: 'DESPAWN';        slot: number; playerId: string }
  | { type: 'REKEY_SHIP';     oldId: string; newId: string }
  | { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean; warpX?: number; warpY?: number }
  | { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number; vertices?: ReadonlyArray<Vec2>; linearDamping?: number; staticBody?: boolean | 'fixed'; collisionGroups?: number; angle?: number; parts?: ReadonlyArray<ReadonlyArray<Vec2>>; shieldKindId?: string; angvel?: number; angularDamping?: number; settleSpeed?: number; settleSpin?: number; shipKindId?: number }
  | { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number; setAngvel?: number }
  /** Pilot layer: every AI slot flown by control keys this tick, in ONE
   *  message. `slots[i]` gets packed `AiInputBits` `bits[i]` for i < `count`. */
  | { type: 'AI_INPUTS';      count: number; slots: Uint16Array; bits: Uint8Array }
  | { type: 'CLOCK_RATE';     rate: number }
  | { type: 'SET_TIME_SCALE'; scale: number }
  | { type: 'SET_POSITION';   entityId: string; x: number; y: number; angle: number; vx: number; vy: number; angvel: number }
  | { type: 'WARP_RETARGET';  entityId: string; x: number; y: number }
  | { type: 'BOT_WARP';       slot: number; x?: number; y?: number }
  | { type: 'SET_HULL_EXPOSED'; id: string; exposed: boolean; kindId: string; tick: number }
  /** Phase 4 WS-B2 — set (or clear) a ship instance's per-instance PHYSICS stat
   *  multipliers (`topSpeed` / `turnRate`) on its worker body, so `applyShipInput`
   *  scales the next tick's movement by the upgraded factors. The client predWorld
   *  runs the SAME `World.setStatMultipliers` directly, so both sides clamp
   *  identically (risk #1 / invariants #4, #12). Omitting `topSpeed`/`turnRate`
   *  (both undefined) resets to the un-upgraded factors. */
  | { type: 'SET_STAT_MUL'; id: string; topSpeed?: number; turnRate?: number }
  /** Missile splash impulse. The server's MissileSimulation queues these on
   *  detonate; the SectorRoom drains the queue each tick and posts them as
   *  individual commands. The worker resolves `entityId` to a Rapier body
   *  (same id used in player→body and drone→body maps) and applies the
   *  impulse via `physics.applyImpulse(id, fx, fy, 0)`. Cleanly no-ops on
   *  despawned entities. See docs/architecture/missile-simulation.md. */
  | { type: 'MISSILE_IMPULSE'; entityId: string; fx: number; fy: number }
  | { type: 'WRECK_KICK'; entityId: string; dvx: number; dvy: number; dw: number }
  | { type: 'UNFIX_BODY'; entityId: string }
  /** A capital wreck piece's overkill knock-back: impulse (jx, jy) at world
   *  point (px, py) via `World.applyImpulseAtPoint`. */
  | { type: 'WRECK_IMPULSE'; entityId: string; jx: number; jy: number; px: number; py: number }
  /** A capital wreck inside its crack hold: the hit's impulse on the whole
   *  wreck as one rigid body via `World.applyRigidGroupImpulse`. */
  | { type: 'WRECK_RIGID_IMPULSE'; entityIds: readonly string[]; jx: number; jy: number; px: number; py: number }
  /** Shield-fence plan — manage a shield-wall span (a static cuboid between two
   *  pylon poses that blocks ships). `SET_WALL_ACTIVE` toggles its collider on
   *  stun / power loss without churning the body. See PhysicsWorld.spawnWall. */
  | { type: 'SPAWN_WALL';      id: string; ax: number; ay: number; bx: number; by: number; thickness: number }
  | { type: 'SET_WALL_ACTIVE'; id: string; active: boolean }
  | { type: 'REMOVE_WALL';     id: string }
  /** Force fields (teleporter pad push today): `World.setForceField`. Owned by
   *  `ForceFieldSubsystem`; nothing else posts these. */
  | { type: 'SET_FORCE_FIELD';    id: string; field: ForceField }
  | { type: 'REMOVE_FORCE_FIELD'; id: string }
  /** Structure-restyle 2d: attach a structure's rig solid parts
   *  (`World.attachRig`), and start / clear the clip on it (`World.setRigClip`;
   *  `startTick` in game ticks, target in the structure's frame). */
  | { type: 'RIG_ATTACH'; id: string; rigId: string }
  | { type: 'RIG_CLIP';   id: string; clipId: string | null; startTick: number; targetX?: number; targetY?: number }
  /** Several commands in ONE message, handled in order with no physics step
   *  between them (`beginBatch` / `endBatch`): one wreck's piece spawns and
   *  kicks, so every piece starts on the same step. */
  | { type: 'BATCH'; cmds: WorkerCmd[] }
;

/** Per-tick contact payload extracted from the worker's CONTACT_BATCH message.
 *  Mirrors `core/physics/contactDrain.ts` `Contact` across the postMessage
 *  boundary (structured-clone preserves every field). */
export interface ContactPayload {
  aId: string;
  bId: string;
  vAxPost: number;
  vAyPost: number;
  vBxPost: number;
  vByPost: number;
  forceMagnitude: number;
  /** Closing speed (game u/s) at impact — drives the ramming-damage gate. */
  impactSpeed?: number;
}

/** Generic worker-to-main message shape (loosely typed; the worker
 *  doesn't have a strict union today — see CLAUDE.md note). */
interface WorkerToMainMsg {
  type: string;
  worldId?: number;
  entityId?: string;
  sleeping?: boolean;
  tick?: number;
  contacts?: ContactPayload[];
  census?: unknown;
}

export interface PhysicsWorkerProxyDeps {
  /** Absolute path to the worker entry-point .ts file (bundled by esbuild). */
  workerEntryPath: string;
  /** The SAB the worker shares with the main thread for state. */
  sab: SharedArrayBuffer;
  /** Pino logger for error/exit output. */
  logger: Logger;
  /** Diagnostic shape included in error logs — read at error time. */
  stats: () => { playerCount: number; swarmCount: number };
  /** Sleep-transition handler — the room emits ENTITY_SLEPT/ENTITY_WOKE. */
  onSleepTransition: (entityId: string, sleeping: boolean) => void;
  /** Contact-batch handler — the room broadcasts collision_resolved + ramming. */
  onContactBatch: (tick: number, contacts: ContactPayload[]) => void;
}

export class PhysicsWorkerProxy {
  private world: PooledWorld | null = null;

  constructor(private readonly deps: PhysicsWorkerProxyDeps) {}

  /** This room's worker heap (shared with the other worlds on that worker),
   *  for /dev/memory. Null before start. */
  async heapStats(gc = false): Promise<{ usedBytes: number; totalBytes: number; workerIndex: number } | null> {
    const w = this.world;
    if (!w) return null;
    const h = await w.heapStats(gc);
    return h ? { ...h, workerIndex: w.workerIndex } : null;
  }

  /** Worker event-loop utilisation since `prev` (perf scenes, print-only). */
  elu(prev?: import('node:perf_hooks').EventLoopUtilization): import('node:perf_hooks').EventLoopUtilization | null {
    return this.world?.elu(prev) ?? null;
  }

  /**
   * Host this room's physics world on the shared worker pool
   * (PhysicsWorkerPool.ts). Resolves once the world is READY; rejects if it
   * isn't within 10 s.
   */
  async start(): Promise<void> {
    const pool = getPhysicsWorkerPool(this.deps.workerEntryPath, this.deps.logger);
    try {
      this.world = await pool.attach(this.deps.sab, (msg) => this.onMessage(msg));
    } catch (err) {
      this.deps.logger.error({ err, ...this.deps.stats() }, 'physics world failed to start');
      throw err;
    }
  }

  private onMessage(msg: WorkerToMainMsg): void {
    if (msg.type === 'SLEEP_TRANSITION' && typeof msg.entityId === 'string' && typeof msg.sleeping === 'boolean') {
      this.deps.onSleepTransition(msg.entityId, msg.sleeping);
    }
    if (msg.type === 'CONTACT_BATCH' && Array.isArray(msg.contacts) && typeof msg.tick === 'number') {
      this.deps.onContactBatch(msg.tick, msg.contacts);
    }
    if (msg.type === 'WAKE_CENSUS') this.lastWakeCensus = msg.census ?? null;
  }

  /** Dev-only: the latest wreck wake census (worker run with
   *  `EQX_WAKE_CENSUS=1`, `core/physics/wakeCensus.ts`); null otherwise. */
  lastWakeCensus: unknown = null;

  /** Commands held by an open batch (reused, #14) and the batch depth. */
  private readonly batchCmds: WorkerCmd[] = [];
  private readonly batchMsg: { type: 'BATCH'; cmds: WorkerCmd[] } = { type: 'BATCH', cmds: this.batchCmds };
  private batchDepth = 0;

  /** Type-safe postMessage facade — the only sanctioned path to the worker. */
  postCommand(cmd: WorkerCmd): void {
    if (this.batchDepth === 0) {
      this.world?.post(cmd);
      return;
    }
    // A sender that reuses one command object (#14) and posts it again
    // inside the batch would overwrite the held one: send what is held first.
    if (this.batchCmds.includes(cmd)) this.flushBatch();
    this.batchCmds.push(cmd);
  }

  /**
   * Hold every `postCommand` until the matching `endBatch`, then send them
   * as ONE `BATCH` message (nests; the outermost end sends). The worker
   * handles each message as its own task and may step between two, so
   * commands that must land on the same physics step (one wreck's piece
   * spawns with the dead hull's despawn; its pieces' kicks) go in one.
   * A held command is cloned only at `endBatch`: don't mutate it before.
   */
  beginBatch(): void {
    this.batchDepth++;
  }

  /** Close a `beginBatch`; the outermost one posts the held commands. */
  endBatch(): void {
    if (this.batchDepth === 0) return;
    if (--this.batchDepth === 0) this.flushBatch();
  }

  private flushBatch(): void {
    const cmds = this.batchCmds;
    if (cmds.length === 1) this.world?.post(cmds[0]!);
    // postMessage clones synchronously, so the message and list are reused.
    else if (cmds.length > 1) this.world?.post(this.batchMsg);
    cmds.length = 0;
  }

  /** Used by `onDispose`: frees this room's world (the pool worker stays). */
  terminate(): void {
    this.world?.detach();
    this.world = null;
  }
}
