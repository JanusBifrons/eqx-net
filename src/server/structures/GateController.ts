/**
 * Gate open/close orchestration (plan soft-leaping-truffle v2, phase V gates).
 *
 * Runs on the 10 Hz structure tick, BEFORE `ShieldWallManager.update` (which
 * reads `maskFor` to drop an open span's collider). For each constructed Shield
 * Gate / Airlock it builds the occupancy from the ACTIVE player ships around it
 * and steps the pure state machines in `core/structures/gateLogic.ts`. The open
 * state reaches clients through room state (`StructureState.gateOpen`); the
 * client never predicts it.
 *
 * Liveness (#17): only ACTIVE player ships open gates (the `collectShips` hook
 * fills ACTIVE hulls only). Lingering hulls are parked and don't fly; NPC ships
 * get gate access with the NPC-base phase (B2).
 *
 * Solid doors (docs/plans/door-power.md, slice 8): the door's motion segment
 * is its ONE clock. Each changed segment is posted to the gate's rig as a
 * scrubbed clip (from = clip time at p0, rate = signed level-scaled) through
 * `startStructureRigClip`; position is never integrated here. Power level L
 * comes from the grid's supply fraction; a moving door draws full power
 * (`setActive`, the general grid rule), a still one only its trickle.
 *
 * Steady state is allocation-free: ships are collected into reused arrays and
 * per-gate state objects are created once per gate (a segment edge allocates
 * its clip record, as any rig clip start does).
 */
import { DOOR_POWER_LEVELS, gateTypeOf, worldToLocal } from '../../core/structures/gateGeometry.js';
import { doorClipTime, doorLevelFromSupply, doorPosAt, type DoorTrack } from '../../core/structures/doorMotion.js';
import {
  addShipToOccupancy,
  clearOccupancy,
  gateDoorsMoving,
  gateOpenMask,
  newAirlockState,
  newGateState,
  newOccupancy,
  savedDoorOf,
  stepAirlock,
  stepGate,
  type AirlockState,
  type GateState,
  type SavedDoor,
} from '../../core/structures/gateLogic.js';
import { gateAccessFromIndex, gateAdmits, type GateRelation } from '../../shared-types/gateAccess.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import { startStructureRigClip, type RigClipCmd } from './structureRigClip.js';

/** Reused ship buffer the room fills each tick. */
export interface GateShipBuffer {
  count: number;
  playerIds: string[];
  xs: number[];
  ys: number[];
  radii: number[];
}

export interface GateControllerHooks {
  registry: StructureRegistry;
  /** Fill `out` with every ACTIVE player ship (reset `count` first). */
  collectShips(out: GateShipBuffer): void;
  /** A ship's relation to a gate owner (the B1 relation seam slots in here). */
  relationOf(playerId: string, owner: string): GateRelation;
  /** The room's game tick (the rig clock). */
  serverTick(): number;
  /** The structure's grid supply fraction 0..1 (`PowerSummary.supplyFrac`). */
  supplyFrac(id: string): number;
  /** Full draw while a door moves, trickle while still (grid `setActive`). */
  setActive(rec: StructureRecord, active: boolean): void;
  /** Post a worker command (`RIG_CLIP`). */
  post(cmd: RigClipCmd): void;
}

export class GateController {
  private readonly gates = new Map<string, GateState>();
  private readonly airlocks = new Map<string, AirlockState>();
  private readonly ships: GateShipBuffer = { count: 0, playerIds: [], xs: [], ys: [], radii: [] };
  private readonly occ = newOccupancy();
  private readonly local = { x: 0, y: 0 };
  /** Reused scrub argument for `startStructureRigClip`. */
  private readonly scrub = { from: 0, rate: 0 };
  /** The tick of the last update, for `savedDoor` (persistence). */
  private lastTick = 0;

  constructor(private readonly hooks: GateControllerHooks) {}

  /** Step every gate. Returns true if any gate's open state changed. */
  update(nowMs: number): boolean {
    const reg = this.hooks.registry;
    let changed = false;
    let collected = false;
    const tick = this.hooks.serverTick();
    this.lastTick = tick;
    for (const rec of reg.all()) {
      const type = gateTypeOf(rec.kind);
      if (type === null) continue;
      if (!rec.isConstructed) {
        // A blueprint (or one being upgraded) has no working gate: closed.
        if (this.gates.delete(rec.id) || this.airlocks.delete(rec.id)) {
          changed = true;
          this.hooks.setActive(rec, false);
          startStructureRigClip(rec, null, tick, this.hooks.post);
        }
        continue;
      }
      if (!collected) {
        this.ships.count = 0;
        this.hooks.collectShips(this.ships);
        collected = true;
      }
      const angle = ((rec.rot ?? 0) * Math.PI) / 180;
      const access = gateAccessFromIndex(rec.gateAccess);
      const o = this.occ;
      clearOccupancy(o);
      const s = this.ships;
      for (let i = 0; i < s.count; i++) {
        worldToLocal(rec.x, rec.y, angle, s.xs[i]!, s.ys[i]!, this.local);
        const admitted = gateAdmits(access, this.hooks.relationOf(s.playerIds[i]!, rec.owner));
        addShipToOccupancy(type, this.local.x, this.local.y, s.radii[i]!, admitted, o);
      }
      const level = doorLevelFromSupply(this.hooks.supplyFrac(rec.id));
      if (type === 'gate') {
        let g = this.gates.get(rec.id);
        let fresh = false;
        if (!g) { g = newGateState(nowMs, takeDoorRestore(rec)); this.gates.set(rec.id, g); fresh = true; }
        // A new state (a restored half-open door too) posts its pose once.
        if (stepGate(g, o, nowMs, tick, level) || fresh) {
          changed = true;
          this.postDoor(rec, 'door', g.door);
        }
        this.hooks.setActive(rec, gateDoorsMoving(g, undefined, tick));
      } else {
        let a = this.airlocks.get(rec.id);
        let fresh = false;
        if (!a) { a = newAirlockState(takeDoorRestore(rec)); this.airlocks.set(rec.id, a); fresh = true; }
        if (stepAirlock(a, o, nowMs, tick, level) || fresh) {
          changed = true;
          // One rig, one clip: the end that is off its seat or heading open
          // (the interlock keeps the other end at 0, its rest pose).
          const b = a.doorB;
          if (doorPosAt(b.seg, tick) > 0 || b.seg.dir > 0) this.postDoor(rec, 'door-b', b);
          else this.postDoor(rec, 'door-a', a.doorA);
        }
        this.hooks.setActive(rec, gateDoorsMoving(undefined, a, tick));
      }
    }
    // Forget gates that left the world.
    for (const id of this.gates.keys()) if (!reg.get(id)) { this.gates.delete(id); changed = true; }
    for (const id of this.airlocks.keys()) if (!reg.get(id)) { this.airlocks.delete(id); changed = true; }
    return changed;
  }

  /** Scrub the rig along a door's segment: clip time doorClipTime(p0) at t0,
   *  moving dir * L / 15 clip ticks per game tick (L = 0 holds it still). */
  private postDoor(rec: StructureRecord, clipId: string, d: DoorTrack): void {
    const seg = d.seg;
    this.scrub.from = doorClipTime(seg.p0);
    this.scrub.rate = (seg.dir * seg.level) / DOOR_POWER_LEVELS;
    startStructureRigClip(rec, clipId, seg.t0, this.hooks.post, undefined, undefined, this.scrub);
  }

  /** Open bits for a gate (GATE_OPEN_A / GATE_OPEN_B); 0 for anything else. */
  maskFor(id: string): number {
    return gateOpenMask(this.gates.get(id), this.airlocks.get(id));
  }

  /** Door-power slice 12: the door position to save with this structure at
   *  the last tick (undefined = every door shut, or not a gate). */
  savedDoor(id: string): SavedDoor | undefined {
    return savedDoorOf(this.gates.get(id), this.airlocks.get(id), this.lastTick);
  }
}

/** A restored save's door position, consumed once when the gate's state is
 *  first built (the restore hook; missing = shut). */
function takeDoorRestore(rec: { doorRestore?: SavedDoor }): SavedDoor | undefined {
  const saved = rec.doorRestore;
  if (saved !== undefined) delete rec.doorRestore;
  return saved;
}
