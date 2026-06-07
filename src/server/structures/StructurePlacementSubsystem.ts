/**
 * Structure placement (speed-dial-resource-structures plan, Phase 2).
 *
 * Turns a validated `place_structure` request into a swarm entity + a
 * `StructureRegistry` record. Decision logic over injected hooks (no Colyseus,
 * no SAB) so it unit-tests like `TransitOrchestrator` — the `SectorRoom`
 * supplies the concretions (spawn, health seed, id, bounds clamp).
 *
 * Placement model (eqx-peri parity):
 *   - Every structure lands as a **blueprint / scaffolding**: 10 % HP
 *     (`SCAFFOLDING_HP_FRACTION`), `isConstructed = false`, non-operational.
 *     The grid pulse builds it up over time (Phase 3).
 *   - The **Capital** is the exception: `constructionCost === 0` ⇒ pre-built
 *     (full HP, `isConstructed = true`) so the first builds have something to
 *     draw from.
 *   - Placement does NOT pre-charge minerals — the cost is drained DURING
 *     construction by the flow economy (Phase 3), so a blueprint can be placed
 *     with an empty bank and simply waits.
 */
import {
  getStructureKind,
  isStructureKindId,
  structureKindToIndex,
  type StructureKindId,
} from '../../shared-types/structureKinds.js';
import {
  SCAFFOLDING_HP_FRACTION,
  CAPITAL_STARTING_MINERALS,
} from '../../core/structures/structureGridConstants.js';
import type { GridObstacle } from '../../core/structures/Grid.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { autoConnectStructure } from './structureGridView.js';

export interface StructurePlacementHooks {
  /** Spawn the kind=2 swarm entity (returns false if the slot pool is full). */
  spawnStructure(s: { id: string; x: number; y: number; radius: number; shipKind: string }): boolean;
  /** Seed the hull (and zero the shield) so the structure is damageable. */
  seedHealth(id: string, hp: number): void;
  /** Despawn a placed structure's swarm entity (broadcast the destroy). */
  despawn(id: string): void;
  /** Clamp a requested world position to playable sector bounds. */
  clamp(x: number, y: number): { x: number; y: number };
  /** Allocate a fresh, unique structure id. */
  nextId(): string;
  /** Shared registry. */
  registry: StructureRegistry;
  /** Item D — live non-structure obstacles (asteroids) that block a connection's
   *  line of sight, so a structure never auto-wires straight through a rock.
   *  Optional: when omitted, auto-connection falls back to the structures-only
   *  LOS check (byte-identical to pre-Item-D). */
  getObstacles?: () => readonly GridObstacle[];
}

export class StructurePlacementSubsystem {
  constructor(private readonly hooks: StructurePlacementHooks) {}

  /**
   * Place a structure for `owner`. Returns the new structure id, or `null` if
   * the request was rejected (unknown kind, overlap, or slot pool exhausted).
   */
  place(owner: string, kindId: string, x: number, y: number): string | null {
    if (!isStructureKindId(kindId)) return null;
    const kind = getStructureKind(kindId);
    const pos = this.hooks.clamp(x, y);

    // No-overlap: reject if the new footprint would intersect an existing
    // structure's footprint (centre distance < sum of radii).
    for (const s of this.hooks.registry.all()) {
      const dx = s.x - pos.x;
      const dy = s.y - pos.y;
      const minDist = s.radius + kind.radius;
      if (dx * dx + dy * dy < minDist * minDist) return null;
    }

    const preBuilt = kind.constructionCost <= 0;
    const hp = preBuilt
      ? kind.maxHealth
      : Math.max(1, Math.floor(kind.maxHealth * SCAFFOLDING_HP_FRACTION));

    const id = this.hooks.nextId();
    const ok = this.hooks.spawnStructure({
      id,
      x: pos.x,
      y: pos.y,
      radius: kind.radius,
      shipKind: kindId,
    });
    if (!ok) return null;

    this.hooks.seedHealth(id, hp);

    // The Capital is born with a starting mineral bank (capped by its storage)
    // so a base can bootstrap a few structures before mining (Phase 4) exists.
    const minerals =
      kindId === 'capital' ? Math.min(CAPITAL_STARTING_MINERALS, kind.storageCapacity) : 0;

    const rec: StructureRecord = {
      id,
      owner,
      kind: kindId as StructureKindId,
      subtypeIndex: structureKindToIndex(kindId),
      x: pos.x,
      y: pos.y,
      radius: kind.radius,
      isConstructed: preBuilt,
      constructionProgress: preBuilt ? kind.constructionCost : 0,
      constructionCost: kind.constructionCost,
      isDeconstructing: false,
      minerals,
    };
    this.hooks.registry.add(rec);
    // Auto-wire into the owner's grid: nearest in-range hub with a free slot
    // whose connecting segment isn't blocked by another structure OR an asteroid.
    autoConnectStructure(this.hooks.registry, id, this.hooks.getObstacles?.());
    return id;
  }

  /**
   * Remove a structure the requester owns. Returns true if removed. Rejects
   * unknown ids and ids owned by another player (anti-grief).
   */
  remove(owner: string, id: string): boolean {
    const rec = this.hooks.registry.get(id);
    if (!rec || rec.owner !== owner) return false;
    this.hooks.despawn(id);
    this.hooks.registry.remove(id);
    return true;
  }
}
