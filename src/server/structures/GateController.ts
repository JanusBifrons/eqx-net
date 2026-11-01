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
 * Steady state is allocation-free: ships are collected into reused arrays and
 * per-gate state objects are created once per gate.
 */
import { gateTypeOf, worldToLocal } from '../../core/structures/gateGeometry.js';
import {
  addShipToOccupancy,
  clearOccupancy,
  gateOpenMask,
  newAirlockState,
  newOccupancy,
  stepAirlock,
  stepGate,
  type AirlockState,
  type GateState,
} from '../../core/structures/gateLogic.js';
import { gateAccessFromIndex, gateAdmits, type GateRelation } from '../../shared-types/gateAccess.js';
import type { StructureRegistry } from './StructureRegistry.js';

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
}

export class GateController {
  private readonly gates = new Map<string, GateState>();
  private readonly airlocks = new Map<string, AirlockState>();
  private readonly ships: GateShipBuffer = { count: 0, playerIds: [], xs: [], ys: [], radii: [] };
  private readonly occ = newOccupancy();
  private readonly local = { x: 0, y: 0 };

  constructor(private readonly hooks: GateControllerHooks) {}

  /** Step every gate. Returns true if any gate's open state changed. */
  update(nowMs: number): boolean {
    const reg = this.hooks.registry;
    let changed = false;
    let collected = false;
    for (const rec of reg.all()) {
      const type = gateTypeOf(rec.kind);
      if (type === null) continue;
      if (!rec.isConstructed) {
        // A blueprint (or one being upgraded) has no working gate: closed.
        if (this.gates.delete(rec.id) || this.airlocks.delete(rec.id)) changed = true;
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
      if (type === 'gate') {
        let g = this.gates.get(rec.id);
        if (!g) { g = { open: false, lastBusyMs: nowMs }; this.gates.set(rec.id, g); }
        const before = g.open;
        stepGate(g, o, nowMs);
        if (g.open !== before) changed = true;
      } else {
        let a = this.airlocks.get(rec.id);
        if (!a) { a = newAirlockState(); this.airlocks.set(rec.id, a); }
        const before = a.phase;
        stepAirlock(a, o, nowMs);
        if (a.phase !== before) changed = true;
      }
    }
    // Forget gates that left the world.
    for (const id of this.gates.keys()) if (!reg.get(id)) { this.gates.delete(id); changed = true; }
    for (const id of this.airlocks.keys()) if (!reg.get(id)) { this.airlocks.delete(id); changed = true; }
    return changed;
  }

  /** Open bits for a gate (GATE_OPEN_A / GATE_OPEN_B); 0 for anything else. */
  maskFor(id: string): number {
    return gateOpenMask(this.gates.get(id), this.airlocks.get(id));
  }
}
