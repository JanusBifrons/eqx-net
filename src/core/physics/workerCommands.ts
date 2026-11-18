/**
 * The physics worker's command messages (main → worker): `worker.ts`
 * handles them. Keep in step with `SectorRoom.WorkerCmd` and the
 * physics-worker guide's command list (src/core/CLAUDE.md).
 */
import type { ForceField } from './forceFields.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

export interface SpawnCmd         { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number; kindId?: string }
export interface DespawnCmd       { type: 'DESPAWN';        slot: number; playerId: string }
export interface InputCmd         { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean; warpX?: number; warpY?: number }
export interface SpawnObstacleCmd { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number; vertices?: ReadonlyArray<Vec2>; linearDamping?: number; staticBody?: boolean | 'fixed'; collisionGroups?: number; angle?: number; parts?: ReadonlyArray<ReadonlyArray<Vec2>>; shieldKindId?: string; angvel?: number; angularDamping?: number; settleSpeed?: number; settleSpin?: number; shipKindId?: number; sleeping?: boolean }
export interface AiIntentCmd      { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number; setAngvel?: number }
/** Pilot layer: every AI slot driven by control keys this tick, in ONE message
 *  (replaces a post per drone). `slots[i]` flies with keys `bits[i]` (packed
 *  `AiInputBits`, see contracts/IAiBehaviour.ts) for i < `count`; entries past
 *  `count` are stale capacity and ignored. */
export interface AiInputsCmd      { type: 'AI_INPUTS';      count: number; slots: Uint16Array; bits: Uint8Array }
export interface ClockRateCmd     { type: 'CLOCK_RATE';     rate: number }
/** Authoritatively reposition a body in the physics world. Used by the
 *  Phase-1 drone position-clamp backstop in `SectorRoom`: when a drone
 *  drifts past `MAX_BOUNDS` (well outside the playable region), the room
 *  posts this command to teleport the body back in-bounds and zero its
 *  velocity. Single-writer rule: only the worker mutates SAB pose; this
 *  command is the only path the main thread has to override it. */
export interface SetPositionCmd   { type: 'SET_POSITION';   entityId: string; x: number; y: number; angle: number; vx: number; vy: number; angvel: number }
/** Warp travel: move a running warp's drop point (the server lands a ship at the
 *  nearest clear spot when its drop point is blocked). Server-only. */
export interface WarpRetargetCmd { type: 'WARP_RETARGET'; entityId: string; x: number; y: number }
/** NPC warp-to (W2a): hold a bot's warp target (x/y absent = drop the
 *  request). While the warp owns the body its AI intents are skipped. */
export interface BotWarpCmd      { type: 'BOT_WARP'; slot: number; x?: number; y?: number }
/** Rename a ship body's lookup key without destroying it. Used by the
 *  fresh-spawn-displace flow so a displaced hull's body outlives its
 *  original playerId (rekeyed to `linger-${shipInstanceId}`) on rejoin. */
export interface RekeyShipCmd     { type: 'REKEY_SHIP';     oldId: string; newId: string }
/** Shield 0-cross collider swap (shield/hull refactor). `kindId` is carried
 *  in the command (server-authoritative) so the worker needs no per-id kind
 *  map; `getShipKind` is forgiving on unknown ids. See World.setHullExposed. */
export interface SetHullExposedCmd { type: 'SET_HULL_EXPOSED'; id: string; exposed: boolean; kindId: string; tick: number }
/** Phase 4 WS-B2 — set a ship instance's per-instance PHYSICS stat multipliers
 *  (`topSpeed`/`turnRate`) on its worker body. `applyShipInput` reads them next
 *  tick so movement scales by the upgraded factors. Both factors undefined ⇒
 *  reset to the un-upgraded path. The client predWorld runs the same setter so
 *  prediction stays in lockstep. */
export interface SetStatMulCmd     { type: 'SET_STAT_MUL'; id: string; topSpeed?: number; turnRate?: number }
/** Missile splash impulse. MissileSimulation queues these on detonate; the
 *  SectorRoom drains the queue and posts them; this dispatcher resolves the
 *  entityId to a Rapier body and applies the linear impulse. Silent no-op
 *  on despawned entities (drones killed before the impulse lands). */
export interface MissileImpulseCmd { type: 'MISSILE_IMPULSE'; entityId: string; fx: number; fy: number }
/** Capital wreck: add a velocity (u/s) and spin (rad/s) to a piece's body (its
 *  separating kick once the crack delay is over). Silent no-op when gone. */
export interface WreckKickCmd { type: 'WRECK_KICK'; entityId: string; dvx: number; dvy: number; dw: number }
/** A fixed body (cut-field rock) becomes dynamic: a ship rammed it. */
export interface UnfixBodyCmd { type: 'UNFIX_BODY'; entityId: string }
/** Capital wreck: an overkill hit's impulse (jx, jy) at world point (px, py)
 *  on a piece, so an off-centre hit also turns it. Silent no-op when gone. */
export interface WreckImpulseCmd { type: 'WRECK_IMPULSE'; entityId: string; jx: number; jy: number; px: number; py: number }
/** Capital wreck still inside its crack hold: an overkill hit's impulse
 *  (jx, jy) at world point (px, py) on the WHOLE wreck as one rigid body
 *  (every piece in `entityIds`), so the pieces keep their relative poses
 *  (`World.applyRigidGroupImpulse`). Gone ids are skipped. */
export interface WreckRigidImpulseCmd { type: 'WRECK_RIGID_IMPULSE'; entityIds: readonly string[]; jx: number; jy: number; px: number; py: number }
/** Shield-fence plan — spawn / toggle / remove a shield-wall span. A static
 *  cuboid between two pylon poses that blocks ships; toggled on stun / power
 *  loss without churning the body. See PhysicsWorld.spawnWall. */
export interface SpawnWallCmd      { type: 'SPAWN_WALL';      id: string; ax: number; ay: number; bx: number; by: number; thickness: number }
export interface SetWallActiveCmd  { type: 'SET_WALL_ACTIVE'; id: string; active: boolean }
export interface RemoveWallCmd     { type: 'REMOVE_WALL';     id: string }
/** Force fields (teleporter pad push today; PhysicsWorld.setForceField, forceFields.ts). */
export interface SetForceFieldCmd    { type: 'SET_FORCE_FIELD';    id: string; field: ForceField }
export interface RemoveForceFieldCmd { type: 'REMOVE_FORCE_FIELD'; id: string }
/** Structure-restyle 2d: give a structure body its rig's solid parts
 *  (`PhysicsWorld.attachRig`, rig from `rigById`), and start / clear the clip
 *  playing on it (`setRigClip`; game ticks, target in the host frame). */
export interface RigAttachCmd { type: 'RIG_ATTACH'; id: string; rigId: string }
export interface RigClipCmd   { type: 'RIG_CLIP';   id: string; clipId: string | null; startTick: number; targetX?: number; targetY?: number }
export interface BatchCmd { type: 'BATCH'; cmds: WorkerCommand[] } // in order, no step between (one wreck's pieces)
export type WorkerCommand = SpawnCmd | DespawnCmd | InputCmd | SpawnObstacleCmd | AiIntentCmd | AiInputsCmd | ClockRateCmd | SetPositionCmd | WarpRetargetCmd | RekeyShipCmd | SetHullExposedCmd | SetStatMulCmd | MissileImpulseCmd | WreckKickCmd | UnfixBodyCmd | WreckImpulseCmd | WreckRigidImpulseCmd | SpawnWallCmd | SetWallActiveCmd | RemoveWallCmd | SetForceFieldCmd | RemoveForceFieldCmd | RigAttachCmd | RigClipCmd | BotWarpCmd | SetTimeScaleCmd | BatchCmd;

/** Pool commands (main → pooled worker): host / free one sector's world. */
export interface AddWorldCmd    { type: 'ADD_WORLD'; worldId: number; sab: SharedArrayBuffer }
export interface RemoveWorldCmd { type: 'REMOVE_WORLD'; worldId: number }
/** Dev diagnostics (`/dev/memory?gc=1`): collect garbage now, so a heap
 *  reading shows what is live. Needs the process started with --expose-gc;
 *  otherwise a no-op. */
export interface GcCmd          { type: 'GC' }
/** Game speed of ONE world (time scale stream; speed is per sector). The world
 *  runs 60 × scale fixed ticks per wall second; each is still one 1/60 s step. */
export interface SetTimeScaleCmd { type: 'SET_TIME_SCALE'; scale: number }
