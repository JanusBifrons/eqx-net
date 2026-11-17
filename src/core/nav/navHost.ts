/**
 * What the nav worker does with each message (navigation plan, slice 4b).
 *
 * Pure: the worker entry (`server/nav/navWorkerEntry.ts`) wires it to
 * `parentPort`, and tests drive it directly. One worker hosts every sector's
 * field: commands carry `worldId` (one per sector room, as in the physics
 * pool) and replies come back tagged with it.
 *
 * Today it builds the coarse layer (`CoarseFieldMap`) for a cut-field sector
 * and reports its size and build time. The fine layer (slice 5) and the
 * route planner (slice 6) add commands here.
 */
import type { ChunkOpts } from '../terrain/fieldLayout.js';
import { CoarseFieldMap } from './coarseField.js';

/** Host a cut field's nav maps for one sector room. */
export interface NavAddFieldCmd { type: 'ADD_FIELD'; worldId: number; opts: ChunkOpts }
/** Free a sector room's nav maps (room dispose). */
export interface NavRemoveFieldCmd { type: 'REMOVE_FIELD'; worldId: number }
export type NavCommand = NavAddFieldCmd | NavRemoveFieldCmd;

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

export class NavHost {
  private readonly fields = new Map<number, CoarseFieldMap>();

  /** `now`: a millisecond clock for print-only build timings (real time). */
  constructor(private readonly now: () => number) {}

  /** Fields hosted (diagnostics, tests). */
  get fieldCount(): number { return this.fields.size; }

  /** The coarse layer hosted for `worldId`, if any. */
  coarse(worldId: number): CoarseFieldMap | undefined { return this.fields.get(worldId); }

  /** Runs one command; returns the reply to post, if any. */
  handle(cmd: NavCommand): NavReply | null {
    if (cmd.type === 'ADD_FIELD') {
      const t0 = this.now();
      const map = this.fields.get(cmd.worldId) ?? new CoarseFieldMap();
      map.build(cmd.opts);
      this.fields.set(cmd.worldId, map);
      return {
        type: 'FIELD_BUILT', worldId: cmd.worldId, cols: map.cols, rows: map.rows,
        bytes: map.room.byteLength + map.bestX.byteLength + map.bestY.byteLength, ms: this.now() - t0,
      };
    }
    this.fields.delete(cmd.worldId);
    return null;
  }
}
