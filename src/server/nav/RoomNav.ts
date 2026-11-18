/**
 * One sector room's navigation (navigation slices 4b-12): hosts the cut
 * field's nav maps in the nav worker, the AI brains' routes (`NavRoutes`,
 * handed to `view.nav`) and the players' autopilot route requests
 * (`AutopilotRoutes`). The room keeps one of these and nothing else of nav.
 */
import type { Logger } from 'pino';
import { getNavWorker, type NavField } from './NavWorker.js';
import { NavRoutes } from './NavRoutes.js';
import { AutopilotRoutes, type AutopilotHull } from './AutopilotRoutes.js';
import type { CutFieldNavSink } from '../rooms/CutFieldSubsystem.js';
import type { ChunkOpts } from '../../core/terrain/fieldLayout.js';
import type { NavRouteReply, NavRouteRequest } from '../../shared-types/messages/navMessages.js';

/** What the room tells it. */
export interface RoomNavDeps {
  now(): number;
  logger: Logger;
  sectorKey(): string | null;
  /** The room is shutting down (a build failure then is no error). */
  stopped(): boolean;
  /** The asking session's player and active hull, or null (no player, no live hull). */
  hullOf(sessionId: string): (AutopilotHull & { playerId: string }) | null;
}

/** The cut field's side: streams chunk loads and rock changes. */
export interface RoomNavSource {
  attachNav(sink: CutFieldNavSink): { gone: number[]; moved: Array<{ key: number; x: number; y: number; angle: number }> };
}

export class RoomNav {
  private field: NavField | undefined;
  /** The AI brains' routes (set once a field is hosted). */
  routes: NavRoutes | undefined;
  /** Stable (asking allocates no closure). */
  private readonly routeFn = (sx: number, sy: number, tx: number, ty: number, c: number, hd: number, tr: number) =>
    this.field!.route(sx, sy, tx, ty, c, hd, tr);
  readonly autopilot: AutopilotRoutes;

  constructor(private readonly deps: RoomNavDeps) {
    this.autopilot = new AutopilotRoutes(() => (this.field !== undefined ? this.routeFn : null), deps.now);
  }

  /** Hosts the cut field's nav maps in the nav worker; chunk loads and rock
   *  changes stream to it from here on (print-only size + ms). Returns the routes for the brains. */
  host(source: RoomNavSource, opts: ChunkOpts): NavRoutes {
    let field: NavField | undefined;
    const known = source.attachNav({
      chunk: (cx, cy, loaded) => field?.chunk(cx, cy, loaded),
      rockGone: (key) => field?.rockGone(key),
      rockMoved: (key, pose) => field?.rockMoved(key, pose),
    });
    const { logger } = this.deps, sectorKey = this.deps.sectorKey();
    field = this.field = getNavWorker(logger).addField(opts, known.gone, known.moved);
    field.built.then((b) => {
      logger.info({ sectorKey, cols: b.cols, rows: b.rows, kb: Math.round(b.bytes / 1024), ms: Math.round(b.ms * 10) / 10 }, 'nav coarse layer built');
    }, (err: unknown) => { if (!this.deps.stopped()) logger.error({ err, sectorKey }, 'nav field build failed'); });
    return this.routes = new NavRoutes(this.routeFn, this.deps.now);
  }

  /** A parsed `nav_route_request` (slice 12; `rooms/features/navMessages.ts`): answer the asker's own hull. */
  onRequest(client: { sessionId: string; send(type: string, msg: unknown): void }, req: NavRouteRequest): void {
    const hull = this.deps.hullOf(client.sessionId);
    if (hull === null) return;
    this.autopilot.request(hull.playerId, hull, req.reqId, req.tx, req.ty,
      (r: NavRouteReply) => { try { client.send('nav_route', r); } catch { /* closing */ } });
  }

  /** Does this AI ship wait short of its goal (slice 9's `blocked`)? */
  waiting(id: string): boolean { return this.routes?.waiting(id) === true; }

  /** A player left the room. */
  forget(playerId: string): void { this.autopilot.forget(playerId); }

  /** Room dispose: free the worker's field. */
  detach(): void {
    this.field?.detach();
    this.field = undefined;
    this.routes = undefined;
  }
}
