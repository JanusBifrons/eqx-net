/**
 * The own-ship snapshot's economy numbers → Zustand (#16: the snapshot is
 * the only source). Each is a store write only on change, so the HUD
 * re-renders when the value moves, not every snapshot. Extension point of
 * `ColyseusClient.handleSnapshot`.
 */
import { useUIStore } from '../state/store';

export interface OwnEconomySlice {
  /** Economy v2 W1 — the wallet balance. */
  wallet?: number;
  /** Join flow — free capital launches left. */
  freeLaunches?: number;
}

/** `fakeCredits` (`?fakeCredits=1`, HUD demo only) owns the wallet: the
 *  server write is skipped so the demo drip isn't reset every snapshot. */
export function syncOwnEconomy(s: OwnEconomySlice, fakeCredits: boolean): void {
  const ui = useUIStore.getState();
  if (s.wallet !== undefined && !fakeCredits && ui.wallet !== s.wallet) ui.setWallet(s.wallet);
  if (s.freeLaunches !== undefined && ui.freeLaunches !== s.freeLaunches) ui.setFreeLaunches(s.freeLaunches);
}
