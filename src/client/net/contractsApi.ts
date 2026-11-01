/**
 * Contracts HTTP read (Living World P4c). zod-validated (invariant #3): a
 * malformed or failed response yields null, never a crash or a fake board.
 */
import { ContractsResponseSchema, type Contract } from '../../shared-types/contracts.js';

export async function fetchContracts(): Promise<Contract[] | null> {
  try {
    const res = await fetch('/galaxy/contracts');
    if (!res.ok) return null;
    const parsed = ContractsResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.contracts : null;
  } catch {
    return null;
  }
}

/** "4:05" — time left until `endsAtMs` (never negative). */
export function formatTimeLeft(endsAtMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((endsAtMs - nowMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The reward line: "300¢ bounty" or "Loot". */
export function formatReward(c: Pick<Contract, 'rewardCredits'>): string {
  return c.rewardCredits !== null ? `${c.rewardCredits.toLocaleString('en-US')}¢ bounty` : 'Loot';
}
