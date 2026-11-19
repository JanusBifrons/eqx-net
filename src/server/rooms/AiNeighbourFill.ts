/**
 * The AI tick's proximity indexes, filled in ONE swarm-registry walk per tick
 * (`runAiTick` calls `visit`): `neighbours` holds combat drones (pilot hulls
 * are added by the runner) for separation and hull avoidance; `wrecks` holds
 * wreck pieces and drifting (rammed) field rocks, the debris brains steer
 * round (`view.debris`). Allocation-free (#14): the visitor is bound once.
 * Also fills the AI view's swarm-combatant targets (`fillSwarmTargets`, moved
 * verbatim out of `SectorRoom`) from the same registry + SAB, once per tick.
 */
import { AiNeighbourGrid } from './AiNeighbourGrid.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { AiSwarmView } from '../../core/contracts/IAiBehaviour.js';
import { allegianceOfKind, getShipKind } from '../../shared-types/shipKinds.js';
import { SWARM_KIND_DRONE, SWARM_KIND_WRECK } from '../../shared-types/swarmWireFormat.js';
import { slotBase, SLOT_ANGLE_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_X_OFF, SLOT_Y_OFF } from '../../shared-types/sabLayout.js';

/** What the swarm-target fill reads from the room; getters read the live field. */
export interface AiSwarmTargetHost {
  /** AI-flown owned hulls in the sector (`FleetCommandSubsystem.size`). */
  fleetSize(): number;
  swarmHealth(): ReadonlyMap<string, number>;
}

export class AiNeighbourFill {
  readonly neighbourGrid = new AiNeighbourGrid();
  readonly wreckGrid = new AiNeighbourGrid();
  /** Tests (`_internals.setAiNeighbours`): off ⇒ brains get no `view.neighbours` (A/B control). */
  neighboursOn = true;
  /** Tests (`_internals.setAiWreckAvoid`): off ⇒ no `view.debris`, and the debris grid is not refilled. */
  wreckAvoidOn = true;

  constructor(
    private readonly registry: SwarmEntityRegistry,
    private readonly sab: () => Float32Array,
    private readonly host: AiSwarmTargetHost,
  ) {}

  /** This tick's neighbour grid for the runner, or undefined when switched off. */
  neighbours(): AiNeighbourGrid | undefined { return this.neighboursOn ? this.neighbourGrid : undefined; }
  wrecks(): AiNeighbourGrid | undefined { return this.wreckAvoidOn ? this.wreckGrid : undefined; }
  /** Grid queries this tick, both grids (scene work counter). */
  get queriesTotal(): number { return this.neighbourGrid.queriesTotal + this.wreckGrid.queriesTotal; }

  /** Add every kind-1 swarm combatant and every debris piece with its SAB pose. */
  readonly visit = (_grid: AiNeighbourGrid): void => { this.registry.forEachRecord(this.add); };

  private readonly add = (rec: SwarmEntityRecord): void => {
    const f = this.sab();
    if (rec.kind === SWARM_KIND_WRECK || rec.fieldAwake === true) {
      if (!this.wreckAvoidOn) return;
      const w = slotBase(rec.slot);
      this.wreckGrid.addDebris(rec.id, f[w + SLOT_X_OFF]!, f[w + SLOT_Y_OFF]!, f[w + SLOT_VX_OFF]!, f[w + SLOT_VY_OFF]!, rec.radius);
      return;
    }
    if (rec.kind !== SWARM_KIND_DRONE) return;
    const b = slotBase(rec.slot);
    this.neighbourGrid.addDrone(
      rec.id, f[b + SLOT_X_OFF]!, f[b + SLOT_Y_OFF]!, f[b + SLOT_VX_OFF]!, f[b + SLOT_VY_OFF]!,
      rec.radius, allegianceOfKind(rec.shipKind), getShipKind(rec.shipKind ?? null).aiRole === 'capital',
    );
  };

  /** Allegiances P0 — pooled per-tick swarm-combatant views (never reallocated
   *  once grown, #14). Targeting only. */
  private readonly _swarmViewPool: Array<{
    id: string; x: number; y: number; vx: number; vy: number;
    allegiance: string; health?: number; maxHealth?: number; radius: number;
    kindId: string | null; angle: number; shieldUp: boolean;
  }> = [];

  /**
   * Allegiances P0 — rebuild this tick's swarm-combatant set (kind-1 entities),
   * ONCE per tick (#14). Only populated when ≥ 2 allegiances are present in the
   * sector: a drones-only sector leaves `out` empty, so the AI view's `swarms`
   * is absent and the brain takes its pre-P0 fast path (byte-identical, zero
   * per-drone cost). Targeting only: the beam hits whatever it meets.
   */
  readonly fillSwarmTargets = (out: AiSwarmView[]): void => {
    out.length = 0;
    let first: string | null = null;
    let mixed = false;
    for (const rec of this.registry.all()) {
      if (rec.kind !== SWARM_KIND_DRONE) continue;
      const a = allegianceOfKind(rec.shipKind);
      if (first === null) first = a;
      else if (a !== first) { mixed = true; break; }
    }
    // AI-flown owned hulls (players side) fight swarm ships too: fill whenever
    // one exists, even in a single-allegiance sector (RTS Part B).
    if (!mixed && this.host.fleetSize() === 0) return;
    const pool = this._swarmViewPool;
    const f = this.sab();
    let n = 0;
    for (const rec of this.registry.all()) {
      if (rec.kind !== SWARM_KIND_DRONE) continue;
      const b = slotBase(rec.slot);
      let v = pool[n];
      if (!v) {
        v = { id: '', x: 0, y: 0, vx: 0, vy: 0, allegiance: 'drones', radius: 0, kindId: null, angle: 0, shieldUp: false };
        pool[n] = v;
      }
      v.id = rec.id;
      v.x = f[b + SLOT_X_OFF]!;
      v.y = f[b + SLOT_Y_OFF]!;
      v.vx = f[b + SLOT_VX_OFF]!;
      v.vy = f[b + SLOT_VY_OFF]!;
      v.angle = f[b + SLOT_ANGLE_OFF]!;
      v.allegiance = allegianceOfKind(rec.shipKind);
      v.health = this.host.swarmHealth().get(rec.id);
      v.maxHealth = getShipKind(rec.shipKind).maxHealth;
      v.radius = rec.radius;
      v.kindId = rec.shipKind ?? null;
      v.shieldUp = !rec.shieldDown;
      out.push(v);
      n++;
    }
  };
}
