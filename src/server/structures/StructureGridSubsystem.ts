/**
 * The grid pulse (speed-dial-resource-structures plan, Phase 3) — the 1 Hz
 * heartbeat that drives the whole logistics web. Runs OFF the 60 Hz physics tick
 * (LivingWorldDirector pattern); `pulse()` is directly callable so tests drive
 * it deterministically without wall-clock waits.
 *
 * Each pulse, in order:
 *   1. Rebuild grid topology if `registry.topologyDirty`.
 *   2. Construction flow: each blueprint reachable from a Capital with minerals
 *      receives up to `CONSTRUCTION_PULSE_AMOUNT`/pulse, debited from that
 *      Capital. On completion → `isConstructed = true`, HP reset to max,
 *      topology dirtied (the node now relays). Dry source ⇒ construction simply
 *      pauses (emergent, no flag).
 *   3. Repair: damaged BUILT structures receive up to `REPAIR_PULSE_AMOUNT`/pulse
 *      at `REPAIR_COST_PER_HP` per HP.
 *   4. Deconstruction: `isDeconstructing` structures drain at
 *      `DECONSTRUCTION_RATE_KG`/pulse, returning minerals to their Capital;
 *      removed when fully reclaimed.
 *   5. Flash every connection that carried flow (drives the client `grid_pulse`).
 *
 * Power is AGGREGATED (not routed per-connection), so power doesn't flash — only
 * the mineral streams do. The single Phase-3 flow material is `minerals`.
 */
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { Grid } from '../../core/structures/Grid.js';
import type { Connection } from '../../core/structures/Connection.js';
import {
  CONSTRUCTION_PULSE_AMOUNT,
  REPAIR_PULSE_AMOUNT,
  REPAIR_COST_PER_HP,
  DECONSTRUCTION_RATE_KG,
} from '../../core/structures/structureGridConstants.js';
import { buildGridNodes } from './structureGridView.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

export interface StructureGridHooks {
  registry: StructureRegistry;
  /** Read a structure's current hull (from `swarmHealth`). */
  getHealth(id: string): number;
  /** Write a structure's hull (into `swarmHealth`). */
  setHealth(id: string, hp: number): void;
  /** Despawn a structure's swarm entity (used by deconstruction). */
  despawn(id: string): void;
}

export interface GridPulseResult {
  /** Connection endpoint pairs that carried flow this pulse (for `grid_pulse`). */
  flashed: Array<[string, string]>;
  /** The flow material (Phase 3: always 'minerals'). */
  material: 'minerals';
}

export class StructureGridSubsystem {
  private readonly grid = new Grid();

  constructor(private readonly hooks: StructureGridHooks) {}

  /** Read-only grid query for the snapshot slice (powered / netPower). */
  powerSummaryFor(id: string): { netPower: number; powered: boolean } {
    return this.grid.powerSummaryFor(id);
  }

  /** One grid heartbeat. `nowMs` stamps connection flashes. */
  pulse(nowMs: number): GridPulseResult {
    const registry = this.hooks.registry;
    if (registry.topologyDirty) {
      this.grid.rebuild(buildGridNodes(registry), registry.adjacencyMap());
      registry.topologyDirty = false;
    }

    const flashed: Array<[string, string]> = [];
    this.processConstruction(nowMs, flashed);
    this.processRepair(nowMs, flashed);
    this.processDeconstruction(nowMs, flashed);
    return { flashed, material: 'minerals' };
  }

  /** Find a built Capital with minerals that can route to `targetId`. */
  private findStorageRoute(targetId: string): { capital: StructureRecord; route: readonly string[] } | null {
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind !== 'capital' || !rec.isConstructed || rec.minerals <= 0) continue;
      const route = this.grid.route(rec.id, targetId);
      if (route) return { capital: rec, route };
    }
    return null;
  }

  private flashRoute(route: readonly string[], nowMs: number, flashed: Array<[string, string]>): void {
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i]!;
      const b = route[i + 1]!;
      const conn = this.findConnection(a, b);
      if (conn) {
        conn.flash(nowMs, 'minerals');
        flashed.push([a, b]);
      }
    }
  }

  private findConnection(aId: string, bId: string): Connection | null {
    for (const c of this.hooks.registry.connectionsOf(aId)) {
      if (c.getOtherNode(aId) === bId) return c;
    }
    return null;
  }

  private processConstruction(nowMs: number, flashed: Array<[string, string]>): void {
    for (const bp of this.hooks.registry.all()) {
      if (bp.isConstructed || bp.isDeconstructing) continue;
      const source = this.findStorageRoute(bp.id);
      if (!source) continue; // unreachable OR no minerals → pause
      const amount = Math.min(CONSTRUCTION_PULSE_AMOUNT, source.capital.minerals);
      if (amount <= 0) continue;
      source.capital.minerals -= amount;
      bp.constructionProgress += amount;
      this.flashRoute(source.route, nowMs, flashed);
      if (bp.constructionProgress >= bp.constructionCost) {
        bp.constructionProgress = bp.constructionCost;
        bp.isConstructed = true;
        this.hooks.setHealth(bp.id, getStructureKind(bp.kind).maxHealth);
        this.hooks.registry.topologyDirty = true; // it now relays
      }
    }
  }

  private processRepair(nowMs: number, flashed: Array<[string, string]>): void {
    for (const rec of this.hooks.registry.all()) {
      if (!rec.isConstructed || rec.isDeconstructing) continue;
      const max = getStructureKind(rec.kind).maxHealth;
      const hp = this.hooks.getHealth(rec.id);
      if (hp >= max) continue;
      const source = this.findStorageRoute(rec.id);
      if (!source) continue;
      const spend = Math.min(REPAIR_PULSE_AMOUNT, source.capital.minerals);
      if (spend <= 0) continue;
      const hpGain = Math.min(max - hp, spend / REPAIR_COST_PER_HP);
      const actualSpend = hpGain * REPAIR_COST_PER_HP;
      source.capital.minerals -= actualSpend;
      this.hooks.setHealth(rec.id, hp + hpGain);
      this.flashRoute(source.route, nowMs, flashed);
    }
  }

  private processDeconstruction(nowMs: number, flashed: Array<[string, string]>): void {
    // Snapshot the list — we may remove entries mid-iteration.
    const decon: StructureRecord[] = [];
    for (const rec of this.hooks.registry.all()) {
      if (rec.isDeconstructing) decon.push(rec);
    }
    for (const rec of decon) {
      const reclaim = Math.min(DECONSTRUCTION_RATE_KG, rec.constructionProgress);
      rec.constructionProgress -= reclaim;
      // Return reclaimed minerals to a connected Capital (capped by capacity).
      if (reclaim > 0) {
        const source = this.returnRoute(rec.id);
        if (source) {
          const cap = getStructureKind(source.capital.kind).storageCapacity;
          source.capital.minerals = Math.min(cap, source.capital.minerals + reclaim);
          this.flashRoute(source.route, nowMs, flashed);
        }
      }
      if (rec.constructionProgress <= 0) {
        this.hooks.despawn(rec.id);
        this.hooks.registry.remove(rec.id);
      }
    }
  }

  /** A route to ANY built Capital (regardless of its mineral level) for
   *  returning reclaimed minerals. */
  private returnRoute(targetId: string): { capital: StructureRecord; route: readonly string[] } | null {
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind !== 'capital' || !rec.isConstructed) continue;
      const route = this.grid.route(rec.id, targetId);
      if (route) return { capital: rec, route };
    }
    return null;
  }
}
