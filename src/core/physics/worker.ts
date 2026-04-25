/**
 * Physics worker — runs Rapier at 60 Hz in a dedicated worker_threads thread.
 *
 * Communication contract with the main thread (SectorRoom):
 *   Main → Worker  postMessage commands: SPAWN | DESPAWN | INPUT
 *   Worker → Main  postMessage events:   READY
 *   Shared memory  SharedArrayBuffer (see sabLayout.ts) — written here under seqlock,
 *                  read by main thread between writes.
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
  slotBase,
} from '../../shared-types/sabLayout.js';

const TICK_MS = 1000 / 60;

interface SpawnCmd         { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number }
interface DespawnCmd       { type: 'DESPAWN';        slot: number; playerId: string }
interface InputCmd         { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean }
interface SpawnObstacleCmd { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number }
type WorkerCommand = SpawnCmd | DespawnCmd | InputCmd | SpawnObstacleCmd;

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
        // Mark slot empty in SAB.
        u32[slotBase(cmd.slot) + SLOT_ID_OFF] = 0;
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

    // Always step by the nominal fixed dt regardless of actual elapsed time.
    // Using actual elapsed time causes the accumulator to occasionally produce
    // 0 or 2 steps instead of 1, diverging from the client's prediction world
    // which always steps exactly once per input-loop tick.
    physics.tick(TICK_MS / 1000);
    tick++;

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
    }
    Atomics.store(u32, TICK_IDX, tick);
    Atomics.store(u32, COUNT_IDX, allStates.size);

    Atomics.add(u32, SEQLOCK_IDX, 1); // unlock — value becomes even
  }, TICK_MS);
}

main().catch((err: unknown) => {
  console.error('[physics-worker] fatal error:', err);
  process.exit(1);
});
