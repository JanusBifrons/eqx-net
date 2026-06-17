/**
 * PushNotifier — turns a gameplay event ("your base is under attack") into Web
 * Push notifications to the OWNER's offline devices.
 *
 * The trigger lives in `SectorRoom.applyDamage` (co-located with the existing
 * throttled `structure_attacked` audit), but ALL the work here is async and
 * off the physics tick: `onStructureAttacked` takes scalars, returns
 * immediately, and never throws into the caller (invariant #14). The heavy
 * lifting (presence gate → playerId→userId map → subscription read → network
 * send → prune-dead) runs on a detached promise.
 *
 * Dependencies are injected so the offline-gate / map / prune logic is unit-
 * testable without a DB or a real push service; the exported singleton wires
 * the real concretions. See docs/architecture/web-push.md.
 */
import { isPlayerOnline } from './connectedPlayers.js';
import {
  getSubscriptionsForUser,
  getUserIdForPlayer,
  deleteSubscriptionByEndpoint,
} from './pushSubscriptions.js';
import { sendWebPush, pushEnabled, type PushTarget, type SendResult } from './webPush.js';

export interface PushNotifierDeps {
  enabled: boolean;
  isOnline(playerId: string): boolean;
  userIdForPlayer(playerId: string): string | null;
  subscriptionsForUser(userId: string): PushTarget[];
  deleteSubscription(endpoint: string): void;
  send(target: PushTarget, payloadJson: string): Promise<SendResult>;
}

export class PushNotifier {
  constructor(private readonly deps: PushNotifierDeps) {}

  /**
   * Fire-and-forget "your base is under attack". Scalars only (no per-call
   * object allocation on the SectorRoom hot path). Returns synchronously; the
   * dispatch runs detached and swallows its own errors.
   */
  onStructureAttacked(
    ownerPlayerId: string,
    kind: string,
    attackerKind: string | undefined,
    sector: string | undefined,
  ): void {
    if (!this.deps.enabled) return;
    void this.dispatchStructureAttacked(ownerPlayerId, kind, attackerKind, sector).catch(() => {
      /* never throw into the tick */
    });
  }

  private async dispatchStructureAttacked(
    ownerPlayerId: string,
    kind: string,
    attackerKind: string | undefined,
    sector: string | undefined,
  ): Promise<void> {
    // Only notify an OFFLINE owner — a connected player can already see it.
    if (this.deps.isOnline(ownerPlayerId)) return;
    const userId = this.deps.userIdForPlayer(ownerPlayerId);
    if (!userId) return; // orphan / scenario owner with no account
    const subs = this.deps.subscriptionsForUser(userId);
    if (subs.length === 0) return;

    const payload = JSON.stringify({
      type: 'structure_attacked',
      title: 'Base under attack',
      body: sector ? `Your ${kind} is under attack in ${sector}.` : `Your ${kind} is under attack.`,
      tag: `base-attack:${sector ?? 'sector'}`,
      kind,
      attackerKind,
      sector,
    });

    await Promise.allSettled(
      subs.map(async (target) => {
        const res = await this.deps.send(target, payload);
        if (res.gone) this.deps.deleteSubscription(target.endpoint);
      }),
    );
  }
}

/** Process-global notifier wired to the real DB + web-push transport. */
export const pushNotifier = new PushNotifier({
  enabled: pushEnabled,
  isOnline: isPlayerOnline,
  userIdForPlayer: getUserIdForPlayer,
  subscriptionsForUser: getSubscriptionsForUser,
  deleteSubscription: deleteSubscriptionByEndpoint,
  send: sendWebPush,
});
