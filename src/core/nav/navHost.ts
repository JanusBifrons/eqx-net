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
 * cut rocks). The route planner (slice 6) adds commands here.
 */
import type { ChunkOpts } from '../terrain/fieldLayout.js';
import { CoarseFieldMap } from './coarseField.js';
import { FineFieldLayer, type NavRockPose } from './fineField.js';

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
export type NavCommand = NavAddFieldCmd | NavRemoveFieldCmd | NavChunkCmd | NavRockCmd;

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
export type NavReply = NavFieldBuiltMsg;

interface NavWorld { coarse: CoarseFieldMap; fine: FineFieldLayer }

export class NavHost {
  private readonly worlds = new Map<number, NavWorld>();

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
    }
  }
}
