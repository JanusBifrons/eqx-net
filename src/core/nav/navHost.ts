/**
 * What the nav worker does with each message (navigation plan, slices 4b–5).
 *
 * Pure: the worker entry (`server/nav/navWorkerEntry.ts`) wires it to
 * `parentPort`, and tests drive it directly. One worker hosts every sector's
 * field: commands carry `worldId` (one per sector room, as in the physics
 * pool) and replies come back tagged with it.
 *
 * Per field it holds the coarse layer (`CoarseFieldMap`, the whole field from
 * its layout) and the fine layer (`FineFieldLayer`, per loaded chunk from the
 * cut rocks). `ROUTE` asks the route planner (slice 6) for a way across.
 */
import type { ChunkOpts } from '../terrain/fieldLayout.js';
import { CoarseFieldMap } from './coarseField.js';
import { FineFieldLayer, type NavRockPose } from './fineField.js';
import { RoutePlanner, NAV_ROUTE_MAX_POINTS, type NavRouteStatus } from './routePlanner.js';

/** Host a cut field's nav maps for one sector room. `gone` / `moved`: rocks
 *  already broken up or left elsewhere when the room started (saved records). */
export interface NavAddFieldCmd { type: 'ADD_FIELD'; worldId: number; opts: ChunkOpts; gone?: number[]; moved?: NavRockPose[] }
/** Free a sector room's nav maps (room dispose). */
export interface NavRemoveFieldCmd { type: 'REMOVE_FIELD'; worldId: number }
/** A field chunk was loaded (`loaded`) or dropped by the room's streamer. */
export interface NavChunkCmd { type: 'CHUNK'; worldId: number; cx: number; cy: number; loaded: boolean }
/** A rock was broken up (`gone`), or rests somewhere new (`pose`; null: back
 *  at its cut pose). */
export interface NavRockCmd { type: 'ROCK'; worldId: number; key: number; gone?: true; pose?: { x: number; y: number; angle: number } | null }
/** Plan a route from (sx, sy) to (tx, ty) for a hull of clearance `clearance`
 *  (from `shipTuning`, #18); `reqId` matches the reply. */
export interface NavRouteCmd { type: 'ROUTE'; worldId: number; reqId: number; sx: number; sy: number; tx: number; ty: number; clearance: number }
export type NavCommand = NavAddFieldCmd | NavRemoveFieldCmd | NavChunkCmd | NavRockCmd | NavRouteCmd;

/** Reply to `ADD_FIELD`: the coarse layer is built. */
export interface NavFieldBuiltMsg {
  type: 'FIELD_BUILT';
  worldId: number;
  cols: number;
  rows: number;
  /** Bytes the coarse layer holds (best point + room per cell). */
  bytes: number;
  /** Build time (worker wall clock, print-only). */
  ms: number;
}
/** Reply to `ROUTE`: the waypoints after the start (packed x, y; the goal
 *  last), how many nodes the search expanded, and its time (print-only).
 *  An unknown world answers `none`. */
export interface NavRouteMsg {
  type: 'ROUTE';
  worldId: number;
  reqId: number;
  status: NavRouteStatus;
  points: Float64Array;
  expanded: number;
  ms: number;
}
export type NavReply = NavFieldBuiltMsg | NavRouteMsg;

interface NavWorld { coarse: CoarseFieldMap; fine: FineFieldLayer }

export class NavHost {
  private readonly worlds = new Map<number, NavWorld>();
  private readonly planner = new RoutePlanner();
  private readonly scratch = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);

  /** `now`: a millisecond clock for print-only build timings (real time). */
  constructor(private readonly now: () => number) {}

  /** Fields hosted (diagnostics, tests). */
  get fieldCount(): number { return this.worlds.size; }

  /** The coarse layer hosted for `worldId`, if any. */
  coarse(worldId: number): CoarseFieldMap | undefined { return this.worlds.get(worldId)?.coarse; }

  /** The fine layer hosted for `worldId`, if any. */
  fine(worldId: number): FineFieldLayer | undefined { return this.worlds.get(worldId)?.fine; }

  /** Runs one command; returns the reply to post, if any. */
  handle(cmd: NavCommand): NavReply | null {
    switch (cmd.type) {
      case 'ADD_FIELD': {
        const t0 = this.now();
        const coarse = this.worlds.get(cmd.worldId)?.coarse ?? new CoarseFieldMap();
        coarse.build(cmd.opts);
        this.worlds.set(cmd.worldId, { coarse, fine: new FineFieldLayer(cmd.opts, cmd.gone, cmd.moved) });
        return {
          type: 'FIELD_BUILT', worldId: cmd.worldId, cols: coarse.cols, rows: coarse.rows,
          bytes: coarse.room.byteLength + coarse.bestX.byteLength + coarse.bestY.byteLength, ms: this.now() - t0,
        };
      }
      case 'REMOVE_FIELD':
        this.worlds.delete(cmd.worldId);
        return null;
      case 'CHUNK': {
        const fine = this.worlds.get(cmd.worldId)?.fine;
        if (cmd.loaded) fine?.chunkLoaded(cmd.cx, cmd.cy);
        else fine?.chunkUnloaded(cmd.cx, cmd.cy);
        return null;
      }
      case 'ROCK': {
        const fine = this.worlds.get(cmd.worldId)?.fine;
        if (cmd.gone) fine?.rockGone(cmd.key);
        else if (cmd.pose !== undefined) fine?.rockMoved(cmd.key, cmd.pose);
        return null;
      }
      case 'ROUTE': {
        const t0 = this.now(), w = this.worlds.get(cmd.worldId);
        let n = 0;
        if (w) n = this.planner.plan(w.coarse, w.fine, cmd.sx, cmd.sy, cmd.tx, cmd.ty, cmd.clearance, this.scratch);
        return {
          type: 'ROUTE', worldId: cmd.worldId, reqId: cmd.reqId,
          status: w ? this.planner.status : 'none',
          points: this.scratch.slice(0, n * 2), // the reply's own copy (it is transferred)
          expanded: w ? this.planner.expanded : 0, ms: this.now() - t0,
        };
      }
    }
  }
}
