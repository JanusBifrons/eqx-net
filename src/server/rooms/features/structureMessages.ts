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
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { getStructureKind, isBuildableStructureKind, isDeckOnlyStructureKind, snapPlayerStructureRotation } from '../../../shared-types/structureKinds.js';
import { needsPackedCrate, productName } from '../../../shared-types/blueprints.js';
import { snapPlacementToDeck } from '../../../core/structures/deckPlacement.js';
import type { DeckSnap } from '../../../core/hex/deckSnap.js';
import {
  PlaceStructureSchema,
  PlaceStructuresSchema,
  RemoveStructureSchema,
  StructureActionSchema,
  UpgradeStructureSchema,
  type PlaceRefusalCode,
  type PlaceStructuresRefusedEvent,
} from '../../../shared-types/messages.js';
import type { StructureKindId } from '../../../shared-types/structureKinds.js';

type SeedHold = { goods: Partial<Record<'minerals' | 'salvage' | 'alloy' | 'core', number>> };

/** What the handlers need from the room; getters read the live field. */
export interface StructureMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  sectorKey(): string | null;
  storage(): Pick<StorageService, 'flushDirty'>;
  rebuildStructuresSlice(): void;
  structurePlacement(): Pick<StructurePlacementSubsystem, 'place' | 'remove' | 'lastRefusal' | 'lastRefusalCode' | 'checkBatch' | 'batchItemLaysPlate'>;
  structureGrid(): Pick<StructureGridSubsystem, 'reconnect' | 'lastReconnectRefusal' | 'clearConnections' | 'upgradeStructure'>;
  sectorPersistence(): Pick<SectorPersistence, 'persistSoon'>;
  testSeedStorageHold(): SeedHold | null;
  /** Room flag `state.deck` (base platforms): snap player placements to deck slots. */
  deck(): boolean;
  findPacked(owner: string, product: string): { rec: StructureRecord } | { shipId: string } | null;
  sendNotice(client: Client, text: string): void;
  logger: Pick<Logger, 'warn'>;
}

/** Deck-snap scratch for `place_structure` (invariant 14). */
const deckSnap: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 };

/** One player placement's pose after the snap (pooled, #14). */
interface SnappedItem { kind: StructureKindId; x: number; y: number; rot: number; mirror: boolean }

/** May a player place `kind` here at all? v4 A: nobody builds an alien
 *  gate; a deck tile (road) exists only on a deck room. */
function playerMayBuild(h: StructureMessageHost, kind: StructureKindId): boolean {
  return isBuildableStructureKind(kind) && !(isDeckOnlyStructureKind(kind) && !h.deck());
}

/**
 * Base platforms: on a deck room the PLAYER's point snaps to its kind's deck
 * slot (the client ghost runs the same core snap) and must stand on the
 * owner's deck (`off-deck`, same core rule). place() never snaps. The turn
 * snaps by the same rule as the ghost: on a deck room the snap decides it (a
 * small building faces its third of the hex; otherwise 30° steps, quarter
 * turns for a quarter-turn-only kind); quarter turns off deck. place() itself
 * keeps any 30° step.
 */
function snapPlayerPlacement(h: StructureMessageHost, m: { kind: StructureKindId; x: number; y: number; rot?: number; mirror?: boolean }, out: SnappedItem): SnappedItem {
  out.kind = m.kind; out.x = m.x; out.y = m.y; out.mirror = m.mirror === true;
  out.rot = snapPlayerStructureRotation(m.rot, false, m.kind);
  if (h.deck()) {
    snapPlacementToDeck(m.kind, m.x, m.y, deckSnap, m.rot);
    out.x = deckSnap.x; out.y = deckSnap.y; out.rot = deckSnap.rot;
  }
  return out;
}

/** The single placement's snapped pose (#14). */
const one: SnappedItem = { kind: 'connector', x: 0, y: 0, rot: 0, mirror: false };
/** `place_structures` scratch (#14): snapped items, the refused lists and the reply. */
const batchItems: SnappedItem[] = [];
const batchView: SnappedItem[] = [];
const refusedIndex: number[] = [];
const refusedCode: PlaceRefusalCode[] = [];
const refusedReply: PlaceStructuresRefusedEvent = { type: 'place_structures_refused', refused: [] };
const refusedPool: Array<{ index: number; code: PlaceRefusalCode }> = [];

export function registerStructureMessages(h: StructureMessageHost): RoomFeature {
  /** A player placement landed: the testMode storage seed and the audit line
   *  (the slice refresh + persist are the caller's, once per message). */
  const placed = (id: string, owner: string, kind: string, x: number, y: number): void => {
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
    auditEvent({ event: 'structure_placed', sector: h.sectorKey() ?? undefined, owner, kind, x, y });
  };
  /** Refresh the slice so the new blueprint + its auto-connection appear on
   *  the next snapshot without waiting for the 1 Hz pulse; Campaign 6.3 —
   *  event-driven persist so a crash can't erase the placement (the 60 s
   *  cadence + onDispose never run on a crash). */
  const afterPlacing = (): void => {
    h.rebuildStructuresSlice();
    h.sectorPersistence().persistSoon();
  };

  // ── Structures plan, Phase 2 — placement / removal ──────────────────
  parsedMessage(h, 'place_structure', PlaceStructureSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    if (!playerMayBuild(h, msg.kind)) return;
    const it = snapPlayerPlacement(h, msg, one);
    const id = h.structurePlacement().place(
      owner,
      it.kind,
      it.x,
      it.y,
      // P2b — only a PLAYER's placement can need a packed structure.
      { rot: it.rot, mirror: it.mirror, requirePacked: true, deck: h.deck() },
    );
    if (id === null) {
      // Say why when it was the Capital's packed crate that was missing.
      const kindId = msg.kind;
      const refusal = h.structurePlacement().lastRefusal;
      // The point and the reason in server.log too: the event ring below is
      // flooded by tick_budget lines and lost the owner's 2026-11-27 refusals.
      h.logger.warn({ sessionId: client.sessionId, kind: msg.kind, x: Math.round(px), y: Math.round(py), refusal }, 'place_structure rejected');
      // Diagnostic captures (build bucket): the raw and snapped point and why.
      serverLogEvent('place_structure_rejected', { owner, kind: msg.kind, rawX: msg.x, rawY: msg.y, x: px, y: py, deck: h.deck(), refusal });
      if (refusal !== null) h.sendNotice(client, refusal);
      else if (needsPackedCrate(kindId) && h.findPacked(owner, `structure:${kindId}`) === null) {
        h.sendNotice(client, `You need a Packed ${productName(`structure:${kindId}`)} in your hold or storage here.`);
      }
    } else {
      placed(id, owner, msg.kind, msg.x, msg.y);
      afterPlacing();
    }
  });

  // Plan then Build: every planned building at once, ALL OR NOTHING. Every
  // item is checked first (each against the batch's earlier items too, crates
  // summed: `checkBatch`); one refusal places none and replies
  // `place_structures_refused` with each refused index + code. Success sends
  // what a single placement does (the slice refresh; no reply).
  parsedMessage(h, 'place_structures', PlaceStructuresSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    batchView.length = 0;
    for (let i = 0; i < msg.items.length; i++) {
      const b = batchItems[i] ?? (batchItems[i] = { kind: 'connector', x: 0, y: 0, rot: 0, mirror: false });
      batchView.push(snapPlayerPlacement(h, msg.items[i]!, b));
    }
    const placement = h.structurePlacement();
    placement.checkBatch(owner, batchView, h.deck(), refusedIndex, refusedCode);
    // A kind a player may never place here is refused too (merged in order).
    for (let i = 0; i < batchView.length; i++) {
      if (playerMayBuild(h, batchView[i]!.kind)) continue;
      const at = refusedIndex.indexOf(i);
      if (at >= 0) { refusedCode[at] = 'not-buildable'; continue; }
      let k = 0;
      while (k < refusedIndex.length && refusedIndex[k]! < i) k++;
      refusedIndex.splice(k, 0, i);
      refusedCode.splice(k, 0, 'not-buildable');
    }
    if (refusedIndex.length > 0) {
      const reply = refusedReply.refused;
      reply.length = 0;
      for (let k = 0; k < refusedIndex.length; k++) {
        const e = refusedPool[k] ?? (refusedPool[k] = { index: 0, code: 'not-buildable' });
        e.index = refusedIndex[k]!; e.code = refusedCode[k]!;
        reply.push(e);
        const it = batchView[e.index]!;
        h.logger.warn({ sessionId: client.sessionId, kind: it.kind, x: it.x, y: it.y, refusal: e.code, index: e.index }, 'place_structures rejected');
      }
      try { client.send('place_structures_refused', refusedReply); } catch { /* socket closing */ }
      if (placement.lastRefusal !== null) h.sendNotice(client, placement.lastRefusal);
      return;
    }
    // All clear: commit. Plate-laying connectors first, so the buildings
    // planned on their new plates stand on the deck when they land.
    let n = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < batchView.length; i++) {
        if (placement.batchItemLaysPlate(i) !== (pass === 0)) continue;
        const it = batchView[i]!;
        const id = placement.place(owner, it.kind, it.x, it.y, { rot: it.rot, mirror: it.mirror, requirePacked: true, deck: h.deck() });
        if (id === null) {
          // Checked legal a moment ago; only a full slot pool lands here.
          h.logger.warn({ sessionId: client.sessionId, kind: it.kind, x: it.x, y: it.y, refusal: placement.lastRefusalCode, index: i }, 'place_structures commit failed');
          continue;
        }
        const src = msg.items[i]!;
        placed(id, owner, it.kind, src.x, src.y);
        n++;
      }
    }
    if (n > 0) afterPlacing();
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
      case 'reconnect': {
        // Say why when nothing new linked (e.g. a rock across the line).
        const grid = h.structureGrid();
        grid.reconnect(rec.id);
        if (grid.lastReconnectRefusal !== null) h.sendNotice(client, grid.lastReconnectRefusal);
        break;
      }
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
