/**
 * EqxWindow: the one Window (UI language plan A6), GameWindow evolved and
 * moved here; `client/components/GameWindow.tsx` re-exports it, so the old
 * name and path still work. A fixed, opaque, screen-space MUI Dialog: dims the
 * world, centred on desktop, the whole screen (less a small margin) on a phone,
 * `Z.modal`; closes on ✕ and Esc. Given a `title` it draws its header (title,
 * ✕) over a scrolling body; without one the content draws its own (CargoPanel).
 */
import { useEffect, type ReactNode } from 'react';
import { Box, Dialog } from '@mui/material';
import { Z } from '../../client/layout/zIndex.js';
import { HUD } from '../../client/hud/tokens.js';
import { useHudSize } from '../../client/hud/useHudScale.js';
import { WINDOW_EDGE, WINDOW_HEAD_SX, WINDOW_ROOT_SX, WINDOW_TITLE_SX, WINDOW_X_SX } from './windowParts.js';
import { markWindowOpen, notifyGameWindowOpen } from './windowOpen.js';

const W = HUD.window;
/** Opaque, in the HUD's palette, as wide as two cargo grids. */
const PAPER_SX = {
  m: `${W.margin}px`, width: `min(${W.maxW}px, calc(100% - ${2 * W.margin}px))`, maxWidth: 'none', maxHeight: `calc(100% - ${2 * W.margin}px)`,
  bgcolor: HUD.color.paper, backgroundImage: 'none', color: HUD.color.ink,
  border: WINDOW_EDGE, borderRadius: `${W.radius}px`, boxShadow: W.shadow,
} as const;
/** On a phone every window is the whole screen (less the margin), whatever it holds. */
const PHONE_PAPER_SX = { ...PAPER_SX, width: `calc(100% - ${2 * W.margin}px)`, height: `calc(100% - ${2 * W.margin}px)` } as const;
const BODY_SX = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' } as const;

export interface EqxWindowProps {
  open: boolean;
  /** ✕, Esc and a backdrop tap. */
  onClose: () => void;
  /** The Dialog root's test id. */
  testId: string;
  /** The window draws its header: this title and a ✕. Without it the content draws its own. */
  title?: ReactNode;
  /** The ✕'s test id (with `title`). */
  closeTestId?: string;
  children: ReactNode;
}

export function EqxWindow({ open, onClose, testId, title, closeTestId, children }: EqxWindowProps): JSX.Element {
  // The HUD's phone check: coarse pointer and short side < 500 px (a sideways phone too).
  const phone = useHudSize() === 'phone';
  useEffect(() => {
    if (!open) return undefined;
    notifyGameWindowOpen();
    markWindowOpen(1);
    return () => markWindowOpen(-1);
  }, [open]);
  return (
    <Dialog
      open={open} onClose={onClose} maxWidth={false} data-testid={testId} data-game-window="1" data-window-size={phone ? 'full' : 'fit'}
      sx={{ zIndex: Z.modal }} PaperProps={{ sx: phone ? PHONE_PAPER_SX : PAPER_SX }}
    >
      {title === undefined ? children : (
        <Box sx={WINDOW_ROOT_SX}>
          <Box sx={WINDOW_HEAD_SX}>
            <Box sx={WINDOW_TITLE_SX}>{title}</Box>
            <Box component="button" type="button" sx={WINDOW_X_SX} onClick={onClose} aria-label="Close" data-testid={closeTestId}>✕</Box>
          </Box>
          <Box sx={BODY_SX}>{children}</Box>
        </Box>
      )}
    </Dialog>
  );
}
