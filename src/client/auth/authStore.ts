import { create } from 'zustand';
import type { AuthUser } from '../../shared-types/auth.js';
import { saveToken, clearToken } from './tokenStorage.js';
import { saveEmail, clearEmail } from './emailStorage.js';

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
    set({ token, user });
  },
  clearAuth: () => {
    clearToken();
    clearEmail();
    set({ token: null, user: null });
  },
}));
