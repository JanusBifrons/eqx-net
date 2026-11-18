/**
 * The room's one obstacle gatherer (navigation plan, Stage E slice 2).
 *
 * Every question of the form "what solid things are near here?" reads this:
 * structure placement and connection line of sight (`rocks`; placement alone
 * opts in to wreck pieces, loaded and not), warp / trip /
 * fleet landing (`landing`), join spawns (`structureBoxes`, `hullCircles`) and
 * convoy spawns. It replaced four hand-written gathers in `SectorRoom` that
 * each saw a different subset (landing missed field rocks with no body and
 * shield walls).
 *
 * Outputs are scratch: each call refills the same arrays with the same pooled
 * records, so a caller must use the result before its next call and never
 * keep it. Field rocks whose chunk is not loaded come from the cut field's
 * `dormantObstacles` (a layout cut; it allocates, discrete actions only).
 */
import type { GridObstacle, ObstacleBox } from '../../core/structures/Grid.js';
import { rockObstacleParts } from '../../core/structures/Grid.js';
import type { SiteBox, SiteCircle, SiteSegment } from '../../core/bases/baseSite.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';
import { SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { PAD_SPECS, isTeleporterKind, padPostCenters } from '../../shared-types/teleport.js';
import { SWARM_KIND_WRECK } from '../../shared-types/swarmWireFormat.js';

/** Receives each pilot hull (active ship or parked hull). */
export interface HullSink {
  /** `shipId` is set for a parked (lingering) hull, unset for an active ship;
   *  `pending` marks a pilot still joining (not in the world yet). */
  hull(x: number, y: number, kind: string | undefined, playerId: string | undefined, shipId: string | undefined, pending: boolean): void;
}

/** Receives each blocking shield wall / closed gate span. */
export interface WallSink {
  wall(ax: number, ay: number, bx: number, by: number, halfThickness: number): void;
}

export interface SectorObstacleSources {
  structures: { all(): Iterable<StructureRecord> };
  swarm: { all(): Iterable<SwarmEntityRecord> };
  sab(): Float32Array;
  /** Field rocks reaching into `box` that have no body now (cut field only);
   *  with `wrecks`, also the wreck field's unloaded hull pieces. */
  dormantRocks?(box: ObstacleBox, out: GridObstacle[], wrecks?: boolean): void;
  /** Every pilot's active ship and parked hull. */
  forEachHull(sink: HullSink): void;
  /** Every wall that blocks right now. */
  forEachWall?(sink: WallSink): void;
  /** A ship kind's clearance against other hulls and walls (#18). */
  clearanceOf(kind: string | undefined): number;
  /** A ship kind's extent for join spacing (hull radius + shield pad, #18);
   *  undefined for an id that is not a ship kind. */
  extentOf(kind: string): number | undefined;
}

/** Which hulls `landing` / `hullCircles` skip. */
interface HullFilter {
  mode: 'landing' | 'join';
  playerId: string;
  skipOwn: boolean;
  onlySkipShipId: string | undefined;
  x: number;
  y: number;
  near: number;
}

/** A rock's narrow-phase parts by outline, built once per outline (a field
 *  rock's convex hull, or an asteroid's outline wrapped as one part). */
const partsCache = new WeakMap<object, NonNullable<GridObstacle['parts']>>();

function rockParts(rec: SwarmEntityRecord): GridObstacle['parts'] {
  if (rec.wreckParts) return rec.wreckParts;
  if (!rec.vertices) return undefined;
  let p = partsCache.get(rec.vertices);
  if (!p) { p = rockObstacleParts(rec.vertices, null, rec.fieldRock === true)!; partsCache.set(rec.vertices, p); }
  return p;
}

export class SectorObstacles implements HullSink, WallSink {
  /** Rocks (live + dormant) from the last `rocks` call. */
  readonly rockList: GridObstacle[] = [];
  /** Structure solid boxes from the last `landing` / `structureBoxes` call. */
  readonly boxes: SiteBox[] = [];
  /** Bodies and hulls as circles from the last `landing` / `hullCircles` call. */
  readonly circles: SiteCircle[] = [];
  /** Blocking walls from the last `landing` call. */
  readonly walls: SiteSegment[] = [];

  private readonly rockPool: GridObstacle[] = [];
  private readonly boxPool: SiteBox[] = [];
  private readonly circlePool: SiteCircle[] = [];
  private readonly wallPool: SiteSegment[] = [];
  private readonly dormant: GridObstacle[] = [];
  private readonly filter: HullFilter = { mode: 'landing', playerId: '', skipOwn: true, onlySkipShipId: undefined, x: 0, y: 0, near: Infinity };
  private readonly nearBox: ObstacleBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(private readonly src: SectorObstacleSources) {}

  /** Live asteroids and field rocks (swarm kind 0, SAB pose, collider parts),
   *  plus with `near` the field rocks in that box that have no body. Placement
   *  and connection line of sight. `wrecks` (placement and its preview only,
   *  wreck fields 7 / plan R13): also wreck pieces (kind 4, battle and field,
   *  by their parts) and, with `near`, the wreck field's unloaded hulls. Off
   *  for the link line-of-sight sweep, so links never change. */
  rocks(near?: ObstacleBox, wrecks = false): GridObstacle[] {
    const out = this.rockList, f = this.src.sab();
    let n = 0;
    for (const rec of this.src.swarm.all()) {
      if (rec.kind !== 0 && !(wrecks && rec.kind === SWARM_KIND_WRECK)) continue;
      const b = slotBase(rec.slot);
      const o = this.rockPool[n] ??= { x: 0, y: 0, radius: 0 };
      o.x = f[b + SLOT_X_OFF]!; o.y = f[b + SLOT_Y_OFF]!; o.radius = rec.radius; o.angle = f[b + SLOT_ANGLE_OFF]!;
      o.parts = rockParts(rec);
      out[n++] = o;
    }
    out.length = n;
    if (near && this.src.dormantRocks) this.src.dormantRocks(near, out, wrecks);
    return out;
  }

  /** Solid structure boxes (a teleporter's pad is open: only its posts). */
  structureBoxes(): SiteBox[] {
    const out = this.boxes;
    let n = 0;
    for (const r of this.src.structures.all()) {
      if (isTeleporterKind(r.kind)) {
        const h = PAD_SPECS[r.kind].post / 2;
        for (const [cx, cy] of padPostCenters(r.kind)) n = this.pushBox(n, r.x + cx, r.y + cy, h, h);
      } else {
        n = this.pushBox(n, r.x, r.y, r.halfW ?? r.radius, r.halfH ?? r.radius);
      }
    }
    out.length = n;
    return out;
  }

  /** Everything a landing ship must stay clear of within `near` of (x, y):
   *  structure boxes, every swarm body (rocks, drones, scrap, wrecks, pods)
   *  and field rocks with no body, other pilots' ships and parked hulls (the
   *  pilot's own are skipped; with `onlySkipShipId` only that ship is), and
   *  blocking walls. Fills `boxes`, `circles`, `walls`. */
  landing(playerId: string, x: number, y: number, near: number, onlySkipShipId?: string): void {
    this.structureBoxes();
    const f = this.src.sab(), circles = this.circles;
    let n = 0;
    for (const rec of this.src.swarm.all()) {
      const b = slotBase(rec.slot);
      const ex = f[b + SLOT_X_OFF]!, ey = f[b + SLOT_Y_OFF]!;
      if (Math.abs(ex - x) > near || Math.abs(ey - y) > near) continue;
      n = this.pushCircle(n, ex, ey, rec.radius);
    }
    if (this.src.dormantRocks) {
      const box = this.nearBox, d = this.dormant;
      box.x0 = x - near; box.y0 = y - near; box.x1 = x + near; box.y1 = y + near;
      d.length = 0;
      this.src.dormantRocks(box, d);
      for (const o of d) n = this.pushCircle(n, o.x, o.y, o.radius);
    }
    circles.length = n;
    const flt = this.filter;
    flt.mode = 'landing'; flt.playerId = playerId; flt.skipOwn = onlySkipShipId === undefined;
    flt.onlySkipShipId = onlySkipShipId; flt.x = x; flt.y = y; flt.near = near;
    this.src.forEachHull(this);
    this.walls.length = 0;
    this.src.forEachWall?.(this);
  }

  /** Every other hull in the sector as a circle of its own extent: AI-flown
   *  ships (swarm kind 1), other pilots' ships and parked hulls. The joining
   *  pilot's own hulls and pilots still joining are skipped. Fills `circles`. */
  hullCircles(playerId: string): SiteCircle[] {
    const f = this.src.sab();
    let n = 0;
    for (const rec of this.src.swarm.all()) {
      if (rec.kind !== 1) continue;
      const b = slotBase(rec.slot);
      n = this.pushCircle(n, f[b + SLOT_X_OFF]!, f[b + SLOT_Y_OFF]!, (rec.shipKind ? this.src.extentOf(rec.shipKind) : undefined) ?? rec.radius);
    }
    this.circles.length = n;
    const flt = this.filter;
    flt.mode = 'join'; flt.playerId = playerId; flt.skipOwn = true; flt.onlySkipShipId = undefined; flt.near = Infinity;
    this.src.forEachHull(this);
    return this.circles;
  }

  /** @internal HullSink: applies the current filter. */
  hull(x: number, y: number, kind: string | undefined, playerId: string | undefined, shipId: string | undefined, pending: boolean): void {
    const flt = this.filter;
    if (flt.mode === 'join') {
      if (!kind || playerId === flt.playerId || (shipId === undefined && pending)) return;
      const e = this.src.extentOf(kind);
      if (e !== undefined) this.circles[this.circles.length] = this.circleAt(this.circles.length, x, y, e);
      return;
    }
    if (Math.abs(x - flt.x) > flt.near || Math.abs(y - flt.y) > flt.near) return;
    if (shipId === undefined) {
      if (flt.skipOwn && playerId === flt.playerId) return;
    } else if (shipId === flt.onlySkipShipId || (flt.skipOwn && playerId === flt.playerId)) {
      return;
    }
    this.circles[this.circles.length] = this.circleAt(this.circles.length, x, y, this.src.clearanceOf(kind));
  }

  /** @internal WallSink. */
  wall(ax: number, ay: number, bx: number, by: number, halfThickness: number): void {
    const i = this.walls.length;
    const s = this.wallPool[i] ??= { ax: 0, ay: 0, bx: 0, by: 0, r: 0 };
    s.ax = ax; s.ay = ay; s.bx = bx; s.by = by; s.r = halfThickness;
    this.walls[i] = s;
  }

  private pushBox(n: number, x: number, y: number, hw: number, hh: number): number {
    const o = this.boxPool[n] ??= { x: 0, y: 0, hw: 0, hh: 0 };
    o.x = x; o.y = y; o.hw = hw; o.hh = hh;
    this.boxes[n] = o;
    return n + 1;
  }

  private pushCircle(n: number, x: number, y: number, r: number): number {
    this.circles[n] = this.circleAt(n, x, y, r);
    return n + 1;
  }

  private circleAt(i: number, x: number, y: number, r: number): SiteCircle {
    const o = this.circlePool[i] ??= { x: 0, y: 0, r: 0 };
    o.x = x; o.y = y; o.r = r;
    return o;
  }
}
