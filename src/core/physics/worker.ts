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
  slotBase,
} from '../../shared-types/sabLayout.js';

const TICK_MS = 1000 / 60;

interface SpawnCmd  { type: 'SPAWN';   slot: number; playerId: string; x: number; y: number }
interface DespawnCmd{ type: 'DESPAWN'; slot: number; playerId: string }
interface InputCmd  { type: 'INPUT';   slot: number; thrust: boolean; turnLeft: boolean; turnRight: boolean }
type WorkerCommand = SpawnCmd | DespawnCmd | InputCmd;

async function main(): Promise<void> {
  const { sab } = workerData as { sab: SharedArrayBuffer };
  const u32 = new Uint32Array(sab);
  const f32 = new Float32Array(sab);

  const physics = await PhysicsWorld.create();
  const playerToSlot = new Map<string, number>();
  const slotToPlayer = new Map<number, string>();
  // Latest pending input per slot — keyed by slot, overwritten each message.
  const pendingInputs = new Map<number, { thrust: boolean; turnLeft: boolean; turnRight: boolean }>();
  let tick = 0;
  let lastMs = performance.now();

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
        pendingInputs.delete(cmd.slot);
        // Mark slot empty in SAB.
        u32[slotBase(cmd.slot) + SLOT_ID_OFF] = 0;
        break;
      }
      case 'INPUT': {
        pendingInputs.set(cmd.slot, {
          thrust: cmd.thrust,
          turnLeft: cmd.turnLeft,
          turnRight: cmd.turnRight,
        });
        break;
      }
    }
  });

  parentPort!.postMessage({ type: 'READY' });

  setInterval(() => {
    const now = performance.now();
    const dtSec = (now - lastMs) / 1000;
    lastMs = now;

    // Apply latest inputs then clear — only the most recent input per entity matters.
    for (const [slot, input] of pendingInputs) {
      const playerId = slotToPlayer.get(slot);
      if (playerId) physics.applyInput(playerId, input);
    }
    pendingInputs.clear();

    physics.tick(dtSec);
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
      f32[base + SLOT_ANGLE_OFF] = s.angle;
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
