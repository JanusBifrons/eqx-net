import { create } from 'zustand';
import type { AuthUser } from '../../shared-types/auth.js';
import { saveToken, clearToken } from './tokenStorage.js';
import { saveEmail, clearEmail } from './emailStorage.js';
import { setAccountPlayerId, clearAccountPlayerId } from '../identity/token.js';

// "Continue as guest" is remembered per browser, so the landing map does
// not send a guest back to the login page on every sector pick
// (smoke-test bug 2026-11-05). Storage can throw (private mode): fall back
// to in-memory.
const GUEST_KEY = 'eqxGuest';
function readGuest(): boolean {
  try { return globalThis.localStorage?.getItem(GUEST_KEY) === '1'; } catch { return false; }
}
function writeGuest(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(GUEST_KEY, '1');
    else globalThis.localStorage?.removeItem(GUEST_KEY);
  } catch { /* in-memory only */ }
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  /** The pilot chose "Continue as guest" (and has not logged in since). */
  guest: boolean;
  setAuth: (token: string, user: AuthUser) => void;
  clearAuth: () => void;
  continueAsGuest: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  guest: readGuest(),
  setAuth: (token, user) => {
    saveToken(token);
    // Persist the email so the boot-time account-gated autocapture decision
    // (debug/ClientLogger isAutoCaptureEnabled) can read a durable identity
    // before auth resolves. See auth/emailStorage.ts.
    saveEmail(user.email);
    // PR 3a — the account's canonical playerId (owner of its ships on every
    // device). Untouched when the server reports none yet.
    setAccountPlayerId(user.playerId);
    writeGuest(false);
    set({ token, user, guest: false });
  },
  clearAuth: () => {
    clearToken();
    clearEmail();
    clearAccountPlayerId();
    writeGuest(false);
    set({ token: null, user: null, guest: false });
  },
  continueAsGuest: () => {
    writeGuest(true);
    set({ guest: true });
  },
}));
