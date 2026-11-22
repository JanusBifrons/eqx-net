import type { ReactNode } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
// HUD fonts, self-hosted so they work offline / on LAN.
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import { eqxTheme } from '../theme.js';

export interface EqxThemeProviderProps {
  children: ReactNode;
}

/**
 * The EQX look for a React tree: the MUI theme, CssBaseline and the HUD fonts.
 * Mounted once at the app root (main.tsx) and around every Storybook story.
 */
export function EqxThemeProvider({ children }: EqxThemeProviderProps) {
  return (
    <ThemeProvider theme={eqxTheme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
