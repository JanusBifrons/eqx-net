/**
 * Join flow — SectorRoom's launch gate, moved out of the room (god-file cap).
 *
 * The ship-picker gate (Economy v2 W5b): a launchable hull (the launch table,
 * shared-types/launch.ts: sub-capitals and the player capitals) needs no packed
 * hull; any other kind must be a ship you OWN (a roster row). The same gate
 * pays for the launch (`chargeLaunch`: wallet, free launch or debt). A fresh
 * spawn the pilot can't have or can't pay for launches a Fighter instead, and
 * is told why. Respawn charges through `chargeLaunchFor` too.
 */
import type { LaunchVerdict } from '../../shared-types/launch.js';
import { DEFAULT_SHIP_KIND, getShipKind } from '../../shared-types/shipKinds.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { getWallet } from '../db/PersistenceWorker.js';
import { chargeLaunch } from '../economy/launchCharge.js';
import { getTradeSink } from '../economy/tradeSink.js';

/** The room's one charging seam (join gate and respawn). */
export function chargeLaunchFor(costsOn: boolean, playerId: string, kind: string): LaunchVerdict {
  const sink = getTradeSink();
  return chargeLaunch({
    wallet: getWallet(),
    freeLaunches: (pid) => sink?.freeLaunches?.(pid) ?? 0,
    spendFreeLaunch: (pid) => sink?.spendFreeLaunch?.(pid) ?? false,
    costsOn,
  }, playerId, kind);
}

/** Charge a fresh launch of `kind`; returns the kind that actually launches. */
export function gateLaunch(costsOn: boolean, playerId: string, kind: string, notice: (msg: string) => void): string {
  const verdict = chargeLaunchFor(costsOn, playerId, kind);
  if (verdict.kind !== 'refuse') return kind;
  const wanted = getShipKind(kind).displayName;
  notice(verdict.reason === 'shipyard'
    ? `You need a ${wanted}: buy a packed one on the Trade tab (or loot one), then unpack it at your storage.`
    : `You can't afford a ${wanted} (${verdict.cost.toLocaleString('en-GB')} credits): you launched in a Fighter.`);
  serverLogEvent('hull_gate_refused', { playerId, wanted, reason: verdict.reason });
  return DEFAULT_SHIP_KIND;
}

/** Economy v2 W1 — test-only wallet seed: top the wallet up to `seed`. */
export function seedTestWallet(playerId: string, seed: number): void {
  if (seed <= 0) return;
  const have = getWallet().balance(playerId);
  if (have < seed) getWallet().credit(playerId, seed - have, 'test_seed');
}
