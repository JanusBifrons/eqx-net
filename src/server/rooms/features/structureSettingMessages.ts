/**
 * Owner-only structure settings — a processor's recipe (P2b) and recipe queue (B2), who a gate
 * opens for, switching a structure On / Off (and its power throttle), and refining salvage into a Capital's mineral bank (P1a-2).
 * Moved verbatim out of `SectorRoom.onCreate`; the room hands in live
 * accessors so every handler reads the same state it did there.
 */
import type { StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { ProductionSubsystem } from '../../structures/ProductionSubsystem.js';
import type { StorageService } from '../../cargo/StorageService.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { gateTypeOf } from '../../../core/structures/gateGeometry.js';
import { gateAccessIndex } from '../../../shared-types/gateAccess.js';
import { isProcessorKind } from '../../../shared-types/production.js';
import { EditRecipeQueueSchema, RefineSalvageSchema, SetGateAccessSchema, SetRecipeSchema, SetStructurePowerSchema } from '../../../shared-types/messages.js';
import { editRecipeQueue } from '../../structures/productionQueue.js';
import { blueprintProductFor } from '../../../shared-types/recipes.js';
import { blueprintQuality } from '../../../shared-types/blueprints.js';
import type { StructureGridSubsystem } from '../../structures/StructureGridSubsystem.js';

/** What the handlers need from the room; getters read the live field. */
export interface StructureSettingMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  sectorKey(): string | null;
  production(): Pick<ProductionSubsystem, 'setRecipe' | 'recipeOf'>;
  storage(): Pick<StorageService, 'flushDirty' | 'refine' | 'loadBlueprint' | 'unloadBlueprint'>;
  rebuildStructuresSlice(): void;
  /** The flown hull, else the hull parked by Command / Build (`PilotSwap.ownShipKey`). */
  ownShipKey(playerId: string): string | undefined;
  structureGrid(): Pick<StructureGridSubsystem, 'setSwitchedOn' | 'setThrottle'>;
}

export function registerStructureSettingMessages(h: StructureSettingMessageHost): RoomFeature {
  // ── P2b — the owner picks a processor's recipe ──
  // Owner-gated; a foreign / non-processor / wrong-recipe request is a no-op.
  parsedMessage(h, 'set_recipe', SetRecipeSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(msg.entityId);
    if (!swarmRec) return;
    const rec = h.structureRegistry.get(swarmRec.id);
    if (!rec || rec.owner !== owner || !isProcessorKind(rec.kind)) return;
    if (h.production().setRecipe(rec, msg.recipe, msg.count)) {
      // A loaded blueprint for another product would stall the new recipe:
      // swap in the best match (base storage, else the owner's own ship hold,
      // exactly as a manual Load), else put it back (stays if no room).
      const product = blueprintProductFor(msg.recipe);
      if (rec.blueprint !== undefined && rec.blueprint.product !== product
        && !h.storage().loadBlueprint(rec, product, blueprintQuality, h.ownShipKey(owner))) h.storage().unloadBlueprint(rec);
      h.storage().flushDirty();
      h.rebuildStructuresSlice();
    }
  });

  // ── Building panels B2 — the owner edits a processor's recipe queue ──
  // Same gate as set_recipe; a refused edit is a silent no-op.
  parsedMessage(h, 'edit_recipe_queue', EditRecipeQueueSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(msg.entityId);
    if (!swarmRec) return;
    const rec = h.structureRegistry.get(swarmRec.id);
    if (!rec || rec.owner !== owner || !isProcessorKind(rec.kind)) return;
    if (editRecipeQueue(h.production(), rec, msg)) {
      h.storage().flushDirty();
      h.rebuildStructuresSlice();
    }
  });

  // ── Gates — set who a gate opens for (owner-gated) ──
  parsedMessage(h, 'set_gate_access', SetGateAccessSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(msg.entityId);
    if (!swarmRec) return;
    const rec = h.structureRegistry.get(swarmRec.id);
    if (!rec || rec.owner !== owner || gateTypeOf(rec.kind) === null) return;
    rec.gateAccess = gateAccessIndex(msg.access);
    h.rebuildStructuresSlice();
  });

  // ── Base loop — the owner switches a structure On / Off (owner-gated) ──
  // Feeds the grid's one active-power switch; a no-Off kind is a no-op.
  // An optional `throttle` (tenths) scales the same kind's draw.
  parsedMessage(h, 'set_structure_power', SetStructurePowerSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(msg.entityId);
    if (!swarmRec) return;
    const rec = h.structureRegistry.get(swarmRec.id);
    if (!rec || rec.owner !== owner) return;
    const switched = h.structureGrid().setSwitchedOn(rec, msg.on);
    const throttled = msg.throttle !== undefined && h.structureGrid().setThrottle(rec, msg.throttle);
    if (switched || throttled) h.rebuildStructuresSlice();
  });

  // ── Living World P1a-2 — refine salvage into a Capital's mineral bank ──
  // Owner-gated; a foreign / non-Capital / empty request is a silent no-op.
  parsedMessage(h, 'refine_salvage', RefineSalvageSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(msg.entityId);
    if (!swarmRec) return;
    const rec = h.structureRegistry.get(swarmRec.id);
    if (!rec || rec.owner !== owner) return; // own-only
    const refined = h.storage().refine(rec, msg.qty);
    if (refined > 0) {
      auditEvent({ event: 'salvage_refined', sector: h.sectorKey() ?? undefined, owner, salvage: refined });
      h.rebuildStructuresSlice(); // the bank (minerals) rides the slice
    }
  });

  return {};
}
