/**
 * Owner-only structure settings — a processor's recipe (P2b), who a gate
 * opens for, and refining salvage into a Capital's mineral bank (P1a-2).
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
import { RefineSalvageSchema, SetGateAccessSchema, SetRecipeSchema } from '../../../shared-types/messages.js';

/** What the handlers need from the room; getters read the live field. */
export interface StructureSettingMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  sectorKey(): string | null;
  production(): Pick<ProductionSubsystem, 'setRecipe'>;
  storage(): Pick<StorageService, 'flushDirty' | 'refine'>;
  rebuildStructuresSlice(): void;
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
    if (h.production().setRecipe(rec, msg.recipe)) {
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
