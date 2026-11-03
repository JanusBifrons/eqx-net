/**
 * Freight contracting (plan soft-leaping-truffle v4, phase C): which factions
 * a convoy hauler flies for, so a room can charge a raider standing with both.
 * Process-wide (the `ConvoyDirector` is), like the trade sink. Written when a
 * convoy launches, removed when it ends.
 */
import type { FactionId } from '../../shared-types/factions.js';

export interface HaulerFactions {
  owner: FactionId;
  carrier: FactionId;
}

const HAULERS = new Map<string, HaulerFactions>();

export function registerConvoyHauler(haulerId: string, f: HaulerFactions): void {
  HAULERS.set(haulerId, f);
}

export function convoyHaulerFactions(haulerId: string): HaulerFactions | undefined {
  return HAULERS.get(haulerId);
}

export function forgetConvoyHauler(haulerId: string): void {
  HAULERS.delete(haulerId);
}

/** Tests: start clean. */
export function clearConvoyHaulers(): void {
  HAULERS.clear();
}
