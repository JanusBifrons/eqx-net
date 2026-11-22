/**
 * The one MUI theme for EQX Peri, built only from `hud/tokens.ts`.
 * Every palette colour, the font and the slide motion come from `HUD`;
 * there are no literals here. `main.tsx` wraps the app in it.
 */
import { createTheme, type Theme } from '@mui/material';
import { HUD } from '../client/hud/tokens.js';

/** The palette fields the theme sets, each read from a token. */
export const THEME_PALETTE = {
  primary: HUD.color.brand,
  backgroundDefault: HUD.color.appBg,
  backgroundPaper: HUD.color.appPaper,
} as const;

export function buildEqxTheme(): Theme {
  return createTheme({
    palette: {
      mode: 'dark',
      primary: { main: THEME_PALETTE.primary },
      background: { default: THEME_PALETTE.backgroundDefault, paper: THEME_PALETTE.backgroundPaper },
    },
    typography: {
      // The HUD label font app-wide, so the drawer and dialogs match the HUD.
      fontFamily: HUD.font.label,
    },
    transitions: {
      duration: { enteringScreen: HUD.motion.slideInMs, leavingScreen: HUD.motion.slideOutMs },
      easing: { easeOut: HUD.motion.slideEasing },
    },
  });
}

export const eqxTheme: Theme = buildEqxTheme();
