/**
 * The AI tick's proximity indexes, filled in ONE swarm-registry walk per tick
 * (`runAiTick` calls `visit`): `neighbours` holds combat drones (pilot hulls
 * are added by the runner) for separation and hull avoidance; `wrecks` holds
 * wreck pieces and drifting (rammed) field rocks, the debris brains steer
 * round (`view.debris`). Allocation-free (#14): the visitor is bound once.
 */
import { AiNeighbourGrid } from './AiNeighbourGrid.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import { allegianceOfKind, getShipKind } from '../../shared-types/shipKinds.js';
import { SWARM_KIND_DRONE, SWARM_KIND_WRECK } from '../../shared-types/swarmWireFormat.js';
import { slotBase, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_X_OFF, SLOT_Y_OFF } from '../../shared-types/sabLayout.js';

export class AiNeighbourFill {
  readonly neighbourGrid = new AiNeighbourGrid();
  readonly wreckGrid = new AiNeighbourGrid();
  /** Tests (`_internals.setAiNeighbours`): off ⇒ brains get no `view.neighbours` (A/B control). */
  neighboursOn = true;
  /** Tests (`_internals.setAiWreckAvoid`): off ⇒ no `view.debris`, and the debris grid is not refilled. */
  wreckAvoidOn = true;

  constructor(private readonly registry: SwarmEntityRegistry, private readonly sab: () => Float32Array) {}

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
}
