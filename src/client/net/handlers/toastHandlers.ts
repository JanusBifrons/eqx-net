/**
 * Server → client toast and loot-feed notices. Accelerators only (#16): each
 * parses (#3) and pushes one HUD toast or loot-feed line, expiring it later.
 */
import type { Room } from 'colyseus.js';
import { useUIStore } from '../../state/store';
import { formatLootPickup, LOOT_FEED_TTL_MS } from '../lootView';
import { toastForNotice } from '../tradeView';
import { ServerMessageSchemas } from '@shared-types/messages';
import { onFactionLookClaimed } from '../factionLookSync.js';
import { TradeNoticeSchema } from '../../../shared-types/economy.js';
import { WorldNoticeSchema } from '../../../shared-types/worldNotice.js';
import { BountyResultSchema } from '../../../shared-types/contracts.js';
import { BlueprintResultSchema } from '../../../shared-types/blueprints.js';

const TRADE_TOAST_TTL_MS = 6_000;

/** The toast handlers touch only the UI store, so they need no context. */
export type ToastHandlerCtx = Record<never, never>;

export function registerToastHandlers(room: Room, _ctx: ToastHandlerCtx): void {
  room.onMessage('notice', (raw: unknown) => {
    const parsed = ServerMessageSchemas.notice.safeParse(raw);
    if (!parsed.success) return;
    const id = useUIStore.getState().pushLootFeed(parsed.data.text);
    setTimeout(() => useUIStore.getState().expireLootFeed(id), LOOT_FEED_TTL_MS);
  });
  // C2 — a break-in alarm (owner) or result (actor). Accelerator only.
  room.onMessage('break_in_notice', (raw: unknown) => {
    const parsed = ServerMessageSchemas.break_in_notice.safeParse(raw);
    if (!parsed.success) return;
    const id = useUIStore.getState().pushTradeToast(parsed.data.message, parsed.data.tone, false);
    setTimeout(() => useUIStore.getState().expireTradeToast(id), TRADE_TOAST_TTL_MS);
  });
  // Living World P5 — a blueprint install verdict (accelerator only).
  room.onMessage('blueprint_result', (raw: unknown) => {
    const parsed = BlueprintResultSchema.safeParse(raw);
    if (!parsed.success) return;
    const id = useUIStore.getState().pushTradeToast(parsed.data.message, parsed.data.ok ? 'good' : 'danger', false);
    setTimeout(() => useUIStore.getState().expireTradeToast(id), TRADE_TOAST_TTL_MS);
  });
  // Living World P4c-2 — a bounty placement verdict (accelerator only).
  room.onMessage('bounty_result', (raw: unknown) => {
    const parsed = BountyResultSchema.safeParse(raw);
    if (!parsed.success) return;
    const id = useUIStore.getState().pushTradeToast(parsed.data.message, parsed.data.ok ? 'good' : 'danger', false);
    setTimeout(() => useUIStore.getState().expireTradeToast(id), TRADE_TOAST_TTL_MS);
  });
  // A faction ship-look claim verdict (accelerator only).
  room.onMessage('claim_faction_look_result', (raw: unknown) => {
    const parsed = ServerMessageSchemas.claim_faction_look_result.safeParse(raw);
    if (!parsed.success) return;
    const id = useUIStore.getState().pushTradeToast(parsed.data.message, parsed.data.ok ? 'good' : 'danger', false);
    setTimeout(() => useUIStore.getState().expireTradeToast(id), TRADE_TOAST_TTL_MS);
  });
  // Someone claimed a ship look (accelerator; the welcome carries them all).
  room.onMessage('faction_look_claimed', onFactionLookClaimed);
  // Living World P2 — trade toasts + Trade-tab badge. An ACCELERATOR only:
  // the tab's truth is `GET /trade/economy` (it refetches on tradeNoticeSeq).
  room.onMessage('trade_notice', (raw: unknown) => {
    const parsed = TradeNoticeSchema.safeParse(raw);
    if (!parsed.success) return;
    const { tone, unread } = toastForNotice(parsed.data);
    const id = useUIStore.getState().pushTradeToast(parsed.data.message, tone, unread);
    setTimeout(() => useUIStore.getState().expireTradeToast(id), TRADE_TOAST_TTL_MS);
  });
  // Living World P4 — galaxy-wide world notices (elite sighted / destroyed).
  // An accelerator only (#16): the elite itself rides the snapshot + map.
  room.onMessage('world_notice', (raw: unknown) => {
    const parsed = WorldNoticeSchema.safeParse(raw);
    if (!parsed.success) return;
    const id = useUIStore.getState().pushTradeToast(parsed.data.message, 'world', false);
    setTimeout(() => useUIStore.getState().expireTradeToast(id), TRADE_TOAST_TTL_MS);
  });
  room.onMessage('cargo_deposited', (raw: unknown) => {
    const parsed = ServerMessageSchemas.cargo_deposited.safeParse(raw);
    if (!parsed.success) return;
    const text = formatLootPickup(parsed.data);
    if (text === '') return;
    const id = useUIStore.getState().pushLootFeed(`Banked ${text}`);
    setTimeout(() => useUIStore.getState().expireLootFeed(id), LOOT_FEED_TTL_MS);
  });
  room.onMessage('loot_collected', (raw: unknown) => {
    const parsed = ServerMessageSchemas.loot_collected.safeParse(raw);
    if (!parsed.success) return;
    const text = formatLootPickup(parsed.data);
    if (text === '') return;
    const id = useUIStore.getState().pushLootFeed(text);
    setTimeout(() => useUIStore.getState().expireLootFeed(id), LOOT_FEED_TTL_MS);
  });
}
