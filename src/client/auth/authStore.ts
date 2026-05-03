import { create } from 'zustand';
import type { AuthUser } from '../../shared-types/auth.js';
import { saveToken, clearToken } from './tokenStorage.js';

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
    set({ token, user });
  },
  clearAuth: () => {
    clearToken();
    set({ token: null, user: null });
  },
}));
