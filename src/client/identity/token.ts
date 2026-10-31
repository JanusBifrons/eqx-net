/**
 * Player identity storage.
 *
 * PR 3a (account-bound identity) — there are now TWO ids:
 *  - `eqxPlayerId`        — this BROWSER's anonymous identity (logged-out play).
 *  - `eqxAccountPlayerId` — the logged-in ACCOUNT's canonical playerId, as
 *    reported by the server (auth responses + the room `welcome`). It is the
 *    owner of the account's ships / structures on every device.
 *
 * `loadStoredPlayerId()` returns the account id while logged in, else the
 * anonymous one — so every consumer (room join, roster poll, galaxy presence)
 * automatically uses the right identity. Logging out clears the account id,
 * so a logged-out browser never claims the account's identity (the server
 * also refuses that claim).
 */
import { loadToken } from '../auth/tokenStorage.js';

const ANON_KEY = 'eqxPlayerId';
const ACCOUNT_KEY = 'eqxAccountPlayerId';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function read(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    return v && UUID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function write(key: string, id: string): void {
  try {
    localStorage.setItem(key, id);
  } catch {
    // storage quota exceeded — carry on
  }
}

function isLoggedIn(): boolean {
  try {
    return loadToken() !== null;
  } catch {
    return false;
  }
}

export function loadStoredPlayerId(): string | null {
  if (isLoggedIn()) {
    const account = read(ACCOUNT_KEY);
    if (account !== null) return account;
  }
  return read(ANON_KEY);
}

/** Persist the id the server assigned on join (`welcome.playerId`). While
 *  logged in that is the account's canonical id; otherwise the browser's
 *  anonymous id. */
export function persistPlayerId(id: string): void {
  write(isLoggedIn() ? ACCOUNT_KEY : ANON_KEY, id);
}

/** Record the account's canonical playerId from an auth response. A missing /
 *  null id (account not yet bound) leaves any stored value untouched — the
 *  first logged-in join binds it and `persistPlayerId` stores the result. */
export function setAccountPlayerId(id: string | null | undefined): void {
  if (typeof id === 'string' && UUID_RE.test(id)) write(ACCOUNT_KEY, id);
}

/** Logout — forget the account identity on this browser. */
export function clearAccountPlayerId(): void {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // ignore
  }
}
