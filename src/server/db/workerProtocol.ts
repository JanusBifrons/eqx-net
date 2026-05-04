import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';

/** Main thread → DB worker. */
export type WorkerInbound =
  | { type: 'BATCH'; batchId: number; ops: PersistOp[] }
  | { type: 'AWAITABLE'; opId: string; op: PersistOp }
  | { type: 'VOLATILE'; op: PersistOp }
  | { type: 'SHUTDOWN' };

/** DB worker → main thread. */
export type WorkerOutbound =
  | { type: 'READY' }
  | { type: 'BATCH_ACK'; batchId: number }
  | { type: 'AWAITABLE_ACK'; opId: string; rowId?: number }
  | { type: 'BATCH_ERROR'; batchId: number; message: string }
  | { type: 'AWAITABLE_ERROR'; opId: string; message: string }
  | { type: 'SHUTDOWN_ACK'; drained: number };
