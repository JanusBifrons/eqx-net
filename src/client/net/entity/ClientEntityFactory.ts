/**
 * Client Entity factory — the spawn-time routing seam (Generic Entity Pipeline
 * B4). Maps a pose-core `kind` byte to its client leaf; an UNRECOGNISED kind
 * returns `null` and the caller SKIPS it (HC#2 — never the drone path: a future
 * pose-core type not yet wired must not be mis-registered as a drone, the bug
 * the old `else`-is-drone branch had).
 *
 * This is the approved type-guard / switch seam — LOW frequency (once per body,
 * on first spawn). The per-entity sync and the per-frame kinematic follower
 * route by descriptor DATA, never by re-resolving a leaf in the hot loop.
 */
import {
  SWARM_KIND_ASTEROID,
  SWARM_KIND_DRONE,
  SWARM_KIND_STRUCTURE,
  SWARM_KIND_SCRAP,
} from '@shared-types/swarmWireFormat';
import { AsteroidClientLeaf } from './leaves/asteroidClientLeaf.js';
import { DroneClientLeaf } from './leaves/droneClientLeaf.js';
import { StructureClientLeaf } from './leaves/structureClientLeaf.js';
import { ScrapClientLeaf } from './leaves/scrapClientLeaf.js';
import type { IClientEntityLeaf } from './IClientEntityLeaf.js';

export class ClientEntityFactory {
  private readonly asteroid = new AsteroidClientLeaf();
  private readonly drone = new DroneClientLeaf();
  private readonly structure = new StructureClientLeaf();
  private readonly scrap = new ScrapClientLeaf();

  constructor() {
    // Cross-check the core registry's pose-core bytes (each leaf reads its own
    // from `EntityKindRegistry`) against the wire constants — a registry/wire
    // drift would otherwise silently mis-route construction.
    assertPoseCoreKind(this.asteroid, SWARM_KIND_ASTEROID);
    assertPoseCoreKind(this.drone, SWARM_KIND_DRONE);
    assertPoseCoreKind(this.structure, SWARM_KIND_STRUCTURE);
    assertPoseCoreKind(this.scrap, SWARM_KIND_SCRAP);
  }

  /** The client leaf for a pose-core `kind` byte, or `null` for an unrecognised
   *  kind. Callers MUST treat `null` as "do not construct" (skip) — NEVER fall
   *  through to the drone path (HC#2). */
  leafFor(kind: number): IClientEntityLeaf | null {
    switch (kind) {
      case SWARM_KIND_ASTEROID:
        return this.asteroid;
      case SWARM_KIND_DRONE:
        return this.drone;
      case SWARM_KIND_STRUCTURE:
        return this.structure;
      case SWARM_KIND_SCRAP:
        return this.scrap;
      default:
        return null;
    }
  }
}

function assertPoseCoreKind(leaf: IClientEntityLeaf, expected: number): void {
  if (leaf.poseCoreKind !== expected) {
    throw new Error(
      `ClientEntityFactory: leaf pose-core kind ${leaf.poseCoreKind} ≠ wire constant ${expected} (registry/wire drift)`,
    );
  }
}
