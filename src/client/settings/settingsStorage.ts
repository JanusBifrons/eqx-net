import { oneShotMigrateLegacy, saveJSON, type UserId } from './userPrefs.js';

const LEGACY_KEY = 'eqxSettings';
const BASE = 'eqxSettings';

/** Mode picker for hyperspace arrival position (mobile UI). See
 *  `docs/features/configurable-arrival.md`. */
export type ArrivalMode = 'xy' | 'same' | 'home';

export interface PersistedSettings {
  showDevOverlay: boolean;
  showLogPanel: boolean;
  showServerGhost: boolean;
  /** Hyperspace arrival mode (mobile-only UI; PC ignores). */
  arrivalMode: ArrivalMode;
  /** User-typed arrival x in `xy` mode. Clamped to sector bounds on blur. */
  arrivalTargetX: number;
  /** User-typed arrival y in `xy` mode. Clamped to sector bounds on blur. */
  arrivalTargetY: number;
  /** "Home" coordinate — currently hardcoded to 0,0 by the UI but persisted
   *  per-user so a future feature can let the player set it. */
  homePosX: number;
  homePosY: number;
}

function isArrivalMode(v: unknown): v is ArrivalMode {
  return v === 'xy' || v === 'same' || v === 'home';
}

function decode(parsed: unknown): Partial<PersistedSettings> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const out: Partial<PersistedSettings> = {};
  if (typeof obj['showDevOverlay']  === 'boolean') out.showDevOverlay  = obj['showDevOverlay'];
  if (typeof obj['showLogPanel']    === 'boolean') out.showLogPanel    = obj['showLogPanel'];
  if (typeof obj['showServerGhost'] === 'boolean') out.showServerGhost = obj['showServerGhost'];
  if (isArrivalMode(obj['arrivalMode']))           out.arrivalMode     = obj['arrivalMode'];
  if (typeof obj['arrivalTargetX']  === 'number' && Number.isFinite(obj['arrivalTargetX'])) {
    out.arrivalTargetX = obj['arrivalTargetX'];
  }
  if (typeof obj['arrivalTargetY']  === 'number' && Number.isFinite(obj['arrivalTargetY'])) {
    out.arrivalTargetY = obj['arrivalTargetY'];
  }
  if (typeof obj['homePosX']        === 'number' && Number.isFinite(obj['homePosX'])) {
    out.homePosX = obj['homePosX'];
  }
  if (typeof obj['homePosY']        === 'number' && Number.isFinite(obj['homePosY'])) {
    out.homePosY = obj['homePosY'];
  }
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
