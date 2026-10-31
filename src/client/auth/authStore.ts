import { create } from 'zustand';
import type { AuthUser } from '../../shared-types/auth.js';
import { saveToken, clearToken } from './tokenStorage.js';
import { saveEmail, clearEmail } from './emailStorage.js';
import { setAccountPlayerId, clearAccountPlayerId } from '../identity/token.js';

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  setAuth: (token: string, user: AuthUser) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  setAuth: (token, user) => {
    saveToken(token);
    // Persist the email so the boot-time account-gated autocapture decision
    // (debug/ClientLogger isAutoCaptureEnabled) can read a durable identity
    // before auth resolves. See auth/emailStorage.ts.
    saveEmail(user.email);
    // PR 3a — the account's canonical playerId (owner of its ships on every
    // device). Untouched when the server reports none yet.
    setAccountPlayerId(user.playerId);
    set({ token, user });
  },
  clearAuth: () => {
    clearToken();
    clearEmail();
    clearAccountPlayerId();
    set({ token: null, user: null });
  },
}));
