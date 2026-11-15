/**
 * Force fields — the room's one owner of which fields exist in its physics
 * world (`core/physics/forceFields.ts`). Every `SET_FORCE_FIELD` /
 * `REMOVE_FORCE_FIELD` the room sends goes through here, so a feature that
 * pushes bodies (teleporter pads, tractor beams; gravity wells later) adds a
 * field here instead of posting to the worker itself.
 *
 * Tractor beams (salvage plan PR 11) are LEASES: each accepted fire of a
 * tractor mount (`renewTractor`, reached from every fire path through the
 * weapon flyweight's `sink.tractor`) keeps (emitter, mount) → target alive for
 * the weapon's `leaseTicks`. `tickTractors` re-poses each live lease's field
 * every tick (muzzle = the mount's world origin, its velocity by difference,
 * the beam-line set from the room's shared line query) and removes it on
 * expiry. `beamLinks` puts the live leases on the snapshot beside the
 * structure beams (one encoding, `shared-types/beamLinksWire.ts`).
 * Guide: docs/architecture/physics-worker.md "Force fields".
 */
import { TRACTOR_LINE_CAP, type ForceField, type TractorForceField } from '../../core/physics/forceFields.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { setTractorHold, setTractorMountConstants, setTractorMuzzle } from '../../core/combat/tractorField.js';
import { encodeTractorLink, type BeamLinks } from '../../shared-types/beamLinksWire.js';
import type { WeaponMount } from '../../shared-types/shipKinds.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

/** Most live tractor leases per room (salvage plan perf guard: the wire cap). */
export const TRACTOR_LEASE_CAP = 128;

/** A body's live centre and heading (the room's fire-target shape view,
 *  `AiFireTargetShape`; the extra fields are written, never read here). */
export interface TractorPoseOut {
  x: number; y: number; angle?: number; kindId?: string | null; shieldUp?: boolean; radius?: number;
}

/** The body id a player's lock key names (`s:<entityId>` a swarm entity,
 *  `p:<playerId>` a pilot), or null. Fire path only (slices the key). */
export function lockKeyBodyId(
  key: string | null, swarm: { getByEntityId(entityId: number): { id: string } | null | undefined },
): string | null {
  if (key === null) return null;
  if (key.startsWith('p:')) return key.slice(2);
  if (key.startsWith('s:')) return swarm.getByEntityId(Number(key.slice(2)))?.id ?? null;
  return null;
}

/** What the tractor leases need of the room. Absent ⇒ tractors are inert. */
export interface TractorDeps {
  /** Current server tick. */
  tick(): number;
  /** Fill `out` with body `id`'s live centre (and a ship's heading); false
   *  when it is gone. */
  poseOf(id: string, out: TractorPoseOut): boolean;
  /** Up to `cap` bodies on the segment within `halfWidth`, skipping two ids
   *  (`LineOfFireGate.lineBodies`); returns the count. */
  lineBodies(fx: number, fy: number, tx: number, ty: number, halfWidth: number,
    skipA: string, skipB: string, ids: string[], cap: number): number;
  /** True while `id` is a wreck piece in its crack hold (no pull then). */
  inCrackHold(id: string): boolean;
  /** Snapshot ref of a body: a swarm entity's numeric id, else the id. */
  wireRef(id: string): number | string;
  /** A ship (not terrain) was tractored: the room's hostile-act seam. */
  onShipTractored(emitterId: string, targetId: string): void;
  /** Is `id` terrain (rock, loot pod, wreck piece: neutral to lock and pull)? */
  isTerrain(id: string): boolean;
}

export interface ForceFieldDeps {
  /** Send a command to this room's physics worker. */
  post(cmd: WorkerCmd): void;
  tractors?: TractorDeps;
}

interface TractorLease {
  readonly fieldId: string;
  readonly emitter: string;
  readonly mount: WeaponMount;
  target: string;
  startTick: number;
  endTick: number;
  /** Last muzzle position (for the muzzle velocity); NaN until first tick. */
  px: number;
  py: number;
  readonly field: TractorForceField;
}

const _pose: TractorPoseOut = { x: 0, y: 0, angle: 0, kindId: null, shieldUp: false, radius: 0 };
const _tpose: TractorPoseOut = { x: 0, y: 0, angle: 0, kindId: null, shieldUp: false, radius: 0 };

export class ForceFieldSubsystem {
  private readonly fields = new Map<string, ForceField>();
  /** emitter → mount id → lease (one lease per mount). */
  private readonly leases = new Map<string, Map<string, TractorLease>>();
  private leaseCount = 0;
  private readonly _links: BeamLinks = [];

  constructor(private readonly d: ForceFieldDeps) {}

  /** Add or update a field (idempotent on `id`). Takes ownership of `field`. */
  set(id: string, field: ForceField): void {
    this.fields.set(id, field);
    this.d.post({ type: 'SET_FORCE_FIELD', id, field });
  }

  /** Remove a field; a no-op in the worker for an unknown id. */
  remove(id: string): void {
    this.fields.delete(id);
    this.d.post({ type: 'REMOVE_FORCE_FIELD', id });
  }

  get(id: string): Readonly<ForceField> | undefined {
    return this.fields.get(id);
  }

  get size(): number {
    return this.fields.size;
  }

  /** Live tractor leases. */
  get tractorCount(): number {
    return this.leaseCount;
  }

  /**
   * An accepted fire of tractor `mount` on `emitterId` at its locked
   * `targetId`: start or renew that mount's lease for the weapon's
   * `leaseTicks`. A new target (or a lapsed lease) restarts it. The caller
   * already passed the lock gate and paid energy (#19). Tractoring a ship is a
   * hostile act (`onShipTractored`); terrain is neutral. Returns false when
   * refused (no tractor weapon, no target, a self-target, the lease cap).
   * `leaseTicks` overrides the weapon's lease (the `test_tractor` cue only).
   */
  renewTractor(emitterId: string, mount: WeaponMount, targetId: string | null | undefined, leaseTicks?: number): boolean {
    const t = this.d.tractors;
    const spec = getWeapon(mount.weaponId).tractor;
    if (t === undefined || spec === undefined || !targetId || targetId === emitterId) return false;
    const tick = t.tick();
    let byMount = this.leases.get(emitterId);
    let lease = byMount?.get(mount.id);
    if (lease === undefined) {
      if (this.leaseCount >= TRACTOR_LEASE_CAP) return false;
      // Once per (emitter, mount): fire is a discrete, cooldown-gated event.
      if (byMount === undefined) { byMount = new Map(); this.leases.set(emitterId, byMount); }
      lease = {
        fieldId: `tractor:${emitterId}:${mount.id}`, emitter: emitterId, mount, target: '',
        startTick: tick, endTick: tick, px: NaN, py: NaN,
        field: {
          kind: 'tractor', active: false, mx: 0, my: 0, mvx: 0, mvy: 0, target: '', emitter: emitterId,
          force: 0, dRef: spec.dRef, reach: 0, hold: spec.hold, lineHalfWidth: spec.lineHalfWidth,
          lineFrac: spec.lineFrac, lineCount: 0, lineIds: new Array<string>(TRACTOR_LINE_CAP).fill(''),
        },
      };
      byMount.set(mount.id, lease);
      this.leaseCount++;
    }
    if (lease.target !== targetId || tick >= lease.endTick) {
      lease.target = targetId;
      lease.startTick = tick;
      lease.px = NaN;
    }
    lease.endTick = tick + (leaseTicks ?? spec.leaseTicks);
    const f = lease.field;
    f.target = targetId;
    setTractorMountConstants(f, mount); // shared with the client predWorld (#15)
    if (!t.isTerrain(targetId)) t.onShipTractored(emitterId, targetId);
    return true;
  }

  /**
   * Once per server tick: expire lapsed leases (REMOVE_FORCE_FIELD) and
   * re-pose each live one (SET_FORCE_FIELD): muzzle at the mount's world
   * origin, muzzle velocity by difference, the beam-line set (cap 8). A lease
   * whose emitter or target is gone ends now. Allocation-free (#14).
   */
  tickTractors(): void {
    const t = this.d.tractors;
    if (t === undefined || this.leaseCount === 0) return;
    const tick = t.tick();
    for (const [emitter, byMount] of this.leases) {
      for (const [mountId, lease] of byMount) {
        if (tick >= lease.endTick || !t.poseOf(emitter, _pose) || !t.poseOf(lease.target, _tpose)) {
          this.remove(lease.fieldId); // a no-op in the worker if never set
          byMount.delete(mountId);
          this.leaseCount--;
          continue;
        }
        const f = lease.field;
        setTractorMuzzle(f, _pose.x, _pose.y, _pose.angle ?? 0, lease.mount);
        // The cushion keeps the load off the emitter's own hull (shared, #15).
        setTractorHold(f, lease.mount, _pose.kindId, _pose.angle ?? 0, _tpose.x, _tpose.y, _tpose.radius ?? 0);
        // Game ticks are fixed 1/60 s steps (time scale changes their rate).
        const first = lease.px !== lease.px;
        f.mvx = first ? 0 : (f.mx - lease.px) * 60;
        f.mvy = first ? 0 : (f.my - lease.py) * 60;
        lease.px = f.mx; lease.py = f.my;
        // A freshly broken wreck moves only as one rigid body until its crack
        // hold ends: the beam holds on but does not pull yet.
        f.active = !t.inCrackHold(lease.target);
        f.lineCount = f.active
          ? t.lineBodies(f.mx, f.my, _tpose.x, _tpose.y, f.lineHalfWidth, emitter, lease.target, f.lineIds, TRACTOR_LINE_CAP)
          : 0;
        this.set(lease.fieldId, f);
      }
      if (byMount.size === 0) this.leases.delete(emitter);
    }
  }

  /**
   * The snapshot's beam links: `structure` (the structure beam triples) as is
   * when no tractor is live (byte-identical), else a reused array holding them
   * followed by one tractor record per live lease (`encodeTractorLink`).
   */
  beamLinks(structure: BeamLinks | undefined): BeamLinks | undefined {
    const t = this.d.tractors;
    if (t === undefined || this.leaseCount === 0) return structure;
    const out = this._links;
    let at = 0;
    if (structure !== undefined) for (let i = 0; i < structure.length; i++) out[at++] = structure[i]!;
    for (const [emitter, byMount] of this.leases) {
      for (const lease of byMount.values()) {
        at = encodeTractorLink(out, at, t.wireRef(emitter), lease.mount.id, t.wireRef(lease.target), lease.startTick, lease.endTick);
      }
    }
    out.length = at;
    return out;
  }
}
