/**
 * Generic per-authenticated-user `localStorage` helper.
 *
 * Convention: every persisted preference is keyed `${baseKey}:${userId ?? 'anon'}`.
 * Anonymous / logged-out users get the `:anon` slot, so prefs survive a logout
 * and reappear if you log back in to the same account.
 *
 * Why per-user keying: a single browser is often shared between accounts (the
 * dev's own + a test account) and prefs that "leak" across accounts are
 * confusing. Per-user keying scopes the preference to the identity that set
 * it.
 *
 * Migration helper: `oneShotMigrateLegacy(legacyKey, base, userId, decode)`
 * copies a single legacy global `localStorage` key into the per-user slot on
 * first read, ONLY if the per-user slot is empty. The legacy key is **read but
 * never deleted** so older tabs still using the unscoped key keep working
 * during the rollout. Idempotent: subsequent calls become no-ops once the
 * per-user key is populated.
 */

export type UserId = string | null;

const ANON = 'anon';

export function userKey(base: string, userId: UserId): string {
  return `${base}:${userId ?? ANON}`;
}

/**
 * Load and JSON-parse a per-user pref. Returns `null` on missing or
 * unparseable storage; callers should fall back to a default. Quota / private-
 * mode failures are swallowed to keep the boot path robust.
 */
export function loadJSON<T>(base: string, userId: UserId, validate: (v: unknown) => T | null): T | null {
  try {
    const raw = localStorage.getItem(userKey(base, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return validate(parsed);
  } catch {
    return null;
  }
}

export function saveJSON(base: string, userId: UserId, value: unknown): void {
  try {
    localStorage.setItem(userKey(base, userId), JSON.stringify(value));
  } catch {
    // localStorage can throw in private mode / quota-exceeded — ignore.
  }
}

/**
 * One-shot legacy → per-user migration. If the per-user key is empty AND the
 * legacy global key has a payload that decodes successfully, copy it into the
 * per-user slot. Returns the decoded payload (or `null` if neither slot had
 * usable data).
 *
 * **Read-only on the legacy key.** We never delete it, so a stale tab from
 * before the migration keeps reading its own state and a fresh tab keeps
 * writing to the per-user slot. They diverge from this point — that's fine,
 * the legacy key is dead-on-arrival once every tab has reloaded.
 */
export function oneShotMigrateLegacy<T>(
  legacyKey: string,
  base: string,
  userId: UserId,
  validate: (v: unknown) => T | null,
): T | null {
  // If per-user slot already has data, prefer it. (Idempotent migration.)
  const existing = loadJSON<T>(base, userId, validate);
  if (existing !== null) return existing;

  let legacy: T | null = null;
  try {
    const raw = localStorage.getItem(legacyKey);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      legacy = validate(parsed);
    }
  } catch {
    // ignored — treat as missing
  }
  if (legacy !== null) {
    saveJSON(base, userId, legacy);
  }
  return legacy;
}
