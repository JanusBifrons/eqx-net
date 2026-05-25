/**
 * Worker-IPC boundary for SectorRoom.
 *
 * Step 6 of the hazy-pillow decomposition plan — minimum-viable seam
 * for the physics worker. Owns the worker handle and the
 * `sabAppliedTicks` mirror (last-applied input tick per slot, read
 * from SAB).
 *
 * Deliberately small in this commit. The plan's full PhysicsBridge
 * would also absorb: the SAB buffers (`sab`/`sabU32`/`sabF32`), the
 * pose mirror caches (`shipPoseCache` / `lingeringPoseCache` /
 * `wreckPoseCache`), the `drainSab()` seqlock loop, the worker
 * `spawnWorker()` body, and the worker `onmessage` dispatcher.
 * Those are deeply intertwined with state owned by subsystems that
 * haven't extracted yet (CombatSubsystem for damage-on-collision,
 * MountAimSubsystem for drone-mount cleanup on despawn) and with
 * the 9-phase update() body. Migrating them now would either:
 *   - Force PhysicsBridge to import every collaborator before its
 *     contract is stable, OR
 *   - Ship a fake extraction where the heavy logic still lives in
 *     SectorRoom under a different name.
 *
 * Instead, this commit establishes the IPC seam (`post(cmd)`) and
 * relocates the simple SAB-driven state mirror. Later commits can
 * grow this class as collaborators extract.
 */

import type { Worker } from 'node:worker_threads';
import type { WorkerCmd } from './SectorRoom.js';

export class PhysicsBridge {
  /** Set once during `spawnWorker()` in SectorRoom; never replaced. */
  private _worker: Worker | null = null;

  /** Last client input tick the physics worker confirmed it applied,
   *  read from SAB and mirrored here for cheap synchronous access by
   *  the snapshot broadcaster. Keyed by playerId. */
  readonly sabAppliedTicks = new Map<string, number>();

  /** Wire the worker after `bundleWorker` resolves and `new Worker(...)`
   *  returns. Caller is responsible for registering message handlers. */
  setWorker(worker: Worker): void {
    this._worker = worker;
  }

  /** Send a command to the worker via structured-clone postMessage. */
  post(cmd: WorkerCmd): void {
    if (this._worker === null) throw new Error('PhysicsBridge: worker not initialised');
    this._worker.postMessage(cmd);
  }

  /** Access the underlying worker (for direct event-handler attach /
   *  terminate / etc.). Identity-preserving; caller must not retain
   *  references across worker respawn. */
  get worker(): Worker {
    if (this._worker === null) throw new Error('PhysicsBridge: worker not initialised');
    return this._worker;
  }
}
