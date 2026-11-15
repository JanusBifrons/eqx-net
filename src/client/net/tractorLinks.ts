/**
 * The tractor client slice (salvage plan PR 11b). Ship tractor links ride the
 * snapshot's beam links (`shared-types/beamLinksWire.ts`); every snapshot
 * this:
 * - decodes them into `mirror.tractorLinks` (the renderer draws them,
 *   `render/tractorBeams.ts`), so a late joiner sees a held beam from the
 *   snapshot alone (#16);
 * - mirrors each one as a tractor force field in the prediction world, built
 *   by the server's own helpers (`core/combat/tractorField.ts`, #15), so a
 *   pulled local ship is predicted pulled instead of rubber-banding.
 *
 * Snapshot cadence, allocation-free once the pools have grown (#14). The
 * server's beam-line bodies are not on the wire, so the client field pulls
 * only the target (`lineCount` 0). A lease the snapshot drops ends its field.
 */
import type { BeamLinkVisitor, BeamLinks } from '../../shared-types/beamLinksWire.js';
import { forEachBeamLink } from '../../shared-types/beamLinksWire.js';
import { TRACTOR_LINE_CAP, type ForceField, type TractorForceField } from '../../core/physics/forceFields.js';
import { setTractorHold, setTractorMountConstants, setTractorMuzzle } from '../../core/combat/tractorField.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { findMount } from '../render/beamStyles.js';

/** One live tractor beam (a `RenderMirror.tractorLinks` row). `emitter` /
 *  `target`: a swarm entity's numeric id or a pilot's playerId. */
export interface TractorLinkRow {
  emitter: number | string;
  mountId: string;
  target: number | string;
}

/** What the slice reads of the client's mirror (poses, kinds). */
export interface TractorMirrorView {
  ships: ReadonlyMap<string, { x: number; y: number; angle: number; vx: number; vy: number; kind?: string }>;
  swarm?: ReadonlyMap<number, { x: number; y: number; angle: number; vx: number; vy: number; kind?: number; shipKind?: string; radius?: number }>;
  tractorLinks?: TractorLinkRow[];
}

/** The prediction world's force-field seam (`PhysicsWorld`). */
export interface TractorPredWorld {
  setForceField(id: string, field: ForceField): void;
  removeForceField(id: string): void;
}

const FIELD_ID_PREFIX = 'tractor-link-';

export class TractorLinkClient {
  private readonly pool: TractorLinkRow[] = [];
  /** The live rows, in wire order (this array IS `mirror.tractorLinks`). */
  readonly live: TractorLinkRow[] = [];
  private n = 0;
  /** predWorld field ids, one per live-row slot (built once per slot). */
  private readonly fieldIds: string[] = [];
  /** Slots holding a predWorld field after the last sync. */
  private fieldCount = 0;
  private lastWorld: TractorPredWorld | null = null;
  private readonly field: TractorForceField = {
    kind: 'tractor', active: false, mx: 0, my: 0, mvx: 0, mvy: 0, target: '', emitter: '',
    force: 0, dRef: 1, reach: 0, hold: 0, lineHalfWidth: 0, lineFrac: 0,
    lineCount: 0, lineIds: new Array<string>(TRACTOR_LINE_CAP).fill(''),
  };

  constructor(
    private readonly mirror: TractorMirrorView,
    /** predWorld body id of a swarm entity (the client's `swarm-<id>` cache). */
    private readonly swarmBodyKeys: ReadonlyMap<number, string>,
  ) {
    mirror.tractorLinks = this.live;
  }

  /** The visitor's tractor arm: append one link (decode order kept). */
  readonly add: BeamLinkVisitor['tractor'] = (emitter, mountId, target) => {
    let row = this.pool[this.n];
    if (row === undefined) {
      row = { emitter: 0, mountId: '', target: 0 };
      this.pool.push(row);
    }
    row.emitter = emitter; row.mountId = mountId; row.target = target;
    this.live[this.n++] = row;
  };

  /**
   * One snapshot's beam links: walk them with `visitor` (whose `tractor` arm
   * is `add`), keep exactly the links present, then mirror them into
   * `world` (null: no prediction world yet).
   */
  sync(links: Readonly<BeamLinks> | undefined, visitor: BeamLinkVisitor, world: TractorPredWorld | null): void {
    this.n = 0;
    if (links !== undefined) forEachBeamLink(links, visitor);
    this.live.length = this.n;
    this.syncPredWorld(world);
  }

  private syncPredWorld(world: TractorPredWorld | null): void {
    if (world !== this.lastWorld) { this.fieldCount = 0; this.lastWorld = world; } // a new world has no fields
    if (world === null) return;
    let set = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.fillField(this.live[i]!)) continue;
      let id = this.fieldIds[set];
      if (id === undefined) { id = FIELD_ID_PREFIX + set; this.fieldIds[set] = id; } // once per slot
      world.setForceField(id, this.field);
      set++;
    }
    for (let i = set; i < this.fieldCount; i++) world.removeForceField(this.fieldIds[i]!);
    this.fieldCount = set;
  }

  /** The predWorld field for `row` into the scratch; false when its emitter
   *  pose, mount or target body is unknown here. */
  private fillField(row: TractorLinkRow): boolean {
    const target = this.bodyId(row.target);
    const emitter = this.bodyId(row.emitter);
    if (target === null || emitter === null) return false;
    const m = this.mirror;
    const e = typeof row.emitter === 'number' ? m.swarm?.get(row.emitter) : m.ships.get(row.emitter);
    if (e === undefined) return false;
    const kindId = typeof row.emitter === 'number'
      ? (e as { shipKind?: string }).shipKind
      : (e as { kind?: string }).kind;
    const mount = findMount(getShipKind(kindId ?? null).mounts, row.mountId);
    const f = this.field;
    if (mount === null || !setTractorMountConstants(f, mount)) return false;
    setTractorMuzzle(f, e.x, e.y, e.angle, mount);
    // The cushion keeps the load off the emitter's own hull (the server's, #15).
    const t = typeof row.target === 'number' ? m.swarm?.get(row.target) : m.ships.get(row.target);
    if (t === undefined) return false;
    // The load's radius as the server reads it (`fillRangeShape`): a ship's
    // kind radius, anything else its wire radius.
    let tr: number;
    if (typeof row.target === 'number') {
      const sw = t as { kind?: number; shipKind?: string; radius?: number };
      tr = sw.kind === 1 ? getShipKind(sw.shipKind ?? null).radius : (sw.radius ?? 0);
    } else {
      tr = getShipKind((t as { kind?: string }).kind ?? null).radius;
    }
    setTractorHold(f, mount, kindId, e.angle, t.x, t.y, tr);
    f.mvx = e.vx; f.mvy = e.vy;
    f.target = target; f.emitter = emitter;
    f.active = true;
    f.lineCount = 0;
    return true;
  }

  /** predWorld body id of a wire ref: a pilot's playerId, a swarm entity's
   *  cached `swarm-<id>` key (null until it has a body). */
  private bodyId(ref: number | string): string | null {
    return typeof ref === 'number' ? (this.swarmBodyKeys.get(ref) ?? null) : ref;
  }
}
