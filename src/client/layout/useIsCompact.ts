import { useMediaQuery, useTheme } from '@mui/material';

/**
 * True when the viewport is below the MUI `sm` breakpoint (default 600 px).
 *
 * This is a viewport-density signal — not an input-mode signal. Touch on a
 * desktop monitor and pointer on a tablet are both real cases, so input-mode
 * checks (`isTouchDevice()`) and viewport checks live on independent axes.
 */
export function useIsCompact(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.down('sm'));
}
