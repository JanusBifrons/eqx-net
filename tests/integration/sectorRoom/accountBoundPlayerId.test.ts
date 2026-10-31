/**
 * PR 3a (plan sparkling-wondering-rose) — the in-game playerId belongs to the
 * ACCOUNT, not the browser.
 *
 * User report (2026-10-31): "we have accounts and logins … that's not linked
 * to ships??" Ships, structures and lingering hulls are keyed by `playerId`,
 * and `playerId` was a random per-browser UUID the client claimed on join —
 * so logging into the same account on another device/browser joined as a
 * DIFFERENT player and found none of the account's ships.
 *
 * These cases drive the real join path over a real WebSocket:
 *  1. same account, two different browser ids → the SAME playerId;
 *  2. a logged-out join may NOT claim an account's playerId;
 *  3. a second logged-in session TAKES OVER the first (`session_replaced`)
 *     instead of becoming a stranger;
 *  4. a server-issued transit token lets a logged-in player's id cross into
 *     the destination room (the seat reservation carries no auth token).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { signToken } from '../../../src/server/auth/jwt.js';
import {
  AccountPlayerRegistry,
  setAccountPlayerRegistry,
} from '../../../src/server/identity/AccountPlayerRegistry.js';
import { _clearPlayerSessions } from '../../../src/server/identity/PlayerSessionRegistry.js';
import {
  _clearTransitIdentities,
  issueTransitIdentity,
} from '../../../src/server/identity/TransitIdentityTokens.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

interface Internals { _internals: { sessionToPlayer: ReadonlyMap<string, string> } }

function boundPlayerId(h: SectorTestHarness, room: ClientRoom<SectorState>): string | undefined {
  const server = h.getServerRoom() as unknown as Internals | null;
  return server?._internals.sessionToPlayer.get(room.sessionId);
}

describe('account-bound playerId (PR 3a)', () => {
  let h: SectorTestHarness;

  beforeEach(async () => {
    setAccountPlayerRegistry(new AccountPlayerRegistry());
    _clearPlayerSessions();
    _clearTransitIdentities();
    h = await bootSectorTestServer();
    // Anonymous anchor session: an engineering room auto-disposes when its
    // last client leaves, and the harness caches the FIRST room instance —
    // keep one bystander connected so every case's disconnect→rejoin lands
    // in the same room.
    await h.connectAs(randomUUID());
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('the same account on two different browsers joins as the SAME player', async () => {
    const token = await signToken(`user-${randomUUID()}`);
    const browserA = randomUUID();
    const browserB = randomUUID();

    const first = await h.connectAs(browserA, { authToken: token });
    const firstId = boundPlayerId(h, first);
    expect(firstId).toBe(browserA); // first login adopts this browser's id
    await h.disconnectClient(first);
    await h.advance(150);

    const second = await h.connectAs(browserB, { authToken: token });
    // The fix: the second browser's claim is ignored; the account's id wins.
    expect(boundPlayerId(h, second)).toBe(firstId);
  });

  it('a logged-out join cannot claim an account-bound playerId', async () => {
    const token = await signToken(`user-${randomUUID()}`);
    const accountBrowser = randomUUID();
    const owner = await h.connectAs(accountBrowser, { authToken: token });
    const accountId = boundPlayerId(h, owner);
    await h.disconnectClient(owner);
    await h.advance(150);

    const intruder = await h.connectAs(accountId!); // no authToken
    const intruderId = boundPlayerId(h, intruder);
    expect(intruderId).toBeDefined();
    expect(intruderId).not.toBe(accountId);
  });

  it('a second logged-in session takes over the first (session_replaced)', async () => {
    const token = await signToken(`user-${randomUUID()}`);
    const first = await h.connectAs(randomUUID(), { authToken: token });
    const accountId = boundPlayerId(h, first);
    let replaced = false;
    first.onMessage('session_replaced', () => { replaced = true; });

    const second = await h.connectAs(randomUUID(), { authToken: token });
    expect(boundPlayerId(h, second)).toBe(accountId);
    // The old session was told why and disconnected.
    await h.advance(100);
    expect(replaced).toBe(true);
    const server = h.getServerRoom() as unknown as Internals;
    expect(server._internals.sessionToPlayer.has(first.sessionId)).toBe(false);
  });

  it('a server-issued transit token carries an account id across rooms', async () => {
    const token = await signToken(`user-${randomUUID()}`);
    const owner = await h.connectAs(randomUUID(), { authToken: token });
    const accountId = boundPlayerId(h, owner)!;
    await h.disconnectClient(owner);
    await h.advance(150);

    // What TransitOrchestrator.commitTransit does before reserveSeatFor.
    const transitToken = randomUUID();
    issueTransitIdentity(transitToken, accountId);
    const arrived = await h.connectAs(accountId, { transitToken });
    expect(boundPlayerId(h, arrived)).toBe(accountId);

    // The token is single-use: replaying it no longer grants the identity.
    await h.disconnectClient(arrived);
    await h.advance(150);
    const replay = await h.connectAs(accountId, { transitToken });
    expect(boundPlayerId(h, replay)).not.toBe(accountId);
  });
});
