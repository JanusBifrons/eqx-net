# Player identity — the playerId belongs to the account

> PR 3a of plan `sparkling-wondering-rose` (2026-10-31). Code:
> `src/server/identity/` (`AccountPlayerRegistry`, `accountPlayerMerge`,
> `TransitIdentityTokens`, `PlayerSessionRegistry`), the identity block at the
> top of `SectorRoom.onJoin`, and `src/client/identity/token.ts`.

## The problem

Everything a player owns in the world is keyed by **`playerId`**: roster ships
(`player_ships.player_id`), placed structures (`owner`), lingering hulls, the
faction a wave targets. But `playerId` was a random UUID minted **per browser**
and kept in `localStorage` (`eqxPlayerId`); the client claimed it on join and the
server trusted the claim.

Accounts existed (`users`, JWT login) and every ship created while logged in was
stamped with `player_ships.user_id` — but **nothing ever read `user_id`**. So
logging into the same account on a phone and a PC, or after clearing site data,
made you a different player with an empty roster; your ships and base were
still in the world, owned by an id that browser no longer had. Live data showed
exactly this: a real account with its ships split across two browser ids, and
the shared E2E fixture account spread over ~394 ids.

## The model

| Concept | Where | Meaning |
|---|---|---|
| canonical playerId | `account_players (user_id → player_id)` | The ONE in-game identity of an account. |
| alias | `player_aliases (alias → canonical)` | A historical per-browser id that belonged to the account. |
| anonymous playerId | browser `eqxPlayerId` | Logged-out play — unchanged. |

`AccountPlayerRegistry` is the in-memory hot path (hydrated at boot, CRITICAL-lane
write-through, the `PlayerShipStore` pattern).

### Join rules (`SectorRoom.onJoin`)

1. **Logged in** → `resolveForUser(userId, claimedId)`: the account's canonical
   id. The first logged-in join of an unbound account **adopts this browser's
   id** (no visible change for the player); after that the claim is ignored.
2. **Transit arrival** → the destination's seat reservation carries no auth
   token, so the source room issues a **single-use transit token**
   (`issueTransitIdentity`) at commit; the destination accepts the id only with
   that token (`consumeTransitIdentity`) and recovers the account from the registry.
3. **Anonymous** → may **not** claim an id that belongs to an account (canonical
   or alias) — it gets a fresh id. Without this, a logged-out browser that still
   had the id in storage could pilot the account's ships.
4. **Second session on the same account** (another device/tab) → **takeover**:
   `PlayerSessionRegistry` finds the session currently piloting the id (any room
   on this server), sends it `session_replaced`, disconnects it (close code
   4002) and waits for its `onLeave` (bounded 3 s); the new join then rebinds to
   the hull like an ordinary reconnect. Anonymous duplicates keep the legacy
   behaviour (a fresh id).

### Test-fixture accounts are exempt

The dev-only `/auth/dev/test-token` login (`auth_providers.provider = 'e2e'`) is
ONE shared login used by the whole parallel E2E suite and the netgate to stand in
for many independent players. Binding it would make every concurrent test the
same player and they would take each other's sessions over. Those accounts are
marked exempt (`AccountPlayerRegistry.isExempt`) and keep per-browser ids. Tests
that exercise binding register a REAL account (`/auth/register`) or sign a
token directly (integration).

### Boot merge (`mergeAccountPlayerIds`)

Runs once per boot, after the roster hydrates and before any sector room is
created. For each non-exempt account with roster rows: canonical = the existing
binding, else the playerId owning the most recently updated ship; every other id
becomes an alias and its ships are re-keyed (`PlayerShipStore.reassignPlayer`).
Idempotent. It never deletes ships, even when a merged roster exceeds the 10-ship
cap (the cap only gates new ships). Data inside JSON snapshot blobs (structure
owners, lingering hulls, director wave targets) is mapped through
`canonicalPlayerId()` when loaded and re-saved under the canonical id.

### Client

`src/client/identity/token.ts` keeps two keys: `eqxPlayerId` (anonymous) and
`eqxAccountPlayerId` (from auth responses' `user.playerId` and the room
`welcome`). `loadStoredPlayerId()` returns the account id while logged in, so the
join, the roster poll and galaxy presence all use the account identity with no
call-site changes. Logout clears the account key.

## Locks

- `tests/integration/sectorRoom/accountBoundPlayerId.test.ts` — same account /
  two browsers → same id; anonymous can't claim; takeover; transit token
  (all four fail with the old join logic).
- `tests/e2e/account-bound-identity.spec.ts` — two real browser profiles, one
  account: the second resumes the account's ship, nothing is created for its own id.
- `src/server/identity/accountIdentity.test.ts` — registry rules, merge
  (newest wins, idempotent, cross-account + exempt guards, no cap deletion),
  transit tokens.
- `src/client/identity/token.test.ts` — the two-key storage rules.

## Known follow-ups

- The roster endpoints (`/dev/player-ships`, abandon) still trust a `playerId`
  query/body parameter. They should take the auth token and derive the playerId
  server-side.
- Takeover is per-server-process (all rooms are in one process today).
