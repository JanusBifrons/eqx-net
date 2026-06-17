import { describe, it, expect, vi } from 'vitest';
import { PushNotifier, type PushNotifierDeps } from './PushNotifier.js';
import type { PushTarget, SendResult } from './webPush.js';

// The PushNotifier module constructs a singleton wired to the real DB +
// web-push concretions at import time; stub those so importing the CLASS
// doesn't pull `node:sqlite` (unresolvable under Vitest). The tests below
// construct their own PushNotifier with injected fakes — the singleton's deps
// are irrelevant to them. Mirrors authRouter.test.ts's service mocking.
vi.mock('./pushSubscriptions.js', () => ({
  getSubscriptionsForUser: () => [],
  getUserIdForPlayer: () => null,
  deleteSubscriptionByEndpoint: () => undefined,
}));
vi.mock('./webPush.js', () => ({
  pushEnabled: false,
  sendWebPush: async () => ({ ok: true, gone: false }),
}));
vi.mock('./connectedPlayers.js', () => ({ isPlayerOnline: () => false }));

const TWO_SUBS: PushTarget[] = [
  { endpoint: 'https://push/e1', p256dh: 'p', auth: 'a' },
  { endpoint: 'https://push/e2', p256dh: 'p', auth: 'a' },
];

function makeNotifier(overrides: Partial<PushNotifierDeps> = {}) {
  const sent: Array<{ endpoint: string; payload: string }> = [];
  const deleted: string[] = [];
  const deps: PushNotifierDeps = {
    enabled: true,
    isOnline: () => false,
    userIdForPlayer: () => 'u1',
    subscriptionsForUser: () => TWO_SUBS,
    deleteSubscription: (endpoint) => deleted.push(endpoint),
    send: async (t): Promise<SendResult> => {
      sent.push({ endpoint: t.endpoint, payload: '' });
      return { ok: true, gone: false };
    },
    ...overrides,
  };
  // Capture the payload via a wrapping send unless overridden.
  if (!overrides.send) {
    deps.send = async (t, payload): Promise<SendResult> => {
      sent.push({ endpoint: t.endpoint, payload });
      return { ok: true, gone: false };
    };
  }
  return { notifier: new PushNotifier(deps), sent, deleted };
}

/** Flush the detached dispatch promise (onStructureAttacked is fire-and-forget). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('PushNotifier.onStructureAttacked', () => {
  it('does nothing when push is disabled', async () => {
    const { notifier, sent } = makeNotifier({ enabled: false });
    notifier.onStructureAttacked('p1', 'capital', 'player', 'sol');
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('does NOT notify an owner who is currently online', async () => {
    const { notifier, sent } = makeNotifier({ isOnline: () => true });
    notifier.onStructureAttacked('p1', 'capital', 'player', 'sol');
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('does nothing when the owner maps to no account (orphan/scenario)', async () => {
    const { notifier, sent } = makeNotifier({ userIdForPlayer: () => null });
    notifier.onStructureAttacked('p1', 'capital', 'player', 'sol');
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('does nothing when the user has no subscriptions', async () => {
    const { notifier, sent } = makeNotifier({ subscriptionsForUser: () => [] });
    notifier.onStructureAttacked('p1', 'capital', 'player', 'sol');
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('sends to every subscription of an OFFLINE owner with a base-attack payload', async () => {
    const { notifier, sent } = makeNotifier();
    notifier.onStructureAttacked('p1', 'capital', 'player', 'sol-prime');
    await flush();
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push/e1', 'https://push/e2']);
    const payload = JSON.parse(sent[0]!.payload) as Record<string, unknown>;
    expect(payload['type']).toBe('structure_attacked');
    expect(payload['title']).toBe('Base under attack');
    expect(payload['body']).toContain('capital');
    expect(payload['body']).toContain('sol-prime');
  });

  it('prunes an endpoint the push service reports as gone (404/410)', async () => {
    const { notifier, deleted } = makeNotifier({
      send: async (t): Promise<SendResult> =>
        t.endpoint === 'https://push/e2' ? { ok: false, gone: true } : { ok: true, gone: false },
    });
    notifier.onStructureAttacked('p1', 'capital', 'drone', 'sol');
    await flush();
    expect(deleted).toEqual(['https://push/e2']);
  });
});
