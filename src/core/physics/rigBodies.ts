import RAPIER from '@dimforge/rapier2d-compat';
import { RIG_PART_COLLISION_GROUPS, withoutRigParts } from './collisionGroups.js';
import type { Rig } from '../articulation/rig.js';
import { clipFinished, createRigPose, evaluateRig, type RigPose } from '../articulation/evaluate.js';
import { twoBoneIkSolve } from '../articulation/ikAdapter.js';

/** One rigged host's solid parts (`PhysicsWorld.attachRig`). */
interface RigBodies {
  readonly rig: Rig;
  readonly pose: RigPose;
  /** Kinematic body per part (rig order), or null (no collider). */
  readonly parts: (RAPIER.RigidBody | null)[];
  /** The clip record, owned and reused (`setRigClip` copies into it). */
  readonly playing: {
    clipId: string; startTick: number; target: { x: number; y: number } | undefined;
    /** Scrub (`PlayingClip.from` / `.rate`); undefined = a plain clip. */
    from: number | undefined; rate: number | undefined;
  };
  readonly targetScratch: { x: number; y: number };
  hasClip: boolean;
  /** Host world pose, cached (structures are static; `setShipState` updates it). */
  hostX: number;
  hostY: number;
  hostAngle: number;
  /** Must be re-posed (attach, new clip, host moved). */
  dirty: boolean;
  /** Nothing will move until a new clip or a host move. */
  idle: boolean;
}

/** Every rigged host's solid parts in one `PhysicsWorld` (its `rigs`): the
 *  world's `attachRig` / `setRigClip` / `stepRigs` / `rigPartPose` delegate
 *  here, and its `despawnShip` / `setShipState` / `setHullExposed` call
 *  `detachRig` / `noteRigHostPose` / `has`. */
export class RigBodySet {
  /** Rigged hosts' solid parts, by host id (`attachRig`), plus a flat list
   *  for the allocation-free per-tick walk (`stepRigs`). */
  private readonly rigs = new Map<string, RigBodies>();
  private readonly rigList: RigBodies[] = [];
  private readonly _rigTranslationScratch = { x: 0, y: 0 };

  constructor(private readonly world: RAPIER.World) {}

  /** Rigged hosts (0 ⇒ every rig hook is skipped). */
  get size(): number { return this.rigs.size; }

  has(hostId: string): boolean { return this.rigs.has(hostId); }

  // ── Rig parts (structure-restyle 2d, plan §5 / §8) ──────────────────────────
  //
  // Solid (`plane`-layer) rig parts are kinematic-position-based bodies beside
  // the wall bodies (shieldWallBodies.ts): kept OUT of `PhysicsWorld.bodies` / `handleToId` (no SAB
  // slot, no pose broadcast, never a contact-drain party: a door never deals
  // ram damage, it pushes and blocks), and tied to their HOST body's lifecycle
  // (`despawnShip(host)` removes them). `under` / `over` parts get no body.
  //
  // The pose is a pure function of (rig, clip record, tick) (`evaluateRig`),
  // so the server worker and the client predWorld place the same bodies from
  // the same inputs through this one method set (#15).
  //
  // Parity note (V8 vs JavaScriptCore): `evaluateRig` and the host transform
  // below use Math.sin / Math.cos, which ECMAScript does not require to be
  // correctly rounded; V8 (server, Chrome) and JavaScriptCore (iOS Safari) may
  // differ in the last bit for some arguments. Slides on an unrotated host are
  // exact either way (cos 0 = 1, sin 0 = 0 everywhere); a hinge or a rotated
  // host can differ by ~1 ulp (about 1e-13 u at 1e3 u). It does not matter:
  // the server is authoritative for every pose the client predicts against
  // (the local ship is corrected from snapshots), the error is many orders
  // below the reconciler's correction threshold, and it never accumulates:
  // every step re-poses each part from the absolute tick, never from its
  // previous pose.

  /** Attach `rig`'s solid parts to the body `hostId` (a structure). One
   *  kinematic body + convex collider per `plane` part with an outline, in
   *  `RIG_PART_COLLISION_GROUPS`; the host's own colliders stop colliding with
   *  rig parts (`withoutRigParts`). Placed at the rest pose at the host's
   *  current pose. No-op for an unknown host, an already-rigged host, or a rig
   *  with no solid part (e.g. the dock crane: all under/over). Spawn time
   *  only (allocates). */
  attachRig(hostId: string, hb: RAPIER.RigidBody, rig: Rig): void {
    if (this.rigs.has(hostId)) return;
    const n = rig.partCount;
    const parts: (RAPIER.RigidBody | null)[] = new Array<RAPIER.RigidBody | null>(n).fill(null);
    let any = false;
    for (let i = 0; i < n; i++) {
      const def = rig.parts[i]!;
      if (def.layer !== 'plane' || !def.outline || def.outline.length < 6) continue;
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(def.outline));
      if (!desc) continue;
      desc.setRestitution(0.4).setFriction(0).setCollisionGroups(RIG_PART_COLLISION_GROUPS);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      this.world.createCollider(desc, body);
      parts[i] = body;
      any = true;
    }
    if (!any) return;
    for (let c = 0; c < hb.numColliders(); c++) {
      const col = hb.collider(c);
      col.setCollisionGroups(withoutRigParts(col.collisionGroups()));
    }
    const t = hb.translation();
    const rec: RigBodies = {
      rig, pose: createRigPose(rig), parts,
      playing: { clipId: '', startTick: 0, target: undefined, from: undefined, rate: undefined },
      targetScratch: { x: 0, y: 0 }, hasClip: false,
      hostX: t.x, hostY: t.y, hostAngle: hb.rotation(),
      dirty: true, idle: false,
    };
    this.rigs.set(hostId, rec);
    this.rigList.push(rec);
    // Teleport to the rest pose now (a fresh kinematic body would otherwise
    // sweep from the origin on its first step).
    this.poseRig(rec, 0, true);
  }

  /** Start (or, with `clipId` null, clear) the clip playing on `hostId`'s rig:
   *  the `PlayingClip` record `{clipId, startTick, target?, from?, rate?}`
   *  (game ticks; target in the host frame; `from` / `rate` scrub the clip,
   *  `clipTime`; both absent = a plain clip). Copied: no reference is kept.
   *  No-op for a host without a rig, and for the record already playing (the
   *  client re-applies its room-state record every snapshot). */
  setRigClip(
    hostId: string, clipId: string | null, startTick = 0, targetX?: number, targetY?: number,
    from?: number, rate?: number,
  ): void {
    const r = this.rigs.get(hostId);
    if (!r) return;
    if (clipId === null ? !r.hasClip : r.hasClip && r.playing.clipId === clipId && r.playing.startTick === startTick
      && r.playing.from === from && r.playing.rate === rate
      && (targetX !== undefined && targetY !== undefined
        ? r.playing.target !== undefined && r.playing.target.x === targetX && r.playing.target.y === targetY
        : r.playing.target === undefined)) return;
    r.hasClip = clipId !== null;
    r.playing.clipId = clipId ?? '';
    r.playing.startTick = startTick;
    r.playing.from = clipId !== null ? from : undefined;
    r.playing.rate = clipId !== null ? rate : undefined;
    if (targetX !== undefined && targetY !== undefined) {
      r.targetScratch.x = targetX;
      r.targetScratch.y = targetY;
      r.playing.target = r.targetScratch;
    } else {
      r.playing.target = undefined;
    }
    r.dirty = true;
    r.idle = false;
  }

  /**
   * Set every rig part's NEXT kinematic pose to its pose at `nowTick` (the
   * tick the coming `tick()` step produces: the server worker passes its sim
   * tick + 1, the client predWorld the predicted tick + 1). Rapier then moves
   * each part along that path in the step, so it pushes what it meets.
   * Cheap skip: a rig whose clip is cleared or finished, and whose host has
   * not moved, is posed once and then skipped. Allocation-free (#14).
   */
  stepRigs(nowTick: number): void {
    const list = this.rigList;
    for (let k = 0; k < list.length; k++) {
      const r = list[k]!;
      if (r.idle && !r.dirty) continue;
      this.poseRig(r, nowTick, false);
    }
  }

  /** World pose of one rig part's body (tests, debug; allocates), or null. */
  rigPartPose(hostId: string, partId: string): { x: number; y: number; angle: number } | null {
    const r = this.rigs.get(hostId);
    if (!r) return null;
    const i = r.rig.partIds.indexOf(partId);
    const b = i >= 0 ? r.parts[i] : null;
    if (!b) return null;
    const t = b.translation();
    return { x: t.x, y: t.y, angle: b.rotation() };
  }

  /** Evaluate `r` at `nowTick` and pose its bodies: `teleport` sets the pose
   *  outright (attach), otherwise it is the next kinematic target. */
  private poseRig(r: RigBodies, nowTick: number, teleport: boolean): void {
    const playing = r.hasClip ? r.playing : null;
    evaluateRig(r.rig, playing, nowTick, r.pose, twoBoneIkSolve);
    const pose = r.pose;
    const c = Math.cos(r.hostAngle), s = Math.sin(r.hostAngle);
    const tr = this._rigTranslationScratch;
    const parts = r.parts;
    for (let i = 0; i < parts.length; i++) {
      const b = parts[i];
      if (!b) continue;
      const px = pose.x[i]!, py = pose.y[i]!;
      tr.x = r.hostX + px * c - py * s;
      tr.y = r.hostY + px * s + py * c;
      const a = r.hostAngle + pose.angle[i]!;
      if (teleport) {
        b.setTranslation(tr, false);
        b.setRotation(a, false);
      } else {
        b.setNextKinematicTranslation(tr);
        b.setNextKinematicRotation(a);
      }
    }
    r.dirty = false;
    // Idle once nothing will move until a new clip or a host move: no clip,
    // or the clip has reached its last key (it holds).
    r.idle = playing === null || clipFinished(r.rig, playing, nowTick);
  }

  /** Host moved (`setShipState` on a rigged body): re-pose its parts on the
   *  next `stepRigs`. Only a real change marks it, so a structure reposed
   *  every snapshot to the same pose stays idle. */
  noteRigHostPose(id: string, x: number, y: number, angle: number): void {
    const r = this.rigs.get(id);
    if (!r) return;
    if (r.hostX === x && r.hostY === y && r.hostAngle === angle) return;
    r.hostX = x; r.hostY = y; r.hostAngle = angle;
    r.dirty = true;
  }

  /** Remove `hostId`'s rig bodies (its host despawned). */
  detachRig(hostId: string): void {
    const r = this.rigs.get(hostId);
    if (!r) return;
    for (const b of r.parts) if (b) this.world.removeRigidBody(b);
    this.rigs.delete(hostId);
    const k = this.rigList.indexOf(r);
    if (k >= 0) this.rigList.splice(k, 1);
  }
}
