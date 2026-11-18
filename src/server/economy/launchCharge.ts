/**
 * Join flow — paying for a launch. The ONE place the server applies the shared
 * `launchVerdict` (shared-types/launch.ts): the join hull gate and respawn both
 * call it, so the Hangar's prices and the server never disagree.
 *
 * pay   → debit the wallet;
 * token → spend one free capital launch;
 * debt  → debit below zero, down to `DEBT_FLOOR`;
 * free / owned → nothing; refuse → nothing (the caller downgrades or refuses).
 * Every charge is a `launch_charged` audit event.
 */
import { DEBT_FLOOR, launchVerdict, type LaunchVerdict } from '../../shared-types/launch.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import type { Wallet } from './Wallet.js';

export interface LaunchChargeDeps {
  wallet: Pick<Wallet, 'balance' | 'debit' | 'debitAllowingDebt'>;
  /** Free launches left (0 when there is no economy store). */
  freeLaunches: (playerId: string) => number;
  spendFreeLaunch: (playerId: string) => boolean;
  /** Defaults to `LAUNCH_COSTS_ON`; tests pass it. */
  costsOn?: boolean;
}

export function chargeLaunch(deps: LaunchChargeDeps, playerId: string, kind: string, ownedHere = false): LaunchVerdict {
  const verdict = launchVerdict({
    kind,
    wallet: deps.wallet.balance(playerId),
    freeLaunches: deps.freeLaunches(playerId),
    ownedHere,
    costsOn: deps.costsOn,
  });
  let paid = true;
  if (verdict.kind === 'pay') paid = deps.wallet.debit(playerId, verdict.cost, 'launch');
  else if (verdict.kind === 'token') paid = deps.spendFreeLaunch(playerId);
  else if (verdict.kind === 'debt') paid = deps.wallet.debitAllowingDebt(playerId, verdict.cost, DEBT_FLOOR, 'launch_debt');
  else return verdict;
  // A charge that didn't go through (a race between the verdict and the
  // debit) is a refusal: never launch an unpaid capital.
  if (!paid) return { kind: 'refuse', cost: verdict.cost, reason: 'broke' };
  auditEvent({ event: 'launch_charged', playerId, kind, how: verdict.kind, cost: verdict.cost });
  return verdict;
}
