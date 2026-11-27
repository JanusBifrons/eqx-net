/**
 * Server → client structure-panel views: cargo, packed stock, blueprint
 * market, research lab and teleporter prompts. Each is a whole view the
 * panel rebuilds from (#16); zod-validated (#3), written to the UI store.
 */
import type { Room } from 'colyseus.js';
import { useUIStore } from '../../state/store';
import { ServerMessageSchemas } from '@shared-types/messages';
import { BpMarketStateSchema } from '../../../shared-types/blueprintMarket.js';
import { PackedStockSchema } from '../../../shared-types/packedStock.js';
import {
  PairRequestPromptSchema,
  TeleportCandidatesReplySchema,
  TollPromptSchema,
} from '../../../shared-types/teleport.js';
import { onPlaceStructuresPlaced, onPlaceStructuresRefused } from '../../structures/placementCancel.js';

/** The structure-panel handlers touch only the UI store, so they need no context. */
export type StructurePanelHandlerCtx = Record<never, never>;

export function registerStructurePanelHandlers(room: Room, _ctx: StructurePanelHandlerCtx): void {
  // C1 — a structure's cargo (and our hold) for the cargo panel (#16).
  room.onMessage('cargo_state', (raw: unknown) => {
    const parsed = ServerMessageSchemas.cargo_state.safeParse(raw);
    if (!parsed.success) return;
    useUIStore.getState().setCargoState(parsed.data);
  });
  // Economy v2 — packed-structure counts (the Build menus label/lock from them).
  room.onMessage('packed_stock', (raw: unknown) => {
    const parsed = PackedStockSchema.safeParse(raw);
    if (!parsed.success) return;
    useUIStore.getState().setPackedStock(parsed.data.counts);
  });
  // Economy v2 W6 — the blueprint market view (the Trade tab rebuilds from it).
  room.onMessage('bp_market_state', (raw: unknown) => {
    const parsed = BpMarketStateSchema.safeParse(raw);
    if (!parsed.success) return;
    useUIStore.getState().setBpMarket(parsed.data);
  });
  room.onMessage('teleport_toll', (raw: unknown) => {
    const parsed = TollPromptSchema.safeParse(raw);
    if (parsed.success) useUIStore.getState().setTollPrompt(parsed.data);
  });
  room.onMessage('teleport_pair_request', (raw: unknown) => {
    const parsed = PairRequestPromptSchema.safeParse(raw);
    if (parsed.success) useUIStore.getState().addPairRequest(parsed.data);
  });
  room.onMessage('teleport_candidates', (raw: unknown) => {
    const parsed = TeleportCandidatesReplySchema.safeParse(raw);
    if (!parsed.success) return;
    useUIStore.getState().setTeleportCandidates(parsed.data);
  });
  // Plan then Build: the batch was refused (nothing placed); mark the refused
  // planned buildings, keep the plan. Or it landed: clear the plan. Each reply
  // only acts on the Build it echoes (batchId).
  room.onMessage('place_structures_refused', (raw: unknown) => {
    const parsed = ServerMessageSchemas.place_structures_refused.safeParse(raw);
    if (parsed.success) onPlaceStructuresRefused(parsed.data.batchId, parsed.data.refused);
  });
  room.onMessage('place_structures_placed', (raw: unknown) => {
    const parsed = ServerMessageSchemas.place_structures_placed.safeParse(raw);
    if (parsed.success) onPlaceStructuresPlaced(parsed.data.batchId);
  });
  // Economy v2 W3 — the Research Lab panel's view (a reply to lab_query /
  // lab_start / lab_cancel; the panel is rebuilt from it alone).
  room.onMessage('lab_state', (raw: unknown) => {
    const parsed = ServerMessageSchemas.lab_state.safeParse(raw);
    if (!parsed.success) return;
    useUIStore.getState().setLabState(parsed.data);
  });
}
