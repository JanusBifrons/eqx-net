/**
 * Physics worker — runs Rapier at 60 Hz in a dedicated worker_threads thread.
 *
 * Communication contract with the main thread (SectorRoom):
 *   Main → Worker  postMessage commands: SPAWN | DESPAWN | INPUT | SPAWN_OBSTACLE | AI_INTENT
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
 */
import { parentPort, workerData } from 'node:worker_threads';
import { PhysicsWorld } from './World.js';
import {
  SEQLOCK_IDX,
  TICK_IDX,
  COUNT_IDX,
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
  slotBase,
} from '../../shared-types/sabLayout.js';

const TICK_MS = 1000 / 60;
/** Ticks a body must report sleeping consecutively before FLAG_SLEEPING is set.
 *  Suppresses flap on slow-drift entities under rapier2d-compat's threshold. */
const SLEEP_HYSTERESIS_TICKS = 12;

interface SpawnCmd         { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number }
interface DespawnCmd       { type: 'DESPAWN';        slot: number; playerId: string }
interface InputCmd         { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean }
interface SpawnObstacleCmd { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number }
interface AiIntentCmd      { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number }
type WorkerCommand = SpawnCmd | DespawnCmd | InputCmd | SpawnObstacleCmd | AiIntentCmd;

async function main(): Promise<void> {
  const { sab } = workerData as { sab: SharedArrayBuffer };
  const u32 = new Uint32Array(sab);
  const f32 = new Float32Array(sab);

  const physics = await PhysicsWorld.create();
  const playerToSlot = new Map<string, number>();
  const slotToPlayer = new Map<number, string>();
  // FIFO input queue per slot. Each client input is enqueued and dequeued exactly
  // once, one per physics step. This keeps ackedTick = serverTick - 1 so the
  // reconciler replays the correct number of steps and achieves near-zero drift.
  // The overwrite-latest model caused ackedTick to jump 15+ ticks ahead of
  // serverTick, leaving the reconciler replaying only 1 step instead of ~16.
  const inputQueues = new Map<number, Array<{ tick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean }>>();
  const lastApplied = new Map<number, { tick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean }>();
  /** Pending AI intents per slot, applied once on the next physics step then cleared. */
  const aiIntents = new Map<number, { fx: number; fy: number; torque: number }>();
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
        physics.spawnShip(cmd.playerId, cmd.x, cmd.y);
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
          q.push({ tick: cmd.inputTick, thrust: cmd.thrust, turnLeft: cmd.turnLeft, turnRight: cmd.turnRight });
        }
        break;
      }
      case 'SPAWN_OBSTACLE': {
        physics.spawnObstacle(cmd.obstacleId, cmd.x, cmd.y, cmd.radius, cmd.mass);
        if (cmd.vx !== 0 || cmd.vy !== 0) {
          physics.setShipState(cmd.obstacleId, { x: cmd.x, y: cmd.y, angle: 0, vx: cmd.vx, vy: cmd.vy });
        }
        playerToSlot.set(cmd.obstacleId, cmd.slot);
        slotToPlayer.set(cmd.slot, cmd.obstacleId);
        break;
      }
      case 'AI_INTENT': {
        // Coalesce: latest intent wins for this slot; one impulse per step.
        aiIntents.set(cmd.slot, { fx: cmd.fx, fy: cmd.fy, torque: cmd.torque });
        break;
      }
    }
  });

  parentPort!.postMessage({ type: 'READY' });

  setInterval(() => {
    // Dequeue exactly one input per slot per step. Holding the last applied input
    // when the queue runs dry keeps the ship at its most recent control state.
    const appliedTicks = new Map<number, number>(); // slot → inputTick
    for (const [slot, q] of inputQueues) {
      const playerId = slotToPlayer.get(slot);
      if (!playerId) continue;
      if (q.length > 0) {
        const entry = q.shift()!;
        lastApplied.set(slot, entry);
        appliedTicks.set(slot, entry.tick);
        physics.applyInput(playerId, entry);
      } else {
        const held = lastApplied.get(slot);
        if (held) physics.applyInput(playerId, held);
        // Don't update appliedTicks — ackedTick stays at last-dequeued tick.
      }
    }

    // Apply pending AI intents (one per slot per step). Drained after application.
    for (const [slot, intent] of aiIntents) {
      const id = slotToPlayer.get(slot);
      if (id !== undefined) physics.applyImpulse(id, intent.fx, intent.fy, intent.torque);
    }
    aiIntents.clear();

    // Always step by the nominal fixed dt regardless of actual elapsed time.
    // Using actual elapsed time causes the accumulator to occasionally produce
    // 0 or 2 steps instead of 1, diverging from the client's prediction world
    // which always steps exactly once per input-loop tick.
    physics.tick(TICK_MS / 1000);
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
      const nextFlags = slept ? prevFlags | FLAG_SLEEPING : prevFlags & ~FLAG_SLEEPING;
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
  }, TICK_MS);
}

main().catch((err: unknown) => {
  console.error('[physics-worker] fatal error:', err);
  process.exit(1);
});
