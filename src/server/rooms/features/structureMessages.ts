/**
 * Structure client messages — placement / removal (Structures plan Phase 2),
 * the owner's action buttons (deconstruct toggle / reconnect / clear
 * connections) and paid leveling (Phase 4 WS-B4). Moved verbatim out of
 * `SectorRoom.onCreate`; the room hands in live accessors so every handler
 * reads the same state it did there.
 */
import type { Client } from 'colyseus';
import type { Logger } from 'pino';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { StructurePlacementSubsystem } from '../../structures/StructurePlacementSubsystem.js';
import type { StructureGridSubsystem } from '../../structures/StructureGridSubsystem.js';
import type { StorageService } from '../../cargo/StorageService.js';
import type { SectorPersistence } from '../SectorPersistence.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { getStructureKind, isBuildableStructureKind } from '../../../shared-types/structureKinds.js';
import { STARTER_STRUCTURE_KINDS, productName } from '../../../shared-types/blueprints.js';
import {
  PlaceStructureSchema,
  RemoveStructureSchema,
  StructureActionSchema,
  UpgradeStructureSchema,
} from '../../../shared-types/messages.js';

type SeedHold = { goods: Partial<Record<'minerals' | 'salvage' | 'alloy' | 'core', number>> };

/** What the handlers need from the room; getters read the live field. */
export interface StructureMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  sectorKey(): string | null;
  storage(): Pick<StorageService, 'flushDirty'>;
  rebuildStructuresSlice(): void;
  structurePlacement(): Pick<StructurePlacementSubsystem, 'place' | 'remove' | 'lastRefusal'>;
  structureGrid(): Pick<StructureGridSubsystem, 'reconnect' | 'clearConnections' | 'upgradeStructure'>;
  sectorPersistence(): Pick<SectorPersistence, 'persistSoon'>;
  testSeedStorageHold(): SeedHold | null;
  findPacked(owner: string, product: string): { rec: StructureRecord } | { shipId: string } | null;
  sendNotice(client: Client, text: string): void;
  logger: Pick<Logger, 'warn'>;
}

export function registerStructureMessages(h: StructureMessageHost): RoomFeature {
  // ── Structures plan, Phase 2 — placement / removal ──────────────────
  parsedMessage(h, 'place_structure', PlaceStructureSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    // v4 A — nobody builds an alien gate.
    if (!isBuildableStructureKind(msg.kind)) return;
    const id = h.structurePlacement().place(
      owner,
      msg.kind,
      msg.x,
      msg.y,
      // P2b — only a PLAYER's placement can need a packed structure.
      { rot: msg.rot, requirePacked: true },
    );
    if (id === null) {
      h.logger.warn({ sessionId: client.sessionId, kind: msg.kind }, 'place_structure rejected');
      // Economy v2 W4b — say why when it was the packed item that was missing.
      const kindId = msg.kind;
      const refusal = h.structurePlacement().lastRefusal;
      if (refusal !== null) h.sendNotice(client, refusal);
      else if (!STARTER_STRUCTURE_KINDS.includes(kindId) && h.findPacked(owner, `structure:${kindId}`) === null) {
        h.sendNotice(client, `You need a Packed ${productName(`structure:${kindId}`)}: buy one on the Trade tab, or loot one.`);
      }
    } else {
      // P2 bespoke trigger (testMode) — a placed storage structure starts
      // stocked, so a trade E2E/showcase needn't fly cargo home first.
      const seed = h.testSeedStorageHold();
      if (seed !== null) {
        const s = h.structureRegistry.get(id);
        if (s !== undefined && (getStructureKind(s.kind).holdCapacity ?? 0) > 0) {
          s.hold = { goods: { ...seed.goods }, blueprints: [] };
          h.storage().flushDirty();
        }
      }
      // Refresh the slice so the new blueprint + its auto-connection appear on
      // the next snapshot without waiting for the 1 Hz pulse.
      h.rebuildStructuresSlice();
      // Campaign 6.3 — event-driven persist so a crash can't erase the
      // placement (the 60 s cadence + onDispose never run on a crash).
      h.sectorPersistence().persistSoon();
      auditEvent({
        event: 'structure_placed',
        sector: h.sectorKey() ?? undefined,
        owner,
        kind: msg.kind,
        x: msg.x,
        y: msg.y,
      });
    }
  });

  parsedMessage(h, 'remove_structure', RemoveStructureSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    // Capture the kind BEFORE removal (the record is gone afterwards).
    const removedKind = h.structureRegistry.get(msg.id)?.kind;
    if (h.structurePlacement().remove(owner, msg.id)) {
      h.rebuildStructuresSlice();
      // Campaign 6.3 — a removal is durable state too (a crash must not
      // resurrect a removed structure from a stale snapshot).
      h.sectorPersistence().persistSoon();
      auditEvent({
        event: 'structure_removed',
        sector: h.sectorKey() ?? undefined,
        owner,
        kind: removedKind ?? 'unknown',
      });
    }
  });

  // Phase-1 issue 6 — structure action buttons (deconstruct toggle / reconnect
  // / clear connections). The client references the structure by its numeric
  // swarm entityId (the selected id); resolve → registry record → OWNER-gate.
  parsedMessage(h, 'structure_action', StructureActionSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(msg.id);
    if (!swarmRec) return;
    const rec = h.structureRegistry.get(swarmRec.id);
    if (!rec || rec.owner !== owner) return; // own-only
    switch (msg.action) {
      case 'toggle_deconstruct':
        rec.isDeconstructing = !rec.isDeconstructing;
        break;
      case 'reconnect':
        h.structureGrid().reconnect(rec.id);
        break;
      case 'clear_connections':
        h.structureGrid().clearConnections(rec.id);
        break;
    }
    // Refresh the slice so the button state + web update on the next snapshot
    // without waiting for the 1 Hz pulse.
    h.rebuildStructuresSlice();
  });

  // ── Phase 4 WS-B4 — structure leveling (paid Upgrade build phase) ──────
  // The client references the structure by its numeric swarm entityId (the
  // selected id); resolve → registry record → OWNER-gate, then start a paid
  // build phase (charges drained during the build by the grid pulse). On the
  // build's completion the level increments + the per-level stat grant applies.
  parsedMessage(h, 'upgrade_structure', UpgradeStructureSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(msg.entityId);
    if (!swarmRec) return;
    const rec = h.structureRegistry.get(swarmRec.id);
    if (!rec || rec.owner !== owner) return; // own-only
    if (h.structureGrid().upgradeStructure(rec.id)) {
      // Refresh the slice so the blueprint state + the LVL line update on the
      // next snapshot without waiting for the 1 Hz pulse. The build's
      // COMPLETION is audited via `onConstructed` (`structure_built`).
      h.rebuildStructuresSlice();
    }
  });

  return {};
}
