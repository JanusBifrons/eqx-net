/**
 * Physics worker — runs Rapier at 60 Hz in a dedicated worker_threads thread.
 *
 * Communication contract with the main thread (SectorRoom):
 *   Main → Worker  postMessage commands: SPAWN | DESPAWN | INPUT | SPAWN_OBSTACLE | AI_INTENT | CLOCK_RATE
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
import { tickInputQueue, type QueuedInput } from './inputQueue.js';
import { drainContacts } from './contactDrain.js';
import type { Vec2 } from '../swarm/asteroidShape.js';
import {
  SEQLOCK_IDX,
  TICK_IDX,
  COUNT_IDX,
  CLOCK_RATE_IDX,
  CLOCK_RATE_SCALE,
  WORKER_TICK_US_IDX,
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
interface InputCmd         { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean }
interface SpawnObstacleCmd { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number; vertices?: ReadonlyArray<Vec2> }
interface AiIntentCmd      { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number; setAngvel?: number }
interface ClockRateCmd     { type: 'CLOCK_RATE';     rate: number }
/** Authoritatively reposition a body in the physics world. Used by the
 *  Phase-1 drone position-clamp backstop in `SectorRoom`: when a drone
 *  drifts past `MAX_BOUNDS` (well outside the playable region), the room
 *  posts this command to teleport the body back in-bounds and zero its
 *  velocity. Single-writer rule: only the worker mutates SAB pose; this
 *  command is the only path the main thread has to override it. */
interface SetPositionCmd   { type: 'SET_POSITION';   entityId: string; x: number; y: number; angle: number; vx: number; vy: number; angvel: number }
type WorkerCommand = SpawnCmd | DespawnCmd | InputCmd | SpawnObstacleCmd | AiIntentCmd | ClockRateCmd | SetPositionCmd;

async function main(): Promise<void> {
  const { sab } = workerData as { sab: SharedArrayBuffer };
  const u32 = new Uint32Array(sab);
  const f32 = new Float32Array(sab);

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
  /** Per-slot consecutive-sleep counter; FLAG_SLEEPING is written when this >= hysteresis. */
  const sleepCount = new Map<number, number>();
  /** Per-slot last-broadcast sleep flag, used to detect transitions for SLEEP_TRANSITION. */
  const sleepState = new Map<number, boolean>();
  let tick = 0;

  // Register command handler BEFORE signalling READY so commands sent
  // immediately after READY are not dropped.
  parentPort!.on('message', (cmd: WorkerCommand) => {
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
        sleepCount.delete(cmd.slot);
        sleepState.delete(cmd.slot);
        // Mark slot empty in SAB.
        u32[slotBase(cmd.slot) + SLOT_ID_OFF] = 0;
        u32[slotBase(cmd.slot) + SLOT_FLAGS_OFF] = 0;
        break;
      }
      case 'INPUT': {
        let q = inputQueues.get(cmd.slot);
        if (!q) { q = []; inputQueues.set(cmd.slot, q); }
        // Cap queue to prevent unbounded growth if client briefly outruns physics.
        if (q.length < 20) {
          q.push({ tick: cmd.inputTick, thrust: cmd.thrust, turnLeft: cmd.turnLeft, turnRight: cmd.turnRight, boost: cmd.boost, reverse: cmd.reverse });
        }
        break;
      }
      case 'SPAWN_OBSTACLE': {
        physics.spawnObstacle(cmd.obstacleId, cmd.x, cmd.y, cmd.radius, cmd.mass, cmd.vertices);
        if (cmd.vx !== 0 || cmd.vy !== 0) {
          physics.setShipState(cmd.obstacleId, { x: cmd.x, y: cmd.y, angle: 0, vx: cmd.vx, vy: cmd.vy });
        }
        playerToSlot.set(cmd.obstacleId, cmd.slot);
        slotToPlayer.set(cmd.slot, cmd.obstacleId);
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
    }
  });

  parentPort!.postMessage({ type: 'READY' });

  // Hi-res tick loop. `setInterval(fn, 16.67)` on Windows quantises to the
  // ~15.6 ms multimedia-clock granularity and fires every ~31 ms (≈ 32 Hz),
  // which is what made the May 2026 capture show 37–46 Hz instead of 60.
  // setImmediate has ~1 ms granularity and lets us hit 60 Hz reliably.
  const TICK_MS_HR = 1000 / 60;
  let nextTickAt = performance.now();
  const step = (): void => {
    const tStepStart = performance.now();
    // Per-slot input dequeue + held-input synthesis. The pure logic lives in
    // `inputQueue.ts` so the contract is unit-testable.
    const appliedTicks = new Map<number, number>(); // slot → inputTick
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
    const transitions: Array<{ id: string; sleeping: boolean }> = [];
    for (const [slot, id] of slotToPlayer) {
      const sleeping = physics.isSleeping(id);
      const prev = sleepCount.get(slot) ?? 0;
      const next = sleeping ? prev + 1 : 0;
      sleepCount.set(slot, next);

      const effectiveSleeping = next >= SLEEP_HYSTERESIS_TICKS;
      const lastReported = sleepState.get(slot) ?? false;
      if (effectiveSleeping !== lastReported) {
        sleepState.set(slot, effectiveSleeping);
        transitions.push({ id, sleeping: effectiveSleeping });
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
      u32[base + SLOT_FLAGS_OFF] = nextFlags;
    }
    Atomics.store(u32, TICK_IDX, tick);
    Atomics.store(u32, COUNT_IDX, allStates.size);

    Atomics.add(u32, SEQLOCK_IDX, 1); // unlock — value becomes even

    // Flush sleep transitions after the seqlock window so the SAB and the
    // discrete event arrive in a consistent order on the main thread.
    for (const t of transitions) {
      parentPort!.postMessage({ type: 'SLEEP_TRANSITION', entityId: t.id, sleeping: t.sleeping, tick });
    }

    // Stage 2 — drain contact-force events and post a single batched
    // CONTACT_BATCH per tick. drainContacts applies the production force
    // floor and resolves collider→body→entity-id; the main thread relays
    // each entry as a `collision_resolved` network message.
    const contacts = drainContacts(eventQueue, physics, CONTACT_FORCE_FLOOR);
    if (contacts.length > 0) {
      parentPort!.postMessage({ type: 'CONTACT_BATCH', tick, contacts });
    }

    // Phase 6 — publish the wall-clock duration of this step (in µs) so the
    // server's SimulationClock can drive TiDi from the real bottleneck. Single-
    // writer u32 in the SAB header. Microsecond resolution avoids floating-
    // point-in-u32 encoding faff for sub-millisecond ticks.
    const stepUs = Math.max(0, Math.round((performance.now() - tStepStart) * 1000));
    u32[WORKER_TICK_US_IDX] = stepUs > 0xffff_ffff ? 0xffff_ffff : stepUs;
  };

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
    if (now >= nextTickAt) {
      step();
      nextTickAt += TICK_MS_HR;
      // Catch-up cap: if we're more than 5 ticks behind (e.g. after a long GC
      // pause), jump forward to "now" so we don't spiral. The simulation
      // re-syncs to wall-clock instead of trying to replay a backlog.
      if (now > nextTickAt + 5 * TICK_MS_HR) nextTickAt = now + TICK_MS_HR;
      // After stepping, drain any further backlog in the same event-loop
      // turn before yielding.
      setImmediate(loop);
    } else {
      // Not yet at next tick — yield the CPU. Replaces the unconditional
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
