/**
 * Launching a hull from the Hangar (join flow, owner 2026-11-18).
 *
 * ONE table says which hulls you can launch without building one, and what
 * each costs. `STARTER_HULL_KINDS` (blueprints.ts) is derived from it, and the
 * server's hull gate and the Hangar both ask `launchVerdict`, so the window
 * never promises a launch the server refuses.
 *
 * Sub-capitals are free. A capital costs credits; a new pilot with no credits
 * spends one of a few one-shot FREE LAUNCHES, then may go into debt down to
 * `DEBT_FLOOR`. A hull you own parked in the sector launches free (it resumes
 * by `shipId`). Shipyard hulls (heavy, interceptor, …) are not in the table:
 * those are built packed and unpacked, never launched for credits.
 */

/** Off until the Hangar shows prices (join-flow stage 5): every cost reads 0. */
export const LAUNCH_COSTS_ON = false;

/** Free capital launches every pilot starts with. */
export const FREE_LAUNCHES_START = 5;

/** The lowest a wallet may go by launching into debt. */
export const DEBT_FLOOR = -100_000;

/** Credits to launch each hull (placeholders, owner to tune). Fits cost the
 *  same as their base hull. Adding a launchable hull = one row here. */
export const LAUNCH_COST: Readonly<Record<string, number>> = {
  scout: 0,
  fighter: 0,
  destroyer: 2_500,
  'light-cruiser': 8_000,
  'heavy-cruiser': 15_000,
  'heavy-cruiser-beam': 15_000,
  battlecruiser: 30_000,
  'battlecruiser-lance': 30_000,
  battleship: 60_000,
  'battleship-rail': 60_000,
};

/** Every hull you can launch without building one. */
export const LAUNCHABLE_HULL_KINDS: readonly string[] = Object.keys(LAUNCH_COST);

export function isLaunchableHull(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(LAUNCH_COST, kind);
}

/** What launching `kind` costs right now (0 while costs are off). */
export function launchCost(kind: string, costsOn: boolean = LAUNCH_COSTS_ON): number {
  return costsOn ? (LAUNCH_COST[kind] ?? 0) : 0;
}

export type LaunchVerdict =
  | { kind: 'owned'; cost: 0 }
  | { kind: 'free'; cost: 0 }
  | { kind: 'pay'; cost: number }
  | { kind: 'token'; cost: 0 }
  | { kind: 'debt'; cost: number }
  | { kind: 'refuse'; cost: number; reason: 'shipyard' | 'broke' };

export interface LaunchInput {
  kind: string;
  /** Current balance (may be negative when in debt). */
  wallet: number;
  freeLaunches: number;
  /** The pilot owns this hull, parked in this sector. */
  ownedHere: boolean;
  /** Defaults to `LAUNCH_COSTS_ON`; tests pass it explicitly. */
  costsOn?: boolean;
}

/** Can this pilot launch `kind` here, and how is it paid for? Order: owned,
 *  free, pay from the wallet, spend a free launch, go into debt, refuse. */
export function launchVerdict({ kind, wallet, freeLaunches, ownedHere, costsOn }: LaunchInput): LaunchVerdict {
  if (ownedHere) return { kind: 'owned', cost: 0 };
  if (!isLaunchableHull(kind)) return { kind: 'refuse', cost: 0, reason: 'shipyard' };
  const cost = launchCost(kind, costsOn);
  if (cost === 0) return { kind: 'free', cost: 0 };
  if (wallet >= cost) return { kind: 'pay', cost };
  if (freeLaunches > 0) return { kind: 'token', cost: 0 };
  if (wallet - cost >= DEBT_FLOOR) return { kind: 'debt', cost };
  return { kind: 'refuse', cost, reason: 'broke' };
}
