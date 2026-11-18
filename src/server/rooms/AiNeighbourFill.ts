/**
 * The AI tick's proximity index, filled in ONE swarm-registry walk per tick
 * (`runAiTick` calls `visit`): `neighbours` holds combat drones (pilot hulls
 * are added by the runner) for separation and hull avoidance.
 * Allocation-free (#14): the visitor is bound once.
 */
import { AiNeighbourGrid } from './AiNeighbourGrid.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import { allegianceOfKind, getShipKind } from '../../shared-types/shipKinds.js';
import { SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';
import { slotBase, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_X_OFF, SLOT_Y_OFF } from '../../shared-types/sabLayout.js';

export class AiNeighbourFill {
  readonly neighbourGrid = new AiNeighbourGrid();
  /** Tests (`_internals.setAiNeighbours`): off ⇒ brains get no `view.neighbours` (A/B control). */
  neighboursOn = true;

  constructor(private readonly registry: SwarmEntityRegistry, private readonly sab: () => Float32Array) {}

  /** This tick's neighbour grid for the runner, or undefined when switched off. */
  neighbours(): AiNeighbourGrid | undefined { return this.neighboursOn ? this.neighbourGrid : undefined; }
  /** Grid queries this tick (scene work counter). */
  get queriesTotal(): number { return this.neighbourGrid.queriesTotal; }

  /** Add every kind-1 swarm combatant with its SAB pose. */
  readonly visit = (_grid: AiNeighbourGrid): void => { this.registry.forEachRecord(this.add); };

  private readonly add = (rec: SwarmEntityRecord): void => {
    if (rec.kind !== SWARM_KIND_DRONE) return;
    const f = this.sab(), b = slotBase(rec.slot);
    this.neighbourGrid.addDrone(
      rec.id, f[b + SLOT_X_OFF]!, f[b + SLOT_Y_OFF]!, f[b + SLOT_VX_OFF]!, f[b + SLOT_VY_OFF]!,
      rec.radius, allegianceOfKind(rec.shipKind), getShipKind(rec.shipKind ?? null).aiRole === 'capital',
    );
  };
}
