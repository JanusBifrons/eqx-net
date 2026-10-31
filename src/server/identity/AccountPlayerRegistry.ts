/**
 * Account-bound player identity (PR 3a, plan sparkling-wondering-rose).
 *
 * Before this module, a player's in-game identity (`playerId`) was a random
 * UUID minted per BROWSER and kept in localStorage. Logging into the same
 * account on a new device produced a brand-new playerId, so the account's
 * ships, structures and lingering hulls — all keyed by playerId — were not
 * found. `player_ships.user_id` was written but never read.
 *
 * This registry makes the playerId a property of the ACCOUNT:
 *  - every account has exactly ONE canonical playerId (`account_players`);
 *  - historical per-browser ids that belonged to the same account are
 *    recorded as ALIASES of the canonical id (`player_aliases`), so data
 *    persisted under an old id (sector-snapshot structure owners, lingering
 *    hulls, director wave targets) resolves to the canonical id on load;
 *  - an authenticated join is ALWAYS bound to the canonical id (the id the
 *    client claims is ignored once the account is bound);
 *  - an UNauthenticated join may never claim an id that belongs to an
 *    account (that would let a logged-out browser pilot the account's ships).
 *
 * In-memory hot path + CRITICAL-lane write-through, the `PlayerShipStore`
 * pattern: reads never touch SQLite, so a bind is immediately visible.
 */
import { randomUUID } from 'node:crypto';
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';
import { isValidUUID } from './PlayerIdentity.js';

export interface AccountPlayerBinding {
  userId: string;
  playerId: string;
}

export interface PlayerAlias {
  aliasPlayerId: string;
  canonicalPlayerId: string;
  userId: string;
}

export interface AccountPlayerRegistryOpts {
  persistence?: IPersistenceSink;
  /** UUID generator override for tests. */
  generateId?: () => string;
  now?: () => number;
}

export class AccountPlayerRegistry {
  private readonly playerByUser = new Map<string, string>();
  private readonly userByPlayer = new Map<string, string>();
  private readonly canonicalByAlias = new Map<string, string>();
  /** Test-FIXTURE accounts (provider `e2e`, minted by the dev-only
   *  `/auth/dev/test-token`). One shared fixture login stands in for MANY
   *  independent players across the parallel E2E suite + the netgate, so it
   *  must keep the legacy per-browser identity — binding it would make every
   *  concurrent test the same player (and take each other's sessions over). */
  private readonly exemptUsers = new Set<string>();
  private persistence: IPersistenceSink | undefined;
  private readonly generateId: () => string;
  private readonly nowFn: () => number;

  constructor(opts: AccountPlayerRegistryOpts = {}) {
    this.persistence = opts.persistence;
    this.generateId = opts.generateId ?? randomUUID;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /** Boot hydrate from disk rows. Pure in-memory; does NOT write through. */
  hydrate(
    bindings: readonly AccountPlayerBinding[],
    aliases: readonly PlayerAlias[],
    exemptUserIds: readonly string[] = [],
  ): void {
    for (const u of exemptUserIds) this.exemptUsers.add(u);
    for (const b of bindings) {
      this.playerByUser.set(b.userId, b.playerId);
      this.userByPlayer.set(b.playerId, b.userId);
    }
    for (const a of aliases) {
      this.canonicalByAlias.set(a.aliasPlayerId, a.canonicalPlayerId);
    }
  }

  /** Boot wiring — attach the write-through sink to the process singleton
   *  (which may already have been touched by an early HTTP request, since the
   *  server listens before the registry hydrates). */
  attachPersistence(sink: IPersistenceSink): void {
    this.persistence = sink;
  }

  /** Mark a test-fixture account as exempt from binding (see `exemptUsers`). */
  markExempt(userId: string): void {
    this.exemptUsers.add(userId);
  }

  /** True for a test-fixture account that keeps per-browser identities. */
  isExempt(userId: string): boolean {
    return this.exemptUsers.has(userId);
  }

  /** The account's canonical playerId, or null when the account has never
   *  been bound (no logged-in join yet, no ships to merge). */
  canonicalForUser(userId: string): string | null {
    return this.playerByUser.get(userId) ?? null;
  }

  /** The account a canonical playerId belongs to (null for anonymous ids). */
  userForPlayer(playerId: string): string | null {
    const canonical = this.resolve(playerId);
    return this.userByPlayer.get(canonical) ?? null;
  }

  /** Map a possibly-historical playerId to the canonical one. Identity for
   *  anything that is not a recorded alias. Used wherever a persisted
   *  playerId is loaded back into the world. */
  resolve(playerId: string): string {
    return this.canonicalByAlias.get(playerId) ?? playerId;
  }

  /** True when `playerId` belongs to an account (canonical OR alias). An
   *  unauthenticated join must never be allowed to claim such an id. */
  isAccountBound(playerId: string): boolean {
    return this.userByPlayer.has(playerId) || this.canonicalByAlias.has(playerId);
  }

  /**
   * Resolve the playerId for an AUTHENTICATED join / login.
   *
   * - Account already bound → its canonical id (the claim is ignored).
   * - Unbound account → adopt the browser's claimed id IF it is a valid UUID
   *   that no other account owns (so a first login keeps whatever this browser
   *   was already playing as — no visible change for the player), else mint a
   *   fresh id. Either way the binding is persisted.
   */
  resolveForUser(userId: string, claimedId: unknown): string {
    const existing = this.playerByUser.get(userId);
    if (existing !== undefined) return existing;
    const adopt = isValidUUID(claimedId) && !this.isAccountBound(claimedId);
    const playerId = adopt ? claimedId : this.generateId();
    this.bind(userId, playerId);
    return playerId;
  }

  /** Persist a canonical binding. Idempotent for the same pair. */
  bind(userId: string, playerId: string): void {
    if (this.playerByUser.get(userId) === playerId) return;
    this.playerByUser.set(userId, playerId);
    this.userByPlayer.set(playerId, userId);
    this.persistence?.enqueueCritical({
      type: 'ACCOUNT_PLAYER_PUT',
      userId,
      playerId,
      ts: this.nowFn(),
    });
  }

  /** Record `aliasPlayerId` as a historical id of `canonicalPlayerId`.
   *  Idempotent. A canonical id is never turned into an alias of itself. */
  addAlias(aliasPlayerId: string, canonicalPlayerId: string, userId: string): void {
    if (aliasPlayerId === canonicalPlayerId) return;
    if (this.canonicalByAlias.get(aliasPlayerId) === canonicalPlayerId) return;
    this.canonicalByAlias.set(aliasPlayerId, canonicalPlayerId);
    this.persistence?.enqueueCritical({
      type: 'PLAYER_ALIAS_PUT',
      aliasPlayerId,
      canonicalPlayerId,
      userId,
      ts: this.nowFn(),
    });
  }

  aliasCount(): number {
    return this.canonicalByAlias.size;
  }

  bindingCount(): number {
    return this.playerByUser.size;
  }
}

// ── Process-global singleton (the getPlayerShipStore pattern) ──────────────

let _registry: AccountPlayerRegistry | null = null;

export function getAccountPlayerRegistry(): AccountPlayerRegistry {
  if (_registry === null) _registry = new AccountPlayerRegistry();
  return _registry;
}

/** Test / boot seam — replace the registry (e.g. with one wired to the real
 *  persistence sink). */
export function setAccountPlayerRegistry(registry: AccountPlayerRegistry): void {
  _registry = registry;
}

/** Canonical form of a persisted playerId — safe to call before boot
 *  hydration (identity until aliases are loaded). */
export function canonicalPlayerId(playerId: string): string {
  return getAccountPlayerRegistry().resolve(playerId);
}
