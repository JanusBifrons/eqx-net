/**
 * Pure helpers for the Trade UI (Living World P2b, plan peppy-jumping-pinwheel).
 * No React, no Pixi — unit-tested in plain node.
 *
 * (Lives under `net/`, NOT a top-level `src/client/trade/` dir: that would
 * collide with the `/trade` Vite proxy — clientDirProxyCollision.test.ts.)
 */
import type { StructureRenderState } from '../../core/contracts/IRenderer.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { GOOD_DEFS, type GoodId } from '../../shared-types/goods.js';
import { productName } from '../../shared-types/blueprints.js';
import type { TradeHistoryEntry, TradeNotice } from '../../shared-types/economy.js';
import type { TradeToastTone } from '../state/storeTypes.js';
import { getSector } from '../../core/galaxy/galaxy.js';

/** One of the player's storage structures, for the base picker. */
export interface OwnStorage {
  entityId: number;
  kind: string;
  label: string;
}

/**
 * The local player's storage structures (Capital, Cargo Bay) in this sector,
 * Capital first. `kindOf` resolves a structure entityId to its subtype (the
 * swarm entry's shared `shipKind` byte).
 */
export function ownStorages(
  structures: ReadonlyMap<number, StructureRenderState>,
  kindOf: (entityId: number) => string | undefined,
  localPlayerId: string | null,
): OwnStorage[] {
  if (localPlayerId === null) return [];
  const out: OwnStorage[] = [];
  for (const [entityId, st] of structures) {
    if (st.owner !== localPlayerId || !st.built) continue;
    const kind = kindOf(entityId);
    if (kind === undefined) continue;
    const def = getStructureKind(kind);
    if ((def.holdCapacity ?? 0) <= 0) continue;
    out.push({ entityId, kind, label: def.displayName });
  }
  out.sort((a, b) => (a.kind === 'capital' ? -1 : b.kind === 'capital' ? 1 : a.entityId - b.entityId));
  // Player-facing labels never show an entity id (client CLAUDE.md "no raw
  // ids"): a kind that appears more than once is numbered 1, 2, …
  const total = new Map<string, number>();
  for (const s of out) total.set(s.kind, (total.get(s.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const s of out) {
    if ((total.get(s.kind) ?? 0) < 2) continue;
    const n = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, n);
    s.label = `${s.label} ${n}`;
  }
  return out;
}

/** A sector's player-facing name (galaxy name, else the key). */
export function sectorName(key: string): string {
  return getSector(key)?.name ?? key;
}

/** Toast colour + whether it counts toward the rail badge. */
export function toastForNotice(n: Pick<TradeNotice, 'event'>): { tone: TradeToastTone; unread: boolean } {
  switch (n.event) {
    case 'settled':
    case 'accepted':
      return { tone: 'good', unread: n.event === 'settled' };
    case 'raided':
    case 'under_fire':
    case 'rejected':
      return { tone: 'danger', unread: n.event !== 'rejected' };
    case 'partial':
    case 'skipped':
      return { tone: 'info', unread: true };
    default:
      return { tone: 'info', unread: false };
  }
}

/** History entries newer than `lastSeenMs` (the "while you were away" set). */
export function unseenHistory(history: readonly TradeHistoryEntry[], lastSeenMs: number): TradeHistoryEntry[] {
  return history.filter((h) => h.atMs > lastSeenMs);
}

/** One-line summary of a set of history entries. */
export function summarizeHistory(entries: readonly TradeHistoryEntry[]): string {
  let settled = 0;
  let raided = 0;
  let skipped = 0;
  let credits = 0;
  for (const e of entries) {
    if (e.outcome === 'settled' || e.outcome === 'partial') {
      settled++;
      if (e.kind === 'sell') credits += e.credits;
      else if (e.kind === 'buy') credits -= e.credits;
    } else if (e.outcome === 'raided') raided++;
    else if (e.outcome === 'skipped' || e.outcome === 'refused') skipped++;
  }
  const parts: string[] = [];
  if (settled > 0) parts.push(`${settled} deal${settled === 1 ? '' : 's'} settled`);
  if (raided > 0) parts.push(`${raided} hauler${raided === 1 ? '' : 's'} raided`);
  if (skipped > 0) parts.push(`${skipped} visit${skipped === 1 ? '' : 's'} skipped`);
  if (credits !== 0) parts.push(`${credits > 0 ? '+' : '−'}${Math.abs(credits).toLocaleString('en-US')} cr`);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing happened';
}

export function goodName(g: GoodId | null): string {
  return g === null ? 'credits' : GOOD_DEFS[g].displayName;
}

/** Economy v2 W4b — what an offer / deal trades, by name: a good, or a
 *  packed structure ("Packed Smelter"). Never an id. */
export function itemName(x: { good: GoodId | null; product?: string }): string {
  return x.product !== undefined ? `Packed ${productName(x.product)}` : goodName(x.good);
}

/** Reputation −1000..1000 → a bar fill 0..1 (0.5 = neutral). */
export function repFill(rep: number): number {
  return Math.max(0, Math.min(1, (rep + 1000) / 2000));
}

export function repLabel(rep: number): string {
  if (rep >= 500) return 'Allied';
  if (rep >= 150) return 'Friendly';
  if (rep > -150) return 'Neutral';
  if (rep > -500) return 'Wary';
  return 'Hostile';
}

export function formatPrice(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2);
}
