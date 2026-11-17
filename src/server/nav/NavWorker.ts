/**
 * Main-thread side of the nav worker (navigation plan, slice 4b).
 *
 * Same pattern as `PhysicsWorkerPool`: the entry is bundled once with
 * `bundleWorker`, started with `eval`, `unref()`'d so it never keeps a
 * process or test runner alive, and each sector room gets a `worldId` its
 * replies are routed by. One worker per process: the work is building maps
 * once per sector and (later) answering route requests, not stepping a world.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { ChunkOpts } from '../../core/terrain/fieldLayout.js';
import type { NavCommand, NavFieldBuiltMsg, NavReply } from '../../core/nav/navHost.js';
import { bundleWorker } from '../workers/bundleWorker.js';

const NAV_WORKER_TS_PATH = fileURLToPath(new URL('./navWorkerEntry.ts', import.meta.url));

/** One sector room's field hosted in the nav worker. */
export interface NavField {
  readonly worldId: number;
  /** What the build reported (size, print-only time). */
  readonly built: NavFieldBuiltMsg;
  /** Free it (on room dispose). */
  detach(): void;
}

export class NavWorker {
  private worker: Promise<Worker> | null = null;
  private readonly waiting = new Map<number, (msg: NavReply) => void>();
  private nextWorldId = 1;

  constructor(private readonly logger: Logger, private readonly entryPath = NAV_WORKER_TS_PATH) {}

  /** Builds `opts`' nav maps in the worker; resolves once built. */
  async addField(opts: ChunkOpts): Promise<NavField> {
    const worker = await this.start();
    const worldId = this.nextWorldId++;
    const built = await new Promise<NavFieldBuiltMsg>((resolve, reject) => {
      // eslint-disable-next-line no-restricted-globals -- real time: a build watchdog, not game time
      const timer = setTimeout(() => { this.waiting.delete(worldId); reject(new Error(`nav field ${worldId} not built within 10 s`)); }, 10_000);
      this.waiting.set(worldId, (msg) => { clearTimeout(timer); this.waiting.delete(worldId); resolve(msg); });
      this.post(worker, { type: 'ADD_FIELD', worldId, opts });
    });
    let attached = true;
    return {
      worldId, built,
      detach: () => {
        if (!attached) return;
        attached = false;
        this.post(worker, { type: 'REMOVE_FIELD', worldId });
      },
    };
  }

  private post(worker: Worker, cmd: NavCommand): void { worker.postMessage(cmd); }

  private start(): Promise<Worker> {
    this.worker ??= (async () => {
      const code = await bundleWorker({ entryPoint: this.entryPath });
      return new Promise<Worker>((resolve, reject) => {
        const worker = new Worker(code, { eval: true });
        worker.unref();
        // eslint-disable-next-line no-restricted-globals -- real time: a worker start-up watchdog, not game time
        const timer = setTimeout(() => reject(new Error('nav worker did not start within 10 s')), 10_000);
        worker.on('message', (msg: NavReply | { type: 'NAV_READY' }) => {
          if (msg.type === 'NAV_READY') { clearTimeout(timer); resolve(worker); return; }
          this.waiting.get(msg.worldId)?.(msg);
        });
        worker.on('error', (err) => {
          this.logger.error({ err, errMessage: (err as Error)?.message }, 'nav worker error');
          reject(err);
        });
        worker.on('exit', (code) => {
          if (code !== 0) this.logger.error({ code }, 'nav worker exited unexpectedly');
          this.worker = null;
        });
      });
    })();
    return this.worker;
  }
}

let shared: NavWorker | null = null;

/** The process-wide nav worker (started on first use). */
export function getNavWorker(logger: Logger): NavWorker {
  shared ??= new NavWorker(logger);
  return shared;
}
