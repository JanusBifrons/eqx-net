/**
 * The game's window frame: the loot window's shell, shared. A fixed, opaque,
 * screen-space Dialog (dimmed backdrop, nearly the whole screen on a phone)
 * in the HUD's palette (hud/tokens.ts), plus the parts its content draws: the
 * header (name, chips, ✕), the footer and its buttons.
 *
 * Used by the loot window (LootWindow.tsx, whose content is CargoPanel) and
 * the building settings window (StructureSettingsModal.tsx). A new full-screen
 * game window builds on this, never on a copy of it.
 */
import type { ReactNode } from 'react';
import { Dialog } from '@mui/material';
import { Z } from '../layout/zIndex';
import { HUD } from '../hud/tokens';
import { useHudSize } from '../hud/useHudScale';

const C = HUD.color;
export const WINDOW_EDGE = `1px solid ${C.panelEdge}`;

/** Opaque, in the HUD's palette, as wide as two cargo grids. */
const PAPER_SX = {
  m: 1.5, width: 'min(880px, calc(100% - 24px))', maxWidth: 'none', maxHeight: 'calc(100% - 24px)',
  bgcolor: '#070b15', backgroundImage: 'none', color: C.ink,
  border: WINDOW_EDGE, borderRadius: '10px', boxShadow: '0 10px 40px rgba(0,0,0,0.65)',
} as const;
/**
 * On a phone every window is the whole screen (less the small margin), whatever
 * it holds: the body scrolls, the footer stays at the bottom. Never a thin strip.
 */
const PHONE_PAPER_SX = { ...PAPER_SX, width: 'calc(100% - 24px)', height: 'calc(100% - 24px)' } as const;

/** The content's column: header, a body that scrolls, footer. */
export const WINDOW_ROOT_SX = {
  pointerEvents: 'auto' as const, display: 'flex', flexDirection: 'column' as const, color: C.ink,
  fontFamily: HUD.font.label, fontSize: 12, flex: '1 1 auto', minHeight: 0,
};
export const WINDOW_HEAD_SX = { flex: 'none', display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1, borderBottom: WINDOW_EDGE, minHeight: 52, flexWrap: 'wrap' as const };
export const WINDOW_TITLE_SX = { fontWeight: 700, fontSize: 15, letterSpacing: 0.5 };
/** The header's ✕. */
export const WINDOW_X_SX = {
  ml: 'auto', width: 32, height: 32, border: WINDOW_EDGE, borderRadius: '6px', display: 'grid', placeItems: 'center',
  color: C.inkDim, fontSize: 16, cursor: 'pointer', background: 'transparent', p: 0,
};
export const WINDOW_FOOT_SX = {
  flex: 'none', display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderTop: WINDOW_EDGE, minHeight: 58, fontSize: 11, color: C.inkDim,
};
export const WINDOW_BTN_BASE_SX = {
  height: 38, px: 2, borderRadius: '6px', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13,
  letterSpacing: 0.5, border: '1px solid', cursor: 'pointer', userSelect: 'none' as const, fontFamily: HUD.font.label,
  whiteSpace: 'nowrap' as const,
};
export const WINDOW_BTN_SECONDARY_SX = { ...WINDOW_BTN_BASE_SX, borderColor: C.panelEdge, color: C.ink, backgroundColor: 'transparent' };

export interface GameWindowProps {
  open: boolean;
  onClose: () => void;
  /** The Dialog root's test id. */
  testId: string;
  children: ReactNode;
}

export function GameWindow({ open, onClose, testId, children }: GameWindowProps): JSX.Element {
  // The HUD's phone check: coarse pointer and short side < 500 px (a sideways phone too).
  const phone = useHudSize() === 'phone';
  return (
    <Dialog
      open={open} onClose={onClose} maxWidth={false} data-testid={testId} data-game-window="1" data-window-size={phone ? 'full' : 'fit'} sx={{ zIndex: Z.modal }}
      PaperProps={{ sx: phone ? PHONE_PAPER_SX : PAPER_SX }}
    >
      {children}
    </Dialog>
  );
}
