/**
 * Main-thread side of the nav worker (navigation plan, slice 4b).
 *
 * Same pattern as `PhysicsWorkerPool`: the entry is bundled once with
 * `bundleWorker`, started with `eval`, `unref()`'d so it never keeps a
 * process or test runner alive, and each sector room gets a `worldId` its
 * replies are routed by. One worker per process: the work is building maps
 * once per sector and answering route requests, not stepping a world.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { ChunkOpts } from '../../core/terrain/fieldLayout.js';
import type { NavCommand, NavFieldBuiltMsg, NavReply, NavRouteMsg } from '../../core/nav/navHost.js';
import type { NavRockPose } from '../../core/nav/fineField.js';
import { bundleWorker } from '../workers/bundleWorker.js';

const NAV_WORKER_TS_PATH = fileURLToPath(new URL('./navWorkerEntry.ts', import.meta.url));

/** One sector room's field hosted in the nav worker. Every call posts in
 *  order behind the worker's start, so a room streams chunk and rock events
 *  from the moment it adds its field. Discrete events only, never per tick. */
export interface NavField {
  readonly worldId: number;
  /** What the build reported (size, print-only time). */
  readonly built: Promise<NavFieldBuiltMsg>;
  /** A field chunk was loaded or dropped by the room's streamer. */
  chunk(cx: number, cy: number, loaded: boolean): void;
  /** A rock was broken up. */
  rockGone(key: number): void;
  /** A rock rests somewhere new (null: back at its cut pose). */
  rockMoved(key: number, pose: { x: number; y: number; angle: number } | null): void;
  /** Plans a route from (sx, sy) to (tx, ty) for a hull of clearance
   *  `clearance` (from `shipTuning`). Asynchronous: the ship keeps flying
   *  meanwhile. After detach it answers `none` at once; a worker failure
   *  rejects every request in flight. */
  route(sx: number, sy: number, tx: number, ty: number, clearance: number): Promise<NavRouteMsg>;
  /** Free it (on room dispose); later calls do nothing. */
  detach(): void;
}

export class NavWorker {
  private worker: Promise<Worker> | null = null;
  private readonly waiting = new Map<number, (msg: NavFieldBuiltMsg) => void>();
  private nextWorldId = 1;
  private readonly routes = new Map<number, { resolve: (msg: NavRouteMsg) => void; reject: (err: unknown) => void }>();
  private nextReqId = 1;

  /** Route requests posted and not yet answered (the count gate's in-flight counter). */
  get inFlight(): number { return this.routes.size; }

  constructor(private readonly logger: Logger, private readonly entryPath = NAV_WORKER_TS_PATH) {}

  /** Hosts a field's nav maps; `gone` / `moved`: rocks already broken up or
   *  left elsewhere (saved records). */
  addField(opts: ChunkOpts, gone: number[] = [], moved: NavRockPose[] = []): NavField {
    const worldId = this.nextWorldId++;
    const started = this.start();
    let attached = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const post = (cmd: NavCommand): void => {
      if (attached) void started.then((w) => w.postMessage(cmd), () => undefined);
    };
    const built = new Promise<NavFieldBuiltMsg>((resolve, reject) => {
      // eslint-disable-next-line no-restricted-globals -- real time: a build watchdog, not game time
      timer = setTimeout(() => { this.waiting.delete(worldId); reject(new Error(`nav field ${worldId} not built within 30 s`)); }, 30_000);
      timer.unref();
      this.waiting.set(worldId, (msg) => { clearTimeout(timer); this.waiting.delete(worldId); resolve(msg); });
      started.catch((err: unknown) => { clearTimeout(timer); this.waiting.delete(worldId); reject(err); });
    });
    post({ type: 'ADD_FIELD', worldId, opts, gone, moved });
    return {
      worldId, built,
      chunk: (cx, cy, loaded) => post({ type: 'CHUNK', worldId, cx, cy, loaded }),
      rockGone: (key) => post({ type: 'ROCK', worldId, key, gone: true }),
      rockMoved: (key, pose) => post({ type: 'ROCK', worldId, key, pose }),
      route: (sx, sy, tx, ty, clearance) => {
        if (!attached) {
          return Promise.resolve({ type: 'ROUTE', worldId, reqId: 0, status: 'none', points: new Float64Array(0), expanded: 0, ms: 0 });
        }
        const reqId = this.nextReqId++;
        return new Promise<NavRouteMsg>((resolve, reject) => {
          this.routes.set(reqId, { resolve, reject });
          started.then((w) => w.postMessage({ type: 'ROUTE', worldId, reqId, sx, sy, tx, ty, clearance } satisfies NavCommand),
            (err: unknown) => { this.routes.delete(reqId); reject(err); });
        });
      },
      detach: () => {
        if (!attached) return;
        post({ type: 'REMOVE_FIELD', worldId });
        attached = false;
        clearTimeout(timer);
        this.waiting.delete(worldId);
      },
    };
  }

  private failRoutes(err: unknown): void {
    for (const r of this.routes.values()) r.reject(err);
    this.routes.clear();
  }

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
          if (msg.type === 'ROUTE') {
            const r = this.routes.get(msg.reqId);
            this.routes.delete(msg.reqId);
            r?.resolve(msg);
            return;
          }
          this.waiting.get(msg.worldId)?.(msg);
        });
        worker.on('error', (err) => {
          this.logger.error({ err, errMessage: (err as Error)?.message }, 'nav worker error');
          this.failRoutes(err);
          reject(err);
        });
        worker.on('exit', (code) => {
          if (code !== 0) this.logger.error({ code }, 'nav worker exited unexpectedly');
          this.failRoutes(new Error(`nav worker exited (${code})`));
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
