/**
 * Click-to-inspect stats resolution for `SelectionStatsSubsystem` (Item B5):
 * `resolveSelectionStats` is its `resolveStats` hook and `ownerGateStats` runs
 * inside its `sendTo` hook. Moved verbatim out of `SectorRoom` (god-file split
 * slice 24). The room hands in a narrow host (`() => value` for fields it
 * reassigns), built once in `onCreate` (#14). Runs on the ~5 Hz selection
 * timer, OFF the snapshot/physics hot path.
 */
import type { MapSchema } from '@colyseus/schema';
import type { EntityStatsMessage } from '../../shared-types/messages/selectionMessages.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { effectiveShipShieldMax } from '../../core/leveling/shipStats.js';
import { cargoOpensFor, relationOf, type RelationContext } from '../../shared-types/relations.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { effectiveStructureMaxHealth } from '../../core/leveling/structureLevel.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { StructureRegistry } from '../structures/StructureRegistry.js';
import type { ShipState } from './schema/SectorState.js';
import type { Selection } from './SelectionStatsSubsystem.js';

/** What the stats resolver needs from the room; getters read the live field. */
export interface SelectionStatsResolveHost {
  ships(): Pick<MapSchema<ShipState>, 'get'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  swarmHealth(): Pick<Map<string, number>, 'get'>;
  sessionToPlayer(): Pick<Map<string, string>, 'get'>;
  relationCtx: RelationContext;
}

/**
 * Resolve live stats for a click-to-inspect selection (Item B5). Returns null
 * when the entity is gone (dead / despawned / lingering-only) — the
 * `SelectionStatsSubsystem` auto-clears the selection on null so the ~5 Hz
 * emitter never leaks. Only ship + structure ids reach here (drones
 * read health client-side from the mirror).
 *
 *   - ship      → `id` is a playerId; resolve `state.ships.get(id)`. A
 *                 lingering hull (`isActive === false`) is treated as gone.
 *   - structure → `id` is the numeric swarm `entityId`; resolve the swarm
 *                 record → its registry id → `structureRegistry` + `swarmHealth`.
 */
export function resolveSelectionStats(host: SelectionStatsResolveHost, sel: Selection): EntityStatsMessage | null {
  if (sel.kind === 'ship') {
    const ship = host.ships().get(sel.id);
    if (!ship || !ship.isActive || !ship.alive) return null;
    const kind = getShipKind(ship.kind);
    return {
      type: 'entity_stats',
      id: sel.id,
      kind: 'ship',
      name: ship.displayName,
      hp: Math.max(0, Math.round(ship.health)),
      hpMax: Math.round(ship.maxHealth),
      shield: Math.max(0, Math.round(ship.shield)),
      // Effective shield cap (kind base × per-instance shield upgrade) so the
      // inspector's shield bar denominator matches the upgraded ship (review
      // must-fix #1). hpMax already reads the upgraded ship.maxHealth.
      shieldMax: effectiveShipShieldMax(kind.shieldMax, ship.statAlloc),
    };
  }
  // structure — id is the numeric swarm entityId (as a string).
  const entityId = Number(sel.id);
  if (!Number.isFinite(entityId)) return null;
  const swarmRec = host.swarmRegistry.getByEntityId(entityId);
  if (!swarmRec) return null;
  const struct = host.structureRegistry.get(swarmRec.id);
  if (!struct) return null;
  const hp = host.swarmHealth().get(swarmRec.id);
  if (hp === undefined) return null;
  const kind = getStructureKind(struct.kind);
  // Living World P1a-2 — storage contents (owner-only: stripped in sendTo).
  const holdCap = kind.holdCapacity ?? 0;
  const h = struct.hold;
  return {
    type: 'entity_stats',
    id: sel.id,
    kind: 'structure',
    name: kind.displayName,
    hp: Math.max(0, Math.round(hp)),
    hpMax: Math.round(effectiveStructureMaxHealth(kind.maxHealth, struct.level, struct.packedQuality)),
    ...(holdCap > 0
      ? {
          hold: {
            goods: h ? { ...h.goods } : {}, blueprints: h?.blueprints.length ?? 0,
            // W2 — the stored blueprints' PRODUCT ids (owner-only like the rest):
            // the Install action picks the module ones; the panel names them.
            blueprintIds: h ? h.blueprints.slice(0, 64).map((b) => b.product) : [],
            packed: h?.packed?.length ?? 0,
            // W5a — the stored packed items' PRODUCT ids (the Unpack chips).
            packedIds: h?.packed ? h.packed.slice(0, 64).map((p) => p.product) : [],
          },
          holdCapacity: holdCap,
        }
      : {}),
  };
}

/** Living World P1a-2 — a storage hold is private: strip it from an
 *  `entity_stats` sent to anyone but the structure's owner. */
export function ownerGateStats(host: SelectionStatsResolveHost, sessionId: string, msg: EntityStatsMessage): EntityStatsMessage {
  if (msg.hold === undefined) return msg;
  const viewer = host.sessionToPlayer().get(sessionId);
  const swarmRec = host.swarmRegistry.getByEntityId(Number(msg.id));
  const owner = swarmRec ? host.structureRegistry.get(swarmRec.id)?.owner : undefined;
  // C1 — the hold shows to anyone it would open for (own + friendly today).
  if (viewer !== undefined && owner !== undefined && cargoOpensFor(relationOf(viewer, owner, host.relationCtx), false)) return msg;
  const { hold: _h, holdCapacity: _c, ...rest } = msg;
  return rest;
}
