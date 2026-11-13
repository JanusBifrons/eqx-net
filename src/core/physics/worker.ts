/**
 * Physics worker — runs Rapier at 60 Hz in a dedicated worker_threads thread.
 *
 * Communication contract with the main thread (SectorRoom):
 *   Main → Worker  postMessage commands: SPAWN | DESPAWN | INPUT | SPAWN_OBSTACLE | AI_INTENT | CLOCK_RATE | SET_POSITION | REKEY_SHIP | SET_HULL_EXPOSED
 *   Worker → Main  postMessage events:   READY | SLEEP_TRANSITION
 *   Shared memory  SharedArrayBuffer (see sabLayout.ts) — written here under seqlock,
 *                  read by main thread between writes.
 *
 * Phase 5 additions:
 *   - AI_INTENT applies an impulse + torque to a swarm body, identical to player INPUT.
 *   - Sleep is polled per occupied slot each step, with 12-tick hysteresis to
 *     suppress flap on slow-drift entities. On idle→sleep transitions the
 *     worker sets FLAG_SLEEPING in the slot AND posts a SLEEP_TRANSITION
 *     message so the main thread can fire the discrete bus event.
 *
 * Phase 6 additions:
 *   - CLOCK_RATE command carries a TiDi rate (0.7..1.0). The worker writes it
 *     to the SAB header (CLOCK_RATE_IDX) and uses it to scale the accumulator
 *     input on each step: physics.tick(FIXED_DT * rate). Rapier's per-step dt
 *     stays fixed — only how much wall-clock time accumulates per step is
 *     scaled. This preserves deterministic collision behaviour at all rates.
 */
import { parentPort, workerData } from 'node:worker_threads';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from './World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { tickInputQueue, type QueuedInput } from './inputQueue.js';
import { drainContacts } from './contactDrain.js';
import { advanceSchedule, tickPeriodMs, type CatchUpResult } from './catchUp.js';
import type { Vec2 } from '../swarm/asteroidShape.js';
import {
  SEQLOCK_IDX,
  TICK_IDX,
  COUNT_IDX,
  CLOCK_RATE_IDX,
  CLOCK_RATE_SCALE,
  WORKER_TICK_US_IDX,
  WORKER_DROPPED_TICKS_IDX,
  SLOT_ID_OFF,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  SLOT_APPLIED_TICK_OFF,
  SLOT_FLAGS_OFF,
  FLAG_SLEEPING,
  FLAG_INPUT_THRUST,
  FLAG_INPUT_TURN_LEFT,
  FLAG_INPUT_TURN_RIGHT,
  FLAG_INPUT_BOOST,
  FLAG_INPUT_REVERSE,
  INPUT_FLAGS_MASK,
  FLAG_WARP_SPOOL,
  FLAG_WARP_CRUISE,
  slotBase,
} from '../../shared-types/sabLayout.js';

const TICK_MS = 1000 / 60;
/** Ticks a body must report sleeping consecutively before FLAG_SLEEPING is set.
 *  Suppresses flap on slow-drift entities under rapier2d-compat's threshold. */
const SLEEP_HYSTERESIS_TICKS = 12;
/** Stage 2 — minimum contact-force magnitude (N) to broadcast as a CONTACT
 *  event. ~200 N at the 60 Hz step ≈ 3.3 N·s impulse, which catches every
 *  meaningful ship-vs-asteroid / ship-vs-drone collision but filters out
 *  drone-drone soft touches and minor jostling at rest. The collider's own
 *  contactForceEventThreshold (10 N) pre-filters at the engine level; this
 *  is the meaningful network-traffic gate. */
const CONTACT_FORCE_FLOOR = 200;

interface SpawnCmd         { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number; kindId?: string }
interface DespawnCmd       { type: 'DESPAWN';        slot: number; playerId: string }
interface InputCmd         { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean; warpX?: number; warpY?: number }
interface SpawnObstacleCmd { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number; vertices?: ReadonlyArray<Vec2>; linearDamping?: number; staticBody?: boolean; collisionGroups?: number; angle?: number; parts?: ReadonlyArray<ReadonlyArray<Vec2>>; shieldKindId?: string; angvel?: number; angularDamping?: number }
interface AiIntentCmd      { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number; setAngvel?: number }
interface ClockRateCmd     { type: 'CLOCK_RATE';     rate: number }
/** Authoritatively reposition a body in the physics world. Used by the
 *  Phase-1 drone position-clamp backstop in `SectorRoom`: when a drone
 *  drifts past `MAX_BOUNDS` (well outside the playable region), the room
 *  posts this command to teleport the body back in-bounds and zero its
 *  velocity. Single-writer rule: only the worker mutates SAB pose; this
 *  command is the only path the main thread has to override it. */
interface SetPositionCmd   { type: 'SET_POSITION';   entityId: string; x: number; y: number; angle: number; vx: number; vy: number; angvel: number }
/** Warp travel: move a running warp's drop point (the server lands a ship at the
 *  nearest clear spot when its drop point is blocked). Server-only. */
interface WarpRetargetCmd { type: 'WARP_RETARGET'; entityId: string; x: number; y: number }
/** NPC warp-to (W2a): hold a bot's warp target (x/y absent = drop the
 *  request). While the warp owns the body its AI intents are skipped. */
interface BotWarpCmd      { type: 'BOT_WARP'; slot: number; x?: number; y?: number }
/** Rename a ship body's lookup key without destroying it. Used by the
 *  fresh-spawn-displace flow so a displaced hull's body outlives its
 *  original playerId (rekeyed to `linger-${shipInstanceId}`) on rejoin. */
interface RekeyShipCmd     { type: 'REKEY_SHIP';     oldId: string; newId: string }
/** Shield 0-cross collider swap (shield/hull refactor). `kindId` is carried
 *  in the command (server-authoritative) so the worker needs no per-id kind
 *  map; `getShipKind` is forgiving on unknown ids. See World.setHullExposed. */
interface SetHullExposedCmd { type: 'SET_HULL_EXPOSED'; id: string; exposed: boolean; kindId: string; tick: number }
/** Phase 4 WS-B2 — set a ship instance's per-instance PHYSICS stat multipliers
 *  (`topSpeed`/`turnRate`) on its worker body. `applyShipInput` reads them next
 *  tick so movement scales by the upgraded factors. Both factors undefined ⇒
 *  reset to the un-upgraded path. The client predWorld runs the same setter so
 *  prediction stays in lockstep. */
interface SetStatMulCmd     { type: 'SET_STAT_MUL'; id: string; topSpeed?: number; turnRate?: number }
/** Missile splash impulse. MissileSimulation queues these on detonate; the
 *  SectorRoom drains the queue and posts them; this dispatcher resolves the
 *  entityId to a Rapier body and applies the linear impulse. Silent no-op
 *  on despawned entities (drones killed before the impulse lands). */
interface MissileImpulseCmd { type: 'MISSILE_IMPULSE'; entityId: string; fx: number; fy: number }
/** Capital wreck: add a velocity (u/s) and spin (rad/s) to a piece's body (its
 *  separating kick once the crack delay is over). Silent no-op when gone. */
interface WreckKickCmd { type: 'WRECK_KICK'; entityId: string; dvx: number; dvy: number; dw: number }
/** Capital wreck: an overkill hit's impulse (jx, jy) at world point (px, py)
 *  on a piece, so an off-centre hit also turns it. Silent no-op when gone. */
interface WreckImpulseCmd { type: 'WRECK_IMPULSE'; entityId: string; jx: number; jy: number; px: number; py: number }
/** Shield-fence plan — spawn / toggle / remove a shield-wall span. A static
 *  cuboid between two pylon poses that blocks ships; toggled on stun / power
 *  loss without churning the body. See PhysicsWorld.spawnWall. */
interface SpawnWallCmd      { type: 'SPAWN_WALL';      id: string; ax: number; ay: number; bx: number; by: number; thickness: number }
interface SetWallActiveCmd  { type: 'SET_WALL_ACTIVE'; id: string; active: boolean }
interface RemoveWallCmd     { type: 'REMOVE_WALL';     id: string }
/** v4 T2 — a teleporter pad's closing-iris push (PhysicsWorld.setPadField). */
interface SetPadFieldCmd    { type: 'SET_PAD_FIELD';   id: string; cx: number; cy: number; half: number; active: boolean }
interface RemovePadFieldCmd { type: 'REMOVE_PAD_FIELD'; id: string }
type WorkerCommand = SpawnCmd | DespawnCmd | InputCmd | SpawnObstacleCmd | AiIntentCmd | ClockRateCmd | SetPositionCmd | WarpRetargetCmd | RekeyShipCmd | SetHullExposedCmd | SetStatMulCmd | MissileImpulseCmd | WreckKickCmd | WreckImpulseCmd | SpawnWallCmd | SetWallActiveCmd | RemoveWallCmd | SetPadFieldCmd | RemovePadFieldCmd | BotWarpCmd | SetTimeScaleCmd;

/** Pool commands (main → pooled worker): host / free one sector's world. */
interface AddWorldCmd    { type: 'ADD_WORLD'; worldId: number; sab: SharedArrayBuffer }
interface RemoveWorldCmd { type: 'REMOVE_WORLD'; worldId: number }
/** Dev diagnostics (`/dev/memory?gc=1`): collect garbage now, so a heap
 *  reading shows what is live. Needs the process started with --expose-gc;
 *  otherwise a no-op. */
interface GcCmd          { type: 'GC' }
/** Game speed of ONE world (time scale stream; speed is per sector). The world
 *  runs 60 × scale fixed ticks per wall second; each is still one 1/60 s step. */
interface SetTimeScaleCmd { type: 'SET_TIME_SCALE'; scale: number }

/** One sector's simulation: its Rapier world, input queues and SAB writer. */
interface WorldHandle {
  handle(cmd: WorkerCommand): void;
  /** Step once if this world's next tick is due at `now` (wall ms), on its own
   *  schedule (60 × its game speed per wall second). Returns whether it stepped. */
  pump(now: number): boolean;
  dispose(): void;
}

/**
 * Build one sector world over its SAB. `post` sends a worker→main message
 * for THIS world (a pooled worker tags it with the world id). Everything a
 * world owns lives in this closure, so one worker can host several
 * (memory: one V8 isolate + one code copy per worker, not per sector).
 */
async function createWorld(sab: SharedArrayBuffer, post: (msg: { type: string; [k: string]: unknown }) => void): Promise<WorldHandle> {
  const u32 = new Uint32Array(sab);
  const f32 = new Float32Array(sab);
  // This world's tick schedule (time scale stream): 60 × its game speed per
  // wall second, set by SET_TIME_SCALE. Pumped by the worker loop.
  let tickMs = tickPeriodMs(1);
  let nextTickAt = performance.now();
  const schedule: CatchUpResult = { nextTickAt, dropped: 0 };

  const physics = await PhysicsWorld.create();
  // Stage 2 — Rapier event queue persists across all `world.step()` calls;
  // drained once per tick after the SAB write window. `true` enables contact-
  // force events alongside collision-start/stop events.
  const eventQueue = new RAPIER.EventQueue(true);
  const playerToSlot = new Map<string, number>();
  const slotToPlayer = new Map<number, string>();
  // FIFO input queue per slot. Each client input is enqueued and dequeued exactly
  // once, one per physics step. This keeps ackedTick = serverTick - 1 so the
  // reconciler replays the correct number of steps and achieves near-zero drift.
  // The overwrite-latest model caused ackedTick to jump 15+ ticks ahead of
  // serverTick, leaving the reconciler replaying only 1 step instead of ~16.
  const inputQueues = new Map<number, QueuedInput[]>();
  const lastApplied = new Map<number, QueuedInput>();
  /** Per-slot ack tick — the highest client input tick the worker has reported
   *  as applied via SAB. Persists across steps. The dequeue path sets it to
   *  the message's tick; the held-input path advances it by 1 each step.
   *  See `inputQueue.ts` for the contract and `docs/LESSONS.md` (2026-05-06)
   *  for why this is load-bearing. */
  const lastAckTick = new Map<number, number>();
  /** Pending AI intents per slot, applied once on the next physics step then cleared. */
  const aiIntents = new Map<number, { fx: number; fy: number; torque: number; setAngvel?: number }>();
  /** NPC warp-to: slot → held target (`on` false = request dropped, kept
   *  until the warp is idle so a run in progress finishes). */
  const botWarps = new Map<number, { x: number; y: number; on: boolean }>();
  /** Per-slot consecutive-sleep counter; FLAG_SLEEPING is written when this >= hysteresis. */
  const sleepCount = new Map<number, number>();
  /** Per-slot last-broadcast sleep flag, used to detect transitions for SLEEP_TRANSITION. */
  const sleepState = new Map<number, boolean>();
  /** Per-entity velocity AS OF THE END OF THE PREVIOUS TICK = this tick's
   *  pre-step (approach) velocity. `drainContacts` reads this to compute each
   *  contact's impact (closing) speed. Repopulated from `allStates` at the tail
   *  of every tick; value objects are reused (no per-tick allocation, #14). */
  const prevVel = new Map<string, { vx: number; vy: number }>();
  let tick = 0;

  const handle = (cmd: WorkerCommand): void => {
    switch (cmd.type) {
      case 'SPAWN': {
        physics.spawnShip(cmd.playerId, cmd.x, cmd.y, cmd.kindId);
        playerToSlot.set(cmd.playerId, cmd.slot);
        slotToPlayer.set(cmd.slot, cmd.playerId);
        break;
      }
      case 'DESPAWN': {
        physics.despawnShip(cmd.playerId);
        playerToSlot.delete(cmd.playerId);
        slotToPlayer.delete(cmd.slot);
        inputQueues.delete(cmd.slot);
        lastApplied.delete(cmd.slot);
        lastAckTick.delete(cmd.slot);
        aiIntents.delete(cmd.slot);
        botWarps.delete(cmd.slot);
        sleepCount.delete(cmd.slot);
        sleepState.delete(cmd.slot);
        // Mark slot empty in SAB.
        u32[slotBase(cmd.slot) + SLOT_ID_OFF] = 0;
        u32[slotBase(cmd.slot) + SLOT_FLAGS_OFF] = 0;
        break;
      }
      case 'REKEY_SHIP': {
        // Fresh-spawn-displace flow. Move a ship's lookup key from
        // `oldId` (playerId) to `newId` (linger-${shipInstanceId})
        // without destroying the underlying Rapier body. Without this,
        // when the same player rejoins, `spawnShip(playerId, ...)`
        // would overwrite `physics.bodies[playerId]` and orphan the
        // displaced body (still in Rapier but invisible to the SAB writer,
        // so its pose stops being broadcast and the client renders it
        // at a stale position while server-side collisions still hit
        // an invisible body at the real position).
        physics.rekeyShip(cmd.oldId, cmd.newId);
        // Re-key the per-slot maps too. The slot stays the same; only
        // the identity changes. inputQueues / lastApplied / lastAckTick
        // / aiIntents are slot-keyed so they're unaffected. The slot's
        // `lastApplied` is cleared so a stale held-input doesn't keep
        // applying impulses to the now-ownerless body.
        const slot = playerToSlot.get(cmd.oldId);
        if (slot !== undefined) {
          playerToSlot.delete(cmd.oldId);
          playerToSlot.set(cmd.newId, slot);
          slotToPlayer.set(slot, cmd.newId);
          lastApplied.delete(slot);
        }
        break;
      }
      case 'INPUT': {
        let q = inputQueues.get(cmd.slot);
        if (!q) { q = []; inputQueues.set(cmd.slot, q); }
        // Cap queue to prevent unbounded growth if client briefly outruns physics.
        if (q.length < 20) {
          q.push({ tick: cmd.inputTick, thrust: cmd.thrust, turnLeft: cmd.turnLeft, turnRight: cmd.turnRight, boost: cmd.boost, reverse: cmd.reverse, warpX: cmd.warpX, warpY: cmd.warpY });
        }
        break;
      }
      case 'SPAWN_OBSTACLE': {
        physics.spawnObstacle(cmd.obstacleId, cmd.x, cmd.y, cmd.radius, cmd.mass, cmd.vertices, cmd.linearDamping, cmd.collisionGroups, cmd.parts, cmd.shieldKindId ? getShipKind(cmd.shieldKindId) : undefined);
        // SCRAP (scrap-on-death) must spawn at the dying ship's angle so its
        // recentred collider is oriented correctly; `cmd.angle ?? 0` keeps
        // every existing caller (asteroids/drones/structures pass undefined)
        // on the legacy axis-aligned spawn. Apply when either velocity OR a
        // non-zero angle needs to be written.
        if (cmd.vx !== 0 || cmd.vy !== 0 || (cmd.angle ?? 0) !== 0 || (cmd.angvel ?? 0) !== 0) {
          physics.setShipState(cmd.obstacleId, { x: cmd.x, y: cmd.y, angle: cmd.angle ?? 0, vx: cmd.vx, vy: cmd.vy, ...(cmd.angvel !== undefined ? { angvel: cmd.angvel } : {}) });
        }
        // Capital wreck pieces (S2a) spin down and settle into terrain.
        if (cmd.angularDamping !== undefined) physics.setAngularDamping(cmd.obstacleId, cmd.angularDamping);
        // P3.10 (P0) — STRUCTURES (kind 2) lock their body so a ram can't impart
        // velocity. Mirrors the client predWorld (`structureClientLeaf` does
        // `spawnObstacle` + `lockBody`); the server worker is where the
        // authoritative body lived UNLOCKED, so a hit drifted it forever (no
        // friction). Drones + asteroids stay dynamic.
        if (cmd.staticBody) physics.lockBody(cmd.obstacleId);
        playerToSlot.set(cmd.obstacleId, cmd.slot);
        slotToPlayer.set(cmd.slot, cmd.obstacleId);
        break;
      }
      case 'BOT_WARP': {
        let r = botWarps.get(cmd.slot);
        if (!r) { r = { x: 0, y: 0, on: false }; botWarps.set(cmd.slot, r); }
        if (cmd.x !== undefined && cmd.y !== undefined) { r.x = cmd.x; r.y = cmd.y; r.on = true; } else r.on = false;
        break;
      }
      case 'AI_INTENT': {
        // Coalesce: latest intent wins for this slot; one impulse per step.
        aiIntents.set(cmd.slot, {
          fx: cmd.fx,
          fy: cmd.fy,
          torque: cmd.torque,
          setAngvel: cmd.setAngvel,
        });
        break;
      }
      case 'SET_TIME_SCALE': {
        tickMs = tickPeriodMs(cmd.scale);
        break;
      }
      case 'CLOCK_RATE': {
        // TiDi rate update from the server. Single-writer for CLOCK_RATE_IDX;
        // the read happens at the top of step() and scales the accumulator input.
        const scaled = Math.max(0, Math.round(cmd.rate * CLOCK_RATE_SCALE)) | 0;
        u32[CLOCK_RATE_IDX] = scaled;
        break;
      }
      case 'SET_POSITION': {
        // Authoritative teleport — used by SectorRoom's drone position-clamp
        // backstop to pull runaway drones back inside `MAX_BOUNDS`. Same path
        // SPAWN_OBSTACLE uses for non-zero spawn velocity.
        physics.setShipState(cmd.entityId, {
          x: cmd.x, y: cmd.y, angle: cmd.angle,
          vx: cmd.vx, vy: cmd.vy, angvel: cmd.angvel,
        });
        break;
      }
      case 'WARP_RETARGET': {
        physics.retargetWarp(cmd.entityId, cmd.x, cmd.y);
        break;
      }
      case 'SET_HULL_EXPOSED': {
        // Shield 0-cross collider swap. kindId is server-authoritative
        // (carried in the command) so no per-id kind map is needed here.
        physics.setHullExposed(cmd.id, cmd.exposed, getShipKind(cmd.kindId));
        break;
      }
      case 'SET_STAT_MUL': {
        // Phase 4 WS-B2 — per-instance physics stat multipliers. Both factors
        // undefined ⇒ reset to the un-upgraded path. Silent no-op on unknown
        // ids (a stale post after despawn is harmless).
        const hasMul = cmd.topSpeed !== undefined || cmd.turnRate !== undefined;
        physics.setStatMultipliers(
          cmd.id,
          hasMul ? { topSpeed: cmd.topSpeed ?? 1, turnRate: cmd.turnRate ?? 1 } : undefined,
        );
        break;
      }
      case 'MISSILE_IMPULSE': {
        // Missile splash impulse. Linear-only (zero torque); the missile
        // subsystem decides direction from the detonation-target vector.
        // `applyImpulse` silently skips unknown ids — safe for the race
        // where a drone died between detonate and apply.
        physics.applyImpulse(cmd.entityId, cmd.fx, cmd.fy, 0);
        break;
      }
      case 'WRECK_KICK': {
        physics.addVelocity(cmd.entityId, cmd.dvx, cmd.dvy, cmd.dw);
        break;
      }
      case 'WRECK_IMPULSE': {
        physics.applyImpulseAtPoint(cmd.entityId, cmd.jx, cmd.jy, cmd.px, cmd.py);
        break;
      }
      case 'SPAWN_WALL': {
        physics.spawnWall(cmd.id, cmd.ax, cmd.ay, cmd.bx, cmd.by, cmd.thickness);
        break;
      }
      case 'SET_WALL_ACTIVE': {
        physics.setWallActive(cmd.id, cmd.active);
        break;
      }
      case 'REMOVE_WALL': {
        physics.removeWall(cmd.id);
        break;
      }
      case 'SET_PAD_FIELD': {
        physics.setPadField(cmd.id, cmd.cx, cmd.cy, cmd.half, cmd.active);
        break;
      }
      case 'REMOVE_PAD_FIELD': {
        physics.removePadField(cmd.id);
        break;
      }
    }
  };

  // Per-step scratch (campaign 1.4, invariant #14): `step()` is the 60 Hz hot
  // loop — these were `new Map()` / `[]` + per-transition literals allocated
  // EVERY step. Reused across steps: the map clears at step top; the
  // transition records pool grows to the (tiny) high-water mark of
  // simultaneous sleep flips and is length-tracked by `transitionCount`.
  const appliedTicks = new Map<number, number>(); // slot → inputTick
  const transitionScratch: Array<{ id: string; sleeping: boolean }> = [];
  let transitionCount = 0;
  const step = (): void => {
    const tStepStart = performance.now();
    // Per-slot input dequeue + held-input synthesis. The pure logic lives in
    // `inputQueue.ts` so the contract is unit-testable.
    appliedTicks.clear();
    for (const [slot, q] of inputQueues) {
      const playerId = slotToPlayer.get(slot);
      if (!playerId) continue;
      // Tick-gated: only drain inputs whose claimedTick has been reached
      // by the sim. `tick` is the count of completed ticks at this point;
      // the upcoming physics step processes from state s_tick to s_(tick+1).
      // Inputs claiming tick > `tick` are for future steps and stay queued.
      const result = tickInputQueue(slot, q, lastApplied, lastAckTick, tick);
      if (result.applied) physics.applyInput(playerId, result.applied);
      if (result.ackTick !== null) {
        appliedTicks.set(slot, result.ackTick);
        // Self-detection invariant: with the gate, ackTick must never
        // exceed the upcoming sim tick (`tick + 1`, since the snapshot
        // emitted after this step reports serverTick = tick + 1).
        // If this ever fires, either the gate regressed or some other
        // path is mutating lastAckTick. Sample to 5% so a regression
        // surfaces visibly without spamming the log under sustained
        // failure.
        if (result.ackTick > tick + 1 && Math.random() < 0.05) {
          // eslint-disable-next-line no-console
          console.warn(
            `[worker] INVARIANT: ack ${result.ackTick} ahead of simTick ${tick + 1} (slot ${slot}, excess ${result.ackTick - (tick + 1)})`,
          );
        }
      }
    }

    // Apply pending AI intents (one per slot per step). Drained after application.
    // `setAngvel` runs BEFORE `applyImpulse`'s torque term so a behaviour
    // that wants player-equivalent snap-turn just sets the target angvel
    // and leaves `torque = 0`. (Setting both is allowed but redundant.)
    // NPC warp-to first: while a warp owns a bot's body its intent is dropped.
    for (const [slot, r] of botWarps) {
      const id = slotToPlayer.get(slot);
      if (id === undefined) { botWarps.delete(slot); continue; }
      if (physics.botWarp(id, r.on ? r : null)) { aiIntents.delete(slot); continue; }
      // Idle: arrived (or cancelled). Clear the latch and forget the slot.
      if (!r.on || physics.warpArrived(id)) { physics.botWarp(id, null); botWarps.delete(slot); }
    }
    for (const [slot, intent] of aiIntents) {
      const id = slotToPlayer.get(slot);
      if (id === undefined) continue;
      if (intent.setAngvel !== undefined) physics.setShipAngvel(id, intent.setAngvel);
      physics.applyImpulse(id, intent.fx, intent.fy, intent.torque);
    }
    aiIntents.clear();

    // Always step by the nominal fixed dt regardless of actual elapsed time.
    // Using actual elapsed time causes the accumulator to occasionally produce
    // 0 or 2 steps instead of 1, diverging from the client's prediction world
    // which always steps exactly once per input-loop tick.
    //
    // Phase 6: scale by clockRate. At rate=0.7 the accumulator gains 0.7 *
    // (1/60) ≈ 11.67 ms per tick — below FIXED_DT — so some ticks step zero
    // times and others step once, producing 70% net simulation progression
    // without changing Rapier's per-step dt.
    const rawRate = u32[CLOCK_RATE_IDX] ?? 0;
    const clockRate = rawRate === 0 ? 1.0 : rawRate / CLOCK_RATE_SCALE;
    physics.tick((TICK_MS / 1000) * clockRate, eventQueue);
    tick++;

    // Compute sleep transitions before SAB write so the flag word is current.
    // SLEEP_TRANSITION messages buffer here; flushed after the seqlock window.
    transitionCount = 0;
    for (const [slot, id] of slotToPlayer) {
      const sleeping = physics.isSleeping(id);
      const prev = sleepCount.get(slot) ?? 0;
      const next = sleeping ? prev + 1 : 0;
      sleepCount.set(slot, next);

      const effectiveSleeping = next >= SLEEP_HYSTERESIS_TICKS;
      const lastReported = sleepState.get(slot) ?? false;
      if (effectiveSleeping !== lastReported) {
        sleepState.set(slot, effectiveSleeping);
        let rec = transitionScratch[transitionCount];
        if (!rec) {
          rec = { id: '', sleeping: false };
          transitionScratch.push(rec);
        }
        rec.id = id;
        rec.sleeping = effectiveSleeping;
        transitionCount++;
      }
    }

    // Write all entity states to SAB under seqlock.
    Atomics.add(u32, SEQLOCK_IDX, 1); // lock — value becomes odd

    const allStates = physics.getAllShipStates();
    for (const [playerId, s] of allStates) {
      const slot = playerToSlot.get(playerId);
      if (slot === undefined) continue;
      const base = slotBase(slot);
      u32[base + SLOT_ID_OFF] = slot + 1; // non-zero = occupied
      f32[base + SLOT_X_OFF]  = s.x;
      f32[base + SLOT_Y_OFF]  = s.y;
      f32[base + SLOT_VX_OFF] = s.vx;
      f32[base + SLOT_VY_OFF] = s.vy;
      f32[base + SLOT_ANGLE_OFF]  = s.angle;
      f32[base + SLOT_ANGVEL_OFF] = s.angvel ?? 0;
      // inputTick+1 encoding: 0 = no input applied yet; N+1 = tick N was applied.
      const appliedTick = appliedTicks.get(slot);
      if (appliedTick !== undefined) {
        u32[base + SLOT_APPLIED_TICK_OFF] = appliedTick + 1;
      }
      // Update FLAG_SLEEPING in place. Other flag bits (IS_SWARM, KIND_DRONE)
      // are owned by the main thread and only written via SAB on spawn.
      const prevFlags = u32[base + SLOT_FLAGS_OFF] ?? 0;
      const slept = sleepState.get(slot) ?? false;
      let nextFlags = slept ? prevFlags | FLAG_SLEEPING : prevFlags & ~FLAG_SLEEPING;
      // Stage 3 (network-feel roadmap) — mirror the last-applied input bits
      // into the FLAGS word so the main thread can publish them in the
      // snapshot's per-ship `lastInput`. Clear the input region first, then
      // OR in the active bits. Held-input branches in inputQueue.ts keep
      // `lastApplied` populated as long as a key remains down, so this
      // tracks the held state correctly across throttled-send windows.
      nextFlags &= ~INPUT_FLAGS_MASK;
      const lastInputForSlot = lastApplied.get(slot);
      if (lastInputForSlot) {
        if (lastInputForSlot.thrust)    nextFlags |= FLAG_INPUT_THRUST;
        if (lastInputForSlot.turnLeft)  nextFlags |= FLAG_INPUT_TURN_LEFT;
        if (lastInputForSlot.turnRight) nextFlags |= FLAG_INPUT_TURN_RIGHT;
        if (lastInputForSlot.boost)     nextFlags |= FLAG_INPUT_BOOST;
        if (lastInputForSlot.reverse)   nextFlags |= FLAG_INPUT_REVERSE;
      }
      // Phase 4 warp-to: the body's warp phase (public: every client draws it).
      nextFlags &= ~(FLAG_WARP_SPOOL | FLAG_WARP_CRUISE);
      const wp = physics.warpPhase(playerId);
      if (wp === 'spool') nextFlags |= FLAG_WARP_SPOOL;
      else if (wp === 'cruise') nextFlags |= FLAG_WARP_CRUISE;
      u32[base + SLOT_FLAGS_OFF] = nextFlags;
    }
    Atomics.store(u32, TICK_IDX, tick);
    Atomics.store(u32, COUNT_IDX, allStates.size);

    Atomics.add(u32, SEQLOCK_IDX, 1); // unlock — value becomes even

    // Flush sleep transitions after the seqlock window so the SAB and the
    // discrete event arrive in a consistent order on the main thread.
    for (let i = 0; i < transitionCount; i++) {
      const t = transitionScratch[i]!;
      post({ type: 'SLEEP_TRANSITION', entityId: t.id, sleeping: t.sleeping, tick });
    }

    // Stage 2 — drain contact-force events and post a single batched
    // CONTACT_BATCH per tick. drainContacts applies the production force
    // floor and resolves collider→body→entity-id; the main thread relays
    // each entry as a `collision_resolved` network message. `prevVel` (last
    // tick's velocities = this tick's pre-step approach velocities) lets it
    // tag each contact with its impact (closing) speed for the damage gate.
    const contacts = drainContacts(eventQueue, physics, CONTACT_FORCE_FLOOR, prevVel);
    if (contacts.length > 0) {
      post({ type: 'CONTACT_BATCH', tick, contacts });
    }

    // Snapshot THIS tick's post-step velocities as NEXT tick's pre-step
    // (approach) velocities. Reuse value objects to stay allocation-free (#14);
    // `allStates` was already gathered above for the SAB write.
    for (const [id, s] of allStates) {
      const e = prevVel.get(id);
      if (e !== undefined) {
        e.vx = s.vx;
        e.vy = s.vy;
      } else {
        prevVel.set(id, { vx: s.vx, vy: s.vy });
      }
    }
    // Prune despawned entities so prevVel stays bounded. Only scans when stale
    // entries exist — in steady state the sizes match and this is a no-op.
    if (prevVel.size > allStates.size) {
      for (const id of prevVel.keys()) {
        if (!allStates.has(id)) prevVel.delete(id);
      }
    }

    // Phase 6 — publish the wall-clock duration of this step (in µs) so the
    // server's SimulationClock can drive TiDi from the real bottleneck. Single-
    // writer u32 in the SAB header. Microsecond resolution avoids floating-
    // point-in-u32 encoding faff for sub-millisecond ticks.
    const stepUs = Math.max(0, Math.round((performance.now() - tStepStart) * 1000));
    u32[WORKER_TICK_US_IDX] = stepUs > 0xffff_ffff ? 0xffff_ffff : stepUs;
  };

  return {
    handle,
    pump: (now: number): boolean => {
      if (now < nextTickAt) return false;
      step();
      // Catch-up cap: more than 5 ticks behind (a GC pause, a starved host) jumps
      // to "now" instead of replaying a backlog; the skipped ticks are counted.
      advanceSchedule(now, nextTickAt, tickMs, schedule);
      nextTickAt = schedule.nextTickAt;
      if (schedule.dropped > 0) {
        u32[WORKER_DROPPED_TICKS_IDX] = ((u32[WORKER_DROPPED_TICKS_IDX] ?? 0) + schedule.dropped) >>> 0;
      }
      return true;
    },
    dispose: () => {
      eventQueue.free();
      physics.dispose();
    },
  };
}

/**
 * Two modes:
 *  - **single world** (`workerData.sab`): one sector, untagged messages. Tests
 *    that spawn a bare worker use this.
 *  - **pooled** (`workerData.pooled`): `ADD_WORLD` / `REMOVE_WORLD` host and
 *    free sector worlds; every other command carries `worldId`, and every
 *    message back is tagged with it. Memory, 2026-11-07: a worker costs
 *    ~37 MB before any body (isolate + code + the ship catalogue), and the
 *    galaxy runs 21 sectors — one worker per sector held ~800 MB of heap.
 */
async function main(): Promise<void> {
  const data = workerData as { sab?: SharedArrayBuffer; pooled?: boolean };
  const worlds = new Map<number, WorldHandle>();
  if (data.sab) {
    const world = await createWorld(data.sab, (m) => parentPort!.postMessage(m));
    worlds.set(0, world);
    // Register the handler BEFORE signalling READY so commands sent right
    // after READY are not dropped.
    parentPort!.on('message', (cmd: WorkerCommand) => world.handle(cmd));
    parentPort!.postMessage({ type: 'READY' });
  } else {
    parentPort!.on('message', (cmd: WorkerCommand | AddWorldCmd | RemoveWorldCmd | GcCmd) => {
      if (cmd.type === 'GC') {
        (globalThis as { gc?: () => void }).gc?.();
        return;
      }
      if (cmd.type === 'ADD_WORLD') {
        const worldId = cmd.worldId;
        void createWorld(cmd.sab, (m) => { m['worldId'] = worldId; parentPort!.postMessage(m); }).then((w) => {
          worlds.set(worldId, w);
          parentPort!.postMessage({ type: 'READY', worldId });
        });
        return;
      }
      if (cmd.type === 'REMOVE_WORLD') {
        worlds.get(cmd.worldId)?.dispose();
        worlds.delete(cmd.worldId);
        return;
      }
      worlds.get((cmd as { worldId?: number }).worldId ?? -1)?.handle(cmd);
    });
    parentPort!.postMessage({ type: 'POOL_READY' });
  }

  // Hi-res tick loop. `setInterval(fn, 16.67)` on Windows quantises to the
  // ~15.6 ms multimedia-clock granularity and fires every ~31 ms (≈ 32 Hz),
  // which is what made the May 2026 capture show 37–46 Hz instead of 60.
  // setImmediate has ~1 ms granularity and lets us hit 60 Hz reliably.
  // Each hosted world steps on its OWN schedule (60 × its sector's game speed
  // per wall second, time scale stream), checked in insertion order.

  // The schedule pattern uses `setImmediate` only on tick-due frames so a
  // backlog (post-GC pause) drains in one event-loop turn; otherwise yields
  // via `setTimeout(loop, 1)`. Node's libuv calls `timeBeginPeriod(1)` on
  // Windows when timers are pending, putting the multimedia clock at 1 ms
  // resolution — so `setTimeout(1)` lands within a millisecond of
  // `nextTickAt` rather than the legacy 15.6 ms quantisation that doomed
  // the original `setInterval(16.67)` approach. The catch-up cap below
  // absorbs any single-iteration slip so cumulative drift cannot grow.
  const loop = (): void => {
    const now = performance.now();
    let stepped = false;
    for (const w of worlds.values()) if (w.pump(now)) stepped = true;
    if (stepped) {
      // After stepping, drain any further backlog in the same event-loop
      // turn before yielding.
      setImmediate(loop);
    } else {
      // Nothing due — yield the CPU. Replaces the unconditional
      // `setImmediate(loop)` busy-poll that was burning ~100 % of one core
      // per worker (×7 sectors = ~700 % parent-process CPU at idle).
      setTimeout(loop, 1);
    }
  };
  loop();
}

main().catch((err: unknown) => {
  console.error('[physics-worker] fatal error:', err);
  process.exit(1);
});
