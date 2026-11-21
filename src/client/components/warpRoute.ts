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
 * and a gate's part boxes through the shared `gateHitBoxes` (the same boxes the
 * server's swarm record carries, doors posed shut), so both sides test the
 * same boxes (#15).
 *
 * The field's rock body is ONE `CoarseFieldMap` per sector, built on first use
 * from the cut field's own options (`CutFieldClient.fieldOpts`, the same
 * `cutFieldOpts(seed, clearings)` the server's map is built from) and reused.
 * Gathering reuses its lists (no allocation per recompute once warm, #14).
 */
import { CoarseFieldMap } from '../../core/nav/coarseField.js';
import type { WarpStructureFootprint, WarpStructureSource } from '../../core/nav/warpLineStop.js';
import { fillWarpStructureFootprint } from '../../core/galaxy/warpTarget.js';
import { gateHitBoxes } from '../../core/structures/doorLeafBoxes.js';
import type { ChunkOpts } from '../../core/terrain/fieldLayout.js';

/** A structure's swarm entry: the fields the footprint reads. */
export interface WarpRouteSwarmEntry { x: number; y: number; angle: number; shipKind?: string }

/** The slice of the render mirror the adapter reads. */
export interface WarpRouteMirror {
  structures?: ReadonlyMap<number, { mirror?: boolean }>;
  swarm?: ReadonlyMap<number, WarpRouteSwarmEntry>;
}

interface GateBoxEntry { kind: string; angle: number; mirror: boolean; boxes: Float32Array | null }

const RAD_TO_DEG = 180 / Math.PI;

export class WarpRouteClient implements WarpStructureSource {
  private field: CoarseFieldMap | null = null;
  private fieldFrom: ChunkOpts | null = null;
  private readonly list: WarpRouteSwarmEntry[] = [];
  private readonly mirrored: boolean[] = [];
  private readonly ids: number[] = [];
  /** Gate part boxes per structure id, rebuilt only when its kind/pose changes. */
  private readonly gateBoxes = new Map<number, GateBoxEntry>();

  /** `WarpStructureSource`: the structures gathered by the last `gather`. */
  get count(): number { return this.list.length; }

  footprint(i: number, out: WarpStructureFootprint): void {
    const e = this.list[i]!;
    fillWarpStructureFootprint(e.shipKind, e.x, e.y, e.angle * RAD_TO_DEG, this.boxesFor(this.ids[i]!, e, this.mirrored[i]!), out);
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
    const l = this.list, ids = this.ids, mir = this.mirrored;
    let n = 0;
    const rows = mirror?.structures, swarm = mirror?.swarm;
    if (rows && swarm) {
      for (const [id, row] of rows) {
        const e = swarm.get(id);
        if (e === undefined || e.shipKind === undefined) continue;
        l[n] = e; ids[n] = id; mir[n] = row.mirror === true; n++;
      }
    }
    l.length = n; ids.length = n; mir.length = n;
    return this;
  }

  private boxesFor(id: number, e: WarpRouteSwarmEntry, mirror: boolean): Float32Array | null {
    const kind = e.shipKind ?? '';
    let g = this.gateBoxes.get(id);
    if (g === undefined || g.kind !== kind || g.angle !== e.angle || g.mirror !== mirror) {
      g = { kind, angle: e.angle, mirror, boxes: gateHitBoxes(kind, e.angle, mirror) };
      this.gateBoxes.set(id, g);
    }
    return g.boxes;
  }
}
