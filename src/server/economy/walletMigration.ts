/**
 * Economy v2 W1 — the one-time boot migration of PRE-wallet hold credits.
 *
 * Credits used to live in holds. On boot each legacy amount moves into its
 * OWNER's wallet (an ownerless pod's credits simply vanish) and the row is
 * rewritten without it — ONE atomic group per row, so a crash leaves either
 * the old row (migrated again next boot) or the new row + the wallet credit,
 * never both. A pre-wallet BOUNTY escrow row is refunded to its placer and
 * removed (bounties are records now). Pure over injected stores (testable).
 */
import type { HoldStore } from '../cargo/HoldStore.js';
import type { Wallet } from './Wallet.js';

export interface LegacyCredit {
  uid: string;
  owner: string | null;
  credits: number;
}

export function migrateLegacyCredits(
  holds: HoldStore,
  wallet: Pick<Wallet, 'creditDeferred'>,
  legacy: LegacyCredit[],
  canonical: (playerId: string) => string = (p) => p,
): { rows: number; credited: number } {
  let credited = 0;
  for (const l of legacy) {
    const rec = holds.get(l.uid);
    if (rec === undefined) continue;
    const op = l.owner !== null ? wallet.creditDeferred(canonical(l.owner), l.credits, 'credits_migration') : null;
    if (op !== null) credited += l.credits;
    if (rec.holderType === 'bounty') holds.commit([], [l.uid], true, op ? [op] : []);
    else holds.commit([rec], [], true, op ? [op] : []);
  }
  const rows = legacy.length;
  legacy.length = 0; // consumed — a second run moves nothing
  return { rows, credited };
}
