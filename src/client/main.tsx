import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { App } from './App';

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

const root = document.getElementById('root');
if (!root) throw new Error('No #root element found');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
