/**
 * Is the placement ghost where the server would accept it? The CLIENT side of
 * the server's `StructurePlacementSubsystem.place` overlap check: the mirror's
 * structures become the same `PlacementFootprint`s the server's registry
 * records are (kind, footprint box, quarter-turn rotation in degrees) and the
 * ghost runs the SAME core `placementRejection` (#15), so the ghost turns red
 * before the click exactly where the server would refuse it.
 *
 * Obstacles: the asteroids and loaded field rocks the build preview already
 * gathered for its links (`asteroidObstaclesFromSwarm`, over a box that holds
 * the ghost's footprint). Wreck pieces are not on the client's list yet, so a
 * ghost over a wreck stays green and the server's notice still refuses it.
 *
 * Allocation-free after warm-up (#14): the footprints are pooled.
 */
import type { SwarmRenderState, StructureRenderState } from '../../core/contracts/IRenderer.js';
import type { GridObstacle } from '../../core/structures/Grid.js';
import { placementRejection, type PlacementDeck, type PlacementFootprint, type PlacementRejection } from '../../core/structures/placementRules.js';
import {
  getStructureKind,
  isStructureKindId,
  normaliseStructureRotation,
  structureHalfExtents,
} from '../../shared-types/structureKinds.js';

const RAD_TO_DEG = 180 / Math.PI;

/** The placement ghost's pose: kind, game-space point, angle in radians. */
export interface GhostPose {
  kind: string;
  x: number;
  y: number;
  angle: number;
  /** Build mirror (4B): placed left-right flipped. */
  mirror?: boolean;
}

export class PlacementGhostVerdict {
  /** Pooled footprints, one per placed structure (the server's registry view). */
  private readonly footprints: PlacementFootprint[] = [];

  /**
   * Why the ghost can't go at `ghost`, or `null` when it can. `structures` and
   * `swarm` are the render mirror's (a structure's pose rides the swarm wire);
   * `obstacles` the rocks around the ghost; `deck` the local player's deck on
   * a deck room (base platforms, the server's `off-deck` rule), else null.
   */
  check(
    ghost: GhostPose,
    structures: ReadonlyMap<number, StructureRenderState> | undefined,
    swarm: ReadonlyMap<number, SwarmRenderState>,
    obstacles: readonly GridObstacle[] | null,
    deck: PlacementDeck | null = null,
  ): PlacementRejection | null {
    if (!isStructureKindId(ghost.kind)) return null;
    const fps = this.footprints;
    let n = 0;
    if (structures) {
      for (const id of structures.keys()) {
        const e = swarm.get(id);
        if (e === undefined || e.shipKind === undefined || !isStructureKindId(e.shipKind)) continue;
        const rot = normaliseStructureRotation(e.angle * RAD_TO_DEG);
        // TODO(bp-16): oriented box — axis-aligned at an odd-30° turn.
        const ext = structureHalfExtents(e.shipKind, rot);
        let fp = fps[n];
        if (fp === undefined) {
          fp = { x: 0, y: 0, radius: 0 };
          fps[n] = fp;
        }
        fp.x = e.x;
        fp.y = e.y;
        fp.radius = getStructureKind(e.shipKind).radius;
        fp.halfW = ext.hw;
        fp.halfH = ext.hh;
        fp.kind = e.shipKind;
        fp.rot = rot;
        fp.mirror = structures.get(id)!.mirror === true;
        n++;
      }
    }
    fps.length = n;
    return placementRejection(ghost.kind, ghost.x, ghost.y, fps, obstacles, normaliseStructureRotation(ghost.angle * RAD_TO_DEG), ghost.mirror === true, deck);
  }
}
