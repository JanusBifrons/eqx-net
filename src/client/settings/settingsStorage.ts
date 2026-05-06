import { oneShotMigrateLegacy, saveJSON, type UserId } from './userPrefs.js';

const LEGACY_KEY = 'eqxSettings';
const BASE = 'eqxSettings';

export interface PersistedSettings {
  showDevOverlay: boolean;
  showLogPanel: boolean;
  showServerGhost: boolean;
}

function decode(parsed: unknown): Partial<PersistedSettings> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const out: Partial<PersistedSettings> = {};
  if (typeof obj['showDevOverlay']  === 'boolean') out.showDevOverlay  = obj['showDevOverlay'];
  if (typeof obj['showLogPanel']    === 'boolean') out.showLogPanel    = obj['showLogPanel'];
  if (typeof obj['showServerGhost'] === 'boolean') out.showServerGhost = obj['showServerGhost'];
  return out;
}

/**
 * Load persisted settings for the given authenticated user (or `null` for
 * the anonymous / logged-out slot).
 *
 * Performs a one-shot, read-only migration of the legacy global `eqxSettings`
 * key into the per-user slot the first time a given user reads. The legacy
 * key is never deleted, so older tabs survive the rollout — see
 * [userPrefs.ts](./userPrefs.ts) for rationale.
 */
export function loadSettings(userId: UserId): Partial<PersistedSettings> {
  return oneShotMigrateLegacy(LEGACY_KEY, BASE, userId, decode) ?? {};
}

export function saveSettings(userId: UserId, settings: PersistedSettings): void {
  saveJSON(BASE, userId, settings);
}
