/**
 * Economy v2 — the player's packed-structure stock for the Build menus, from
 * the server's `packed_stock` replies (#16). Asks when a build menu opens and
 * every few seconds while it stays open (placing / buying changes the counts).
 */
import { useEffect } from 'react';
import { useUIStore } from '../state/store';
import { sendPackedStockQuery } from '../net/tradeClient';

export const PACKED_STOCK_POLL_MS = 3000;

export function usePackedStock(active: boolean): Readonly<Record<string, number>> | null {
  const counts = useUIStore((s) => s.packedStock);
  useEffect(() => {
    if (!active) return;
    sendPackedStockQuery();
    const t = setInterval(sendPackedStockQuery, PACKED_STOCK_POLL_MS);
    return () => clearInterval(t);
  }, [active]);
  return counts;
}
