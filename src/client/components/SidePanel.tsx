/**
 * The game's side panel shell: a docked, NON-dimming panel with the world live
 * and interactive behind it. Docks RIGHT on any landscape screen (narrower on a
 * phone) and as a BOTTOM sheet upright (`focusPanelDock`). MUI `persistent`
 * Drawer — NOT a `temporary`/Modal drawer, so there is no scrim, the map behind
 * stays interactive and re-selectable, and there are no global touch listeners
 * (avoids the SwipeableDrawer RTT regression). A scoped swipe on the grab
 * handle closes it; the content (children) lays out its own header, scroll body
 * and action bar inside the Paper's column.
 *
 * Used by the galaxy map's sector drawer (SectorInfoDrawer.tsx) and the
 * building settings panel (StructureSettingsModal.tsx). A new docked panel
 * builds on this, never on a copy of it; a full-screen window uses GameWindow.
 */
import { useRef, type ReactNode } from 'react';
import { Box, Drawer, Portal, useMediaQuery } from '@mui/material';
import { Z } from '../layout/zIndex';
import { isTouchDevice } from '../input/TouchInput';
import {
  focusPanelDock, PANEL_RIGHT_W, PANEL_TOUCH_FRAC, PANEL_TOUCH_MIN_W, PANEL_TOUCH_TOP, SHEET_FRAC_PORTRAIT, SHEET_MAX_H,
  type FocusPanelDock,
} from '../render/galaxy/galaxyFocus';

const SWIPE_CLOSE_PX = 56; // swipe distance (in the dock-out direction) that closes

/** How wide the right dock is. On a touch screen: `touchFrac` of the width,
 *  clamped to [`touchMinW`, `width`]; `touchTop` is where it starts (null =
 *  under the app bar, like on desktop). */
export interface SidePanelSize {
  width: number;
  touchFrac: number;
  touchMinW: number;
  touchTop: number | null;
}

/** The galaxy map's sector panel (galaxyFocus.ts frames the sector beside it). */
export const SECTOR_PANEL_SIZE: SidePanelSize = {
  width: PANEL_RIGHT_W, touchFrac: PANEL_TOUCH_FRAC, touchMinW: PANEL_TOUCH_MIN_W, touchTop: PANEL_TOUCH_TOP,
};

const PAPER_COMMON = {
  bgcolor: 'rgba(8,12,24,0.98)',
  color: '#dffff0',
  border: '1px solid #2a3550',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  // The host chrome root is pointerEvents:none (taps fall through to the canvas);
  // re-enable on the Paper so the panel's controls are interactive.
  pointerEvents: 'auto',
  // MUI's persistent (docked) Drawer sets NO z-index on its Paper, so the
  // bottom-right chrome buttons (landing: single-player/engineering z3-4; in-game:
  // the AUTO/FIRE/BOOST HUD at Z.mobileControls) would render OVER the panel's
  // action bar and intercept clicks. Pin it to the drawer tier (above both, below
  // the app bar — the panel already starts under the app bar).
  zIndex: Z.drawer,
} as const;

/** The right dock's Paper sx (exported for the size locks). */
export function rightPaperSx(size: SidePanelSize, touch: boolean): Record<string, unknown> {
  const right = {
    ...PAPER_COMMON,
    width: size.width,
    maxWidth: '92vw',
    top: 'var(--app-bar-h, 48px)',
    // dvh tracks the VISIBLE viewport (mobile address/nav bars), so the panel
    // never overflows past the fold; `100%` resolves to the LARGE layout viewport
    // and clipped on a non-fullscreen mobile browser.
    height: 'calc(100dvh - var(--app-bar-h, 48px))',
    borderRadius: '8px 0 0 8px',
  };
  if (!touch) return right;
  // Phone held sideways: a narrower panel; the sector panel starts below the
  // top-right toolbar (full-screen chip), so the hex keeps the height.
  return {
    ...right,
    width: `clamp(${size.touchMinW}px, ${size.touchFrac * 100}vw, ${size.width}px)`,
    ...(size.touchTop !== null && { top: `${size.touchTop}px`, height: `calc(100dvh - ${size.touchTop}px)` }),
  };
}

const PAPER_BOTTOM = {
  ...PAPER_COMMON,
  width: '100%',
  // ~40% of the visible height — between the original 54% ("too big") and the
  // 28% pass ("too small"). dvh (dynamic viewport height) shrinks as the mobile
  // address bar shows, so the fixed action bar is never clipped below the fold
  // when NOT in fullscreen; the body scrolls on overflow.
  height: `min(${SHEET_FRAC_PORTRAIT * 100}dvh, ${SHEET_MAX_H}px)`,
  maxHeight: 'calc(100dvh - 8px)',
  borderRadius: '10px 10px 0 0',
} as const;

const HANDLE_WRAP_SX = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  height: 24,
  cursor: 'grab',
  // `none` stops the browser claiming the drag as a scroll/pull-to-refresh and
  // firing pointercancel instead of the pointerup our swipe-close reads.
  touchAction: 'none',
  flex: '0 0 auto',
} as const;

/** Where the panel docks now: right sideways, bottom upright. */
export function useSidePanelDock(): FocusPanelDock {
  return focusPanelDock(useMediaQuery('(orientation: portrait)'));
}

export interface SidePanelProps {
  open: boolean;
  /** ✕ / swipe on the handle. */
  onClose: () => void;
  /** The Drawer root's test id. */
  testId: string;
  /** The grab handle's test id. */
  handleTestId?: string;
  size?: SidePanelSize;
  /** Extra attributes on the Paper (E2E hooks). */
  paperAttrs?: Record<string, string>;
  children: ReactNode;
}

export function SidePanel({
  open, onClose, testId, handleTestId, size = SECTOR_PANEL_SIZE, paperAttrs, children,
}: SidePanelProps): JSX.Element {
  const anchor = useSidePanelDock();

  // Scoped swipe-to-close on the grab handle (no global listeners — avoids the
  // SwipeableDrawer RTT regression). The Paper FOLLOWS the finger in the
  // dock-OUT direction (down for bottom, right for right) for live feedback;
  // release past SWIPE_CLOSE_PX closes, otherwise it snaps back.
  // Pointer capture keeps move/up on the handle even as the finger leaves it.
  const paperRef = useRef<HTMLDivElement | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const outDelta = (e: React.PointerEvent, s: { x: number; y: number }): number =>
    anchor === 'bottom' ? e.clientY - s.y : e.clientX - s.x;
  const onHandleDown = (e: React.PointerEvent): void => {
    dragStart.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent): void => {
    const s = dragStart.current;
    const p = paperRef.current;
    if (!s || !p) return;
    const out = Math.max(0, outDelta(e, s));
    p.style.transition = 'none';
    p.style.transform = anchor === 'bottom' ? `translateY(${out}px)` : `translateX(${out}px)`;
  };
  const onHandleUp = (e: React.PointerEvent): void => {
    const s = dragStart.current;
    dragStart.current = null;
    const p = paperRef.current;
    if (!s) return;
    const out = outDelta(e, s);
    if (out > SWIPE_CLOSE_PX) {
      // Hand the transform back to MUI; its exit slide animates the rest out.
      if (p) { p.style.transition = ''; p.style.transform = ''; }
      onClose();
    } else if (p) {
      // Snap back to docked.
      p.style.transition = 'transform 160ms ease';
      p.style.transform = '';
    }
  };
  const onHandleCancel = (): void => {
    dragStart.current = null;
    const p = paperRef.current;
    if (p) { p.style.transition = ''; p.style.transform = ''; }
  };

  return (
    // Portal to <body> so the panel escapes the host chrome / GameSurface
    // stacking traps: its Paper z (Z.drawer) then lives at the body level, ABOVE
    // the gameplay HUD slot hosts (Z.mobileControls) whose action bar it overlaps
    // when docked. Without this, a z=1200 Paper nested in a z-auto chrome can't
    // beat a body-level z=15 sibling (CSS stacking-context isolation).
    <Portal>
    <Drawer
      variant="persistent"
      anchor={anchor}
      open={open}
      data-testid={testId}
      PaperProps={{
        ref: paperRef,
        sx: anchor === 'bottom' ? PAPER_BOTTOM : rightPaperSx(size, isTouchDevice()),
        ...paperAttrs,
      }}
    >
      {/* Grab handle (swipe-to-close). */}
      <Box
        sx={HANDLE_WRAP_SX}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleCancel}
        data-testid={handleTestId}
        aria-label="Drag to close"
      >
        {/* The visible grabber pill reads as a resize handle; the panel is a
            fixed-size MUI `persistent` drawer (never resizable) and
            swipe-to-close is a TOUCH gesture only, so hide the pill on
            fine-pointer (desktop) devices — there the ✕ closes it — and make
            it subtler on touch. */}
        <Box
          sx={{
            width: anchor === 'bottom' ? 40 : 4,
            height: anchor === 'bottom' ? 4 : 40,
            borderRadius: 2,
            bgcolor: 'rgba(255,255,255,0.16)',
            '@media (pointer: fine)': { display: 'none' },
          }}
        />
      </Box>
      {children}
    </Drawer>
    </Portal>
  );
}
