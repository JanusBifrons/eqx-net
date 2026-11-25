/**
 * Warp route check, slice S3 (client): the client's adapter onto the shared
 * warp-target rules (`core/galaxy/warpTarget.ts`), the mirror of the server's
 * `rooms/warpRouteCheck.ts`.
 *
 * Structures come from the structure mirror: every row of `mirror.structures`
 * (room state holds ALL of a sector's structures) with its pose and kind from
 * its `mirror.swarm` entry (structure swarm entries are never swept while the
 * row lives). Never predWorld bodies: those are streamed by distance. Each
 * footprint goes through the one shared fill (`fillWarpStructureFootprint`)
 * and a gate's part boxes through the shared `gateHitBoxes` + `writeDoorLeafBoxes`
 * with the LIVE door positions (`doorPosAt` of the row's decoded door segments
 * at the mirror's rig clock), the same boxes `GateController` re-poses on the
 * server's swarm record, so both sides test the same boxes (#15).
 *
 * The field's rock body is ONE `CoarseFieldMap` per sector, built on first use
 * from the cut field's own options (`CutFieldClient.fieldOpts`, the same
 * `cutFieldOpts(seed, clearings)` the server's map is built from) and reused.
 * Gathering reuses its lists (no allocation per recompute once warm, #14).
 */
import { CoarseFieldMap } from '../../core/nav/coarseField.js';
import type { WarpStructureFootprint, WarpStructureSource } from '../../core/nav/warpLineStop.js';
import { fillWarpStructureFootprint } from '../../core/galaxy/warpTarget.js';
import { doorRestPos, gateHitBoxes, writeDoorLeafBoxes } from '../../core/structures/doorLeafBoxes.js';
import { doorPosAt, type DoorSegment } from '../../core/structures/doorMotion.js';
import type { ChunkOpts } from '../../core/terrain/fieldLayout.js';

/** A structure's swarm entry: the fields the footprint reads. */
export interface WarpRouteSwarmEntry { x: number; y: number; angle: number; shipKind?: string }

/** A structure row: the build mirror and a door kind's decoded door segments. */
export interface WarpRouteRow { mirror?: boolean; doorA?: DoorSegment; doorB?: DoorSegment }

/** The slice of the render mirror the adapter reads. */
export interface WarpRouteMirror {
  structures?: ReadonlyMap<number, WarpRouteRow>;
  swarm?: ReadonlyMap<number, WarpRouteSwarmEntry>;
  /** The rig clip clock (server tick numbering) the doors are posed at. */
  rigTick?: number;
}

interface GateBoxEntry { kind: string; angle: number; mirror: boolean; boxes: Float32Array | null }

const RAD_TO_DEG = 180 / Math.PI;

export class WarpRouteClient implements WarpStructureSource {
  private field: CoarseFieldMap | null = null;
  private fieldFrom: ChunkOpts | null = null;
  private readonly list: WarpRouteSwarmEntry[] = [];
  private readonly rowList: WarpRouteRow[] = [];
  private readonly ids: number[] = [];
  private tick = 0;
  /** The rows the last `gather` walked (for the prune), and its swarm. */
  private rows: ReadonlyMap<number, WarpRouteRow> | null = null;
  private swarm: ReadonlyMap<number, WarpRouteSwarmEntry> | null = null;
  private n = 0;
  /** Gate part boxes per structure id, rebuilt only when its kind/pose changes. */
  private readonly gateBoxes = new Map<number, GateBoxEntry>();

  /** `WarpStructureSource`: the structures gathered by the last `gather`. */
  get count(): number { return this.list.length; }

  footprint(i: number, out: WarpStructureFootprint): void {
    const e = this.list[i]!;
    fillWarpStructureFootprint(e.shipKind, e.x, e.y, e.angle * RAD_TO_DEG, this.boxesFor(this.ids[i]!, e, this.rowList[i]!), out);
  }

  /** The sector's field map, built once per field (generation-time cost). */
  fieldMap(opts: ChunkOpts | null): CoarseFieldMap | null {
    if (opts === null) return null;
    if (this.fieldFrom !== opts) {
      const m = this.field ?? new CoarseFieldMap();
      m.build(opts);
      this.field = m;
      this.fieldFrom = opts;
    }
    return this.field;
  }

  /** Collect the mirror's structures (rows with a known pose and kind). */
  gather(mirror: WarpRouteMirror | null | undefined): this {
    this.n = 0;
    this.tick = mirror?.rigTick ?? 0;
    const rows = mirror?.structures ?? null, swarm = mirror?.swarm ?? null;
    this.rows = rows; this.swarm = swarm;
    if (rows !== null && swarm !== null) rows.forEach(this.collect);
    const n = this.n;
    this.list.length = n; this.ids.length = n; this.rowList.length = n;
    // Forget the gate boxes of structures that are gone (alloc-free walk).
    this.gateBoxes.forEach(this.prune);
    return this;
  }

  private readonly collect = (row: WarpRouteRow, id: number): void => {
    const e = this.swarm!.get(id);
    if (e === undefined || e.shipKind === undefined) return;
    const n = this.n++;
    this.list[n] = e; this.ids[n] = id; this.rowList[n] = row;
  };

  private readonly prune = (_g: GateBoxEntry, id: number, m: Map<number, GateBoxEntry>): void => {
    if (this.rows === null || !this.rows.has(id)) m.delete(id);
  };

  /** The gate's part boxes, its door leaves posed live (at rest when the row
   *  carries no door: `doorRestPos`, a chamber open, a gate shut). Rebuilt
   *  only when the kind/pose/mirror changes. */
  private boxesFor(id: number, e: WarpRouteSwarmEntry, row: WarpRouteRow): Float32Array | null {
    const kind = e.shipKind ?? '';
    const mirror = row.mirror === true;
    let g = this.gateBoxes.get(id);
    if (g === undefined || g.kind !== kind || g.angle !== e.angle || g.mirror !== mirror) {
      g = { kind, angle: e.angle, mirror, boxes: gateHitBoxes(kind, e.angle, mirror) };
      this.gateBoxes.set(id, g);
    }
    if (g.boxes !== null) {
      const rest = doorRestPos(kind);
      const posA = row.doorA !== undefined ? doorPosAt(row.doorA, this.tick) : rest;
      const posB = row.doorB !== undefined ? doorPosAt(row.doorB, this.tick) : rest;
      writeDoorLeafBoxes(kind, e.angle, posA, posB, g.boxes);
    }
    return g.boxes;
  }

  /** Gate-box cache size (tests: the prune). */
  get cachedGateBoxes(): number { return this.gateBoxes.size; }
}
