import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { App } from './App';
import { useAuthStore } from './auth/authStore';
import { loadToken, saveToken } from './auth/tokenStorage';
import { apiGetMe } from './auth/authApi';

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

  // Google OAuth callback delivers token via ?token= query param.
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get('token');
  if (urlToken) {
    saveToken(urlToken);
    urlParams.delete('token');
    const newSearch = urlParams.toString();
    history.replaceState(null, '', window.location.pathname + (newSearch ? `?${newSearch}` : ''));
  }

  const token = urlToken ?? loadToken();
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
