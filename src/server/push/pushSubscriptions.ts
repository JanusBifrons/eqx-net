/**
 * Push-subscription data access. Writes go through the persistence worker (sole
 * SQLite writer); reads use the read-only main-thread connection (`db`), the
 * same split as auth + roster. See src/server/db/.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db/Database.js';
import { persistence } from '../db/PersistenceWorker.js';
import type { PushTarget } from './webPush.js';

/** UPSERT a subscription (keyed on the unique endpoint via the worker stmt). */
export function putSubscription(
  userId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): void {
  persistence.enqueueCritical({
    type: 'PUSH_SUBSCRIPTION_PUT',
    subscriptionId: randomUUID(),
    userId,
    endpoint,
    p256dh,
    auth,
    ts: Date.now(),
  });
}

/** Prune a subscription by endpoint (unsubscribe, or a gone 404/410 endpoint). */
export function deleteSubscriptionByEndpoint(endpoint: string): void {
  persistence.enqueueCritical({ type: 'PUSH_SUBSCRIPTION_DELETE', endpoint, ts: Date.now() });
}

/** Every push target registered for a user (phone + desktop, etc). */
export function getSubscriptionsForUser(userId: string): PushTarget[] {
  return db
    .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .all(userId) as unknown as PushTarget[];
}

/** Resolve a structure-owner `playerId` to its account `userId` (or null for an
 *  orphan / scenario owner with no account). A player's ships all share one
 *  user_id, so the first non-null row is sufficient. */
export function getUserIdForPlayer(playerId: string): string | null {
  const row = db
    .prepare('SELECT user_id FROM player_ships WHERE player_id = ? AND user_id IS NOT NULL LIMIT 1')
    .get(playerId) as { user_id: string | null } | undefined;
  return row?.user_id ?? null;
}
