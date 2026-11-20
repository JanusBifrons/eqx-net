/**
 * Builds the room's GateController (door-power slice 8): wires the ACTIVE
 * player ships, the relation seam, the game tick, grid supply / active draw
 * and the worker post, so SectorRoom only calls this.
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { GateRelation } from '../../shared-types/gateAccess.js';
import { GateController, type GateShipBuffer } from './GateController.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import type { RigClipCmd } from './structureRigClip.js';

export interface GateControllerDeps {
  registry: StructureRegistry;
  /** Seated pilots (player id keys). */
  pilots: ReadonlyMap<string, unknown>;
  activeShip(playerId: string): { readonly alive: boolean; readonly isActive: boolean; readonly kind: string } | undefined;
  pose(playerId: string): { readonly x: number; readonly y: number } | undefined;
  relationOf(playerId: string, owner: string): GateRelation;
  serverTick(): number;
  supplyFrac(id: string): number;
  setActive(rec: StructureRecord, active: boolean): void;
  post(cmd: RigClipCmd): void;
  /** The gate's swarm-record hit boxes (door leaves re-posed each update). */
  hitBoxes?(id: string): Float32Array | undefined;
}

export function buildGateController(d: GateControllerDeps): GateController {
  return new GateController({
    registry: d.registry,
    // Liveness (#17): only ACTIVE player hulls open gates.
    collectShips: (out: GateShipBuffer) => {
      for (const playerId of d.pilots.keys()) {
        const ship = d.activeShip(playerId);
        if (!ship || !ship.alive || !ship.isActive) continue;
        const pose = d.pose(playerId);
        if (!pose) continue;
        const i = out.count++;
        out.playerIds[i] = playerId;
        out.xs[i] = pose.x;
        out.ys[i] = pose.y;
        out.radii[i] = getShipKind(ship.kind).radius;
      }
    },
    relationOf: d.relationOf,
    serverTick: d.serverTick,
    supplyFrac: d.supplyFrac,
    setActive: d.setActive,
    post: d.post,
    hitBoxes: d.hitBoxes,
  });
}
