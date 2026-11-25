/**
 * The Window's parts its content draws (header, ✕, footer, buttons), as sx
 * objects in the HUD's palette. Moved here from `client/components/GameWindow.tsx`
 * with EqxWindow; that path re-exports them so CargoPanel, TradeMarket and the
 * building settings panel keep their look unchanged. Known debt: these are sx
 * objects for feature code, which the catalogue contract forbids; they shrink
 * as those contents move onto EqxWindow's `title` header and catalogue buttons.
 */
import { HUD } from '../../client/hud/tokens.js';

const C = HUD.color;
const W = HUD.window;
export const WINDOW_EDGE = `1px solid ${C.panelEdge}`;

/** The content's column: header, a body that scrolls, footer. */
export const WINDOW_ROOT_SX = {
  pointerEvents: 'auto' as const, display: 'flex', flexDirection: 'column' as const, color: C.ink,
  fontFamily: HUD.font.label, fontSize: W.font, flex: '1 1 auto', minHeight: 0,
};
export const WINDOW_HEAD_SX = {
  flex: 'none', display: 'flex', alignItems: 'center', gap: `${W.gap}px`, px: `${W.padX}px`, py: `${W.padY}px`,
  borderBottom: WINDOW_EDGE, minHeight: W.headMinH, flexWrap: 'wrap' as const,
};
export const WINDOW_TITLE_SX = { fontWeight: 700, fontSize: W.titleSize, letterSpacing: 0.5 };
/** The header's ✕. */
export const WINDOW_X_SX = {
  ml: 'auto', width: W.xBtn, height: W.xBtn, border: WINDOW_EDGE, borderRadius: `${W.btnRadius}px`, display: 'grid', placeItems: 'center',
  color: C.inkDim, fontSize: W.xFont, cursor: 'pointer', background: 'transparent', p: 0,
};
export const WINDOW_FOOT_SX = {
  flex: 'none', display: 'flex', alignItems: 'center', gap: 1, px: `${W.padX}px`, py: `${W.padY}px`, borderTop: WINDOW_EDGE,
  minHeight: W.footMinH, fontSize: W.smallFont, color: C.inkDim,
};
export const WINDOW_BTN_BASE_SX = {
  height: W.btnH, px: `${W.btnPadX}px`, borderRadius: `${W.btnRadius}px`, display: 'grid', placeItems: 'center', fontWeight: 700,
  fontSize: W.btnFont, letterSpacing: 0.5, border: '1px solid', cursor: 'pointer', userSelect: 'none' as const,
  fontFamily: HUD.font.label, whiteSpace: 'nowrap' as const,
};
export const WINDOW_BTN_SECONDARY_SX = { ...WINDOW_BTN_BASE_SX, borderColor: C.panelEdge, color: C.ink, backgroundColor: 'transparent' };
