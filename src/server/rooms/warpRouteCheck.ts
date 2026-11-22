/**
 * Warp route check, slice S2 (server): the room's adapter onto the shared
 * warp-target rules (`core/galaxy/warpTarget.ts`).
 *
 * Owner rule: a warp may not pass through the asteroid field's rock body or
 * any structure. The client offers either the destination's drop point (line
 * clear) or the near side of the first obstacle on the line; the server
 * accepts a requested point only when `isWarpTarget` holds for it toward one
 * of the sector's drop points (`warpDropPointInto`), from the pilot's
 * authoritative pose. A point already accepted for the pilot's spool or run
 * (`WarpTravelTracker.accepted`) is accepted again without a recompute, so a
 * structure placed mid-spool never cancels a warp.
 *
 * The field's rock body is one main-thread `CoarseFieldMap` per room (one room
 * per sector), built once on first use from the cut field's own options
 * (`cutFieldOpts(seed, clearings)`, `CutFieldSubsystem.navOpts`) and reused.
 * Structures come from the room's registry through the one shared footprint
 * fill (`fillWarpStructureFootprint`, #15). No allocation per request (#14).
 */
import { CoarseFieldMap } from '../../core/nav/coarseField.js';
import type { WarpStructureFootprint, WarpStructureSource } from '../../core/nav/warpLineStop.js';
import { fillWarpStructureFootprint, isWarpTarget, warpStopMargin, warpTargetFor, type WarpTarget } from '../../core/galaxy/warpTarget.js';
import { sectorSites, warpDropPointInto, type SectorSite } from '../../core/galaxy/sectorSites.js';
import type { ChunkOpts } from '../../core/terrain/fieldLayout.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';

export interface WarpRouteHooks {
  /** The room's sector key (null: engineering room, no warps). */
  sectorKey(): string | null;
  /** Solar-system sectors on (drop points exist only then). */
  solar(): boolean;
  /** The cut field's options (`CutFieldSubsystem.navOpts`); null: no field. */
  fieldOpts(): ChunkOpts | null;
  /** The room's structures (every kind blocks). */
  structures: { all(): Iterable<StructureRecord> };
  /** A gate's world-axis part boxes (its swarm record), else undefined. */
  gateBoxes(id: string): Float32Array | undefined;
  /** The pilot's authoritative pose (the room's SAB pose mirror). */
  pose(playerId: string): { x: number; y: number } | undefined;
  /** The pilot's active ship kind id. */
  kindOf(playerId: string): string | undefined;
  /** True when this exact point is the pilot's accepted spool/run target. */
  accepted(playerId: string, x: number, y: number): boolean;
}

export class WarpRouteCheck implements WarpStructureSource {
  private field: CoarseFieldMap | null = null;
  private fieldFrom: ChunkOpts | null = null;
  private sitesKey: string | null = null;
  private sites: readonly SectorSite[] = [];
  private readonly list: StructureRecord[] = [];
  private readonly rim = { x: 0, y: 0 };

  constructor(private readonly hooks: WarpRouteHooks) {}

  /** `WarpStructureSource`: the structures gathered by the last `gather`. */
  get count(): number { return this.list.length; }

  footprint(i: number, out: WarpStructureFootprint): void {
    const r = this.list[i]!;
    fillWarpStructureFootprint(r.kind, r.x, r.y, r.rot, this.hooks.gateBoxes(r.id), out);
  }

  /** The input handler's gate: may `playerId` warp to (x, y)? */
  valid(playerId: string, x: number, y: number): boolean {
    const h = this.hooks;
    if (h.accepted(playerId, x, y)) return true;
    const key = h.sectorKey();
    if (key === null || !h.solar()) return false;
    const p = h.pose(playerId);
    if (p === undefined) return false;
    const margin = warpStopMargin(getShipKind(h.kindOf(playerId)));
    const field = this.fieldMap();
    this.gather();
    const rim = this.rim;
    for (const s of this.sitesOf(key)) {
      warpDropPointInto(s, p.x, p.y, rim);
      if (isWarpTarget(p.x, p.y, x, y, rim.x, rim.y, field, this, margin)) return true;
    }
    return false;
  }

  /** The warp target toward (toX, toY) for a ship of `kind` at
   *  (fromX, fromY): the point itself when the line is clear, else the near
   *  side of the first obstacle (`warpTargetFor`). Writes and returns `out`. */
  targetFor(kind: string | undefined, fromX: number, fromY: number, toX: number, toY: number, out: WarpTarget): WarpTarget {
    const field = this.fieldMap();
    this.gather();
    return warpTargetFor(toX, toY, fromX, fromY, field, this, warpStopMargin(getShipKind(kind)), out);
  }

  /** The room's field map, built once (generation-time cost, never per tick). */
  private fieldMap(): CoarseFieldMap | null {
    const o = this.hooks.fieldOpts();
    if (o === null) return null;
    if (this.fieldFrom !== o) {
      const m = this.field ?? new CoarseFieldMap();
      m.build(o);
      this.field = m;
      this.fieldFrom = o;
    }
    return this.field;
  }

  private sitesOf(key: string): readonly SectorSite[] {
    if (this.sitesKey !== key) { this.sites = sectorSites(key); this.sitesKey = key; }
    return this.sites;
  }

  private gather(): void {
    const l = this.list;
    let n = 0;
    for (const r of this.hooks.structures.all()) l[n++] = r;
    l.length = n;
  }
}
