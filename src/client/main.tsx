import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { App } from './App';
import { useAuthStore } from './auth/authStore';
import { useUIStore } from './state/store';
import { loadToken, saveToken } from './auth/tokenStorage';
import { apiGetMe, exchangeAuthCode } from './auth/authApi';

// Expose the Zustand store on window for E2E tests + interactive
// debugging. Read-only by convention (tests use `getState()` to read +
// the explicit setters to write); not used by production code.
if (typeof window !== 'undefined') {
  (window as unknown as { __eqxStore?: typeof useUIStore }).__eqxStore = useUIStore;
}

// Plan: crispy-kazoo Commit 1 — pre-rollout safety net for the
// loaded-then-visible spawn handshake. `?loading=cosmetic` restores
// legacy "no pause boundary" behaviour: the curtain renders
// cosmetically, but `computeIsLoadingActive` returns false so input,
// audio, and the RAF game-work keep running. Set ONCE at boot — the
// flag is intentionally not reactive.
if (typeof window !== 'undefined') {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('loading') === 'cosmetic') {
      useUIStore.getState().setLoadingCosmeticOnly(true);
      // eslint-disable-next-line no-console
      console.warn('[loading-kill-switch] ?loading=cosmetic active — curtain is cosmetic only, no pause boundary');
    }
  } catch {
    // URL parse should never throw; if it does, fall through to default false.
  }
}

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#00ff88' },
    background: { default: '#05070f', paper: '#0d1117' },
  },
  typography: {
    fontFamily: '"Inter", "Roboto Mono", monospace',
  },
});

// Bootstrap: restore session from localStorage or Google OAuth callback URL.
async function bootstrapAuth(): Promise<void> {
  const { setAuth } = useAuthStore.getState();

  // Google OAuth callback delivers a single-use code via ?authCode= (S3 — the
  // JWT is no longer placed in the URL). Swap it for the token over a POST.
  const urlParams = new URLSearchParams(window.location.search);
  const authCode = urlParams.get('authCode');
  let exchangedToken: string | null = null;
  if (authCode) {
    try {
      const { token: t } = await exchangeAuthCode(authCode);
      saveToken(t);
      exchangedToken = t;
    } catch {
      // Invalid / expired / replayed code — fall through to localStorage.
    }
    urlParams.delete('authCode');
    const newSearch = urlParams.toString();
    history.replaceState(null, '', window.location.pathname + (newSearch ? `?${newSearch}` : ''));
  }

  const token = exchangedToken ?? loadToken();
  if (!token) return;

  try {
    const { user } = await apiGetMe(token);
    setAuth(token, user);
  } catch {
    // Token expired or invalid — clear it silently.
    useAuthStore.getState().clearAuth();
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('No #root element found');

bootstrapAuth().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
});
