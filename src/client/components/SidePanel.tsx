/**
 * The game's side panel shell: a docked, NON-dimming panel with the world live
 * and interactive behind it. Docks RIGHT on any landscape screen (narrower on a
 * phone) and as a BOTTOM sheet upright (`focusPanelDock`). MUI `persistent`
 * Drawer — NOT a `temporary`/Modal drawer, so there is no scrim, the map behind
 * stays interactive and re-selectable, and there are no global touch listeners
 * (avoids the SwipeableDrawer RTT regression). A scoped swipe on the grab
 * handle closes it; the content (children) lays out its own header, scroll body
 * and action bar inside the Paper's column — or, given a `title`, the panel
 * draws the header itself (the title is the grab handle, plus a ✕). A size
 * with `touchToolbarRow` then runs the full height on a phone, its header in
 * the top-right toolbar's row beside a see-through notch the toolbar shows
 * (and is tapped) through. A `centred` size is a slim strip of its own
 * children only, vertically centred on the right edge (the folded Build sidebar).
 *
 * Used by the galaxy map's sector drawer (SectorInfoDrawer.tsx) and the
 * building settings panel (StructureSettingsModal.tsx) and the Build sidebar
 * (BuildSidebar.tsx); only one of the last two is open at a time. A new docked panel
 * builds on this, never on a copy of it; a full-screen window uses GameWindow.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Box, Drawer, Portal, useMediaQuery } from '@mui/material';
import { Z } from '../layout/zIndex';
import { WINDOW_HEAD_SX, WINDOW_TITLE_SX, WINDOW_X_SX } from './GameWindow';
import { isTouchDevice } from '../input/TouchInput';
import {
  focusPanelDock, PANEL_RIGHT_W, PANEL_TOUCH_FRAC, PANEL_TOUCH_MIN_W, PANEL_TOUCH_TOP, SHEET_FRAC_PORTRAIT, SHEET_MAX_H,
  type FocusPanelDock,
} from '../render/galaxy/galaxyFocus';
import { useUIStore } from '../state/store';

const SWIPE_CLOSE_PX = 56; // swipe distance (in the dock-out direction) that closes

/** How wide the right dock is. On a touch screen: `touchFrac` of the width,
 *  clamped to [`touchMinW`, `width`]; `touchTop` is where it starts (null =
 *  under the app bar, like on desktop). */
export interface SidePanelSize {
  width: number;
  touchFrac: number;
  touchMinW: number;
  touchTop: number | null;
  /** Touch, right dock, with a `title`: ignore `touchTop`, run the full height
   *  and put the header in the top-right toolbar's row beside a see-through
   *  notch (TOOLBAR_NOTCH_W × TOOLBAR_ROW_H), so no empty band sits above it. */
  touchToolbarRow?: boolean;
  /** A slim strip: auto height, vertically centred on the right edge (any
   *  orientation), no notch, no header, no grab handle; `width` on desktop,
   *  `touchMinW` on touch. */
  centred?: boolean;
}

/** The see-through notch left for the top-right toolbar (TopRightToolbar.tsx:
 *  two 26 px chips 4 px apart, 16 px in from the right edge and 16 px down)
 *  plus a 12 px margin; the header row beside it reaches past the toolbar's
 *  bottom edge (42 px). */
export const TOOLBAR_NOTCH_W = 'calc(env(safe-area-inset-right, 0px) + 84px)';
export const TOOLBAR_ROW_H = 48;

/** The galaxy map's sector panel (galaxyFocus.ts frames the sector beside it). */
export const SECTOR_PANEL_SIZE: SidePanelSize = {
  width: PANEL_RIGHT_W, touchFrac: PANEL_TOUCH_FRAC, touchMinW: PANEL_TOUCH_MIN_W, touchTop: PANEL_TOUCH_TOP,
};

/** The Build sidebar (BuildSidebar.tsx): 0.4 of a sideways phone's width
 *  (915 px: 366 px), full height with its header in the toolbar's row; 380 px
 *  on desktop. */
export const BUILD_PANEL_SIZE: SidePanelSize = {
  width: 380, touchFrac: 0.4, touchMinW: 280, touchTop: PANEL_TOUCH_TOP, touchToolbarRow: true,
};

/** The Build sidebar folded while placing (BuildPlacingStrip.tsx): a slim
 *  strip, vertically centred on the right edge with auto height; ~100 px wide
 *  on a sideways phone. Same panel as BUILD_PANEL_SIZE, never a second one. */
export const BUILD_STRIP_SIZE: SidePanelSize = {
  width: 112, touchFrac: 0, touchMinW: 100, touchTop: null, centred: true,
};

/** Esc closes a panel, unless typing in a field or another Esc owner took the
 *  key: placement and a fleet map pick cancel first (App.tsx keydown marks the
 *  key handled), and a game window on top stops the key itself (MUI Modal).
 *  One Esc press does one thing. */
export function escapeClosesPanel(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false;
  const t = e.target as HTMLElement | null;
  if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
  const st = useUIStore.getState();
  return st.placementKind === null && st.fleetPick === null;
}

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
  if (size.centred === true) return centredPaperSx(size, touch);
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
  const width = `clamp(${size.touchMinW}px, ${size.touchFrac * 100}vw, ${size.width}px)`;
  // Toolbar-row panel: the Paper is see-through and full height; its header
  // and body boxes paint the panel around the toolbar's notch.
  if (size.touchToolbarRow === true) {
    return { ...right, width, top: 0, height: '100dvh', bgcolor: 'transparent', border: 'none', borderRadius: 0 };
  }
  return {
    ...right,
    width,
    ...(size.touchTop !== null && { top: `${size.touchTop}px`, height: `calc(100dvh - ${size.touchTop}px)` }),
  };
}

/** The centred strip: top and bottom 0 with a fit-content height and auto
 *  margins centres it (no transform: the Drawer slide owns the transform). */
function centredPaperSx(size: SidePanelSize, touch: boolean): Record<string, unknown> {
  return {
    ...PAPER_COMMON,
    width: touch ? size.touchMinW : size.width,
    top: 0,
    bottom: 0,
    height: 'fit-content',
    maxHeight: '100dvh',
    my: 'auto',
    borderRadius: '8px 0 0 8px',
    borderRight: 'none',
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

const PANEL_BG = PAPER_COMMON.bgcolor;
const PANEL_EDGE = PAPER_COMMON.border;
const HEAD_SX = { ...WINDOW_HEAD_SX, flexWrap: 'nowrap' } as const;
const GRAB_TITLE_SX = {
  ...WINDOW_TITLE_SX, flex: '1 1 auto', minWidth: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center',
  touchAction: 'none', '@media (pointer: coarse)': { cursor: 'grab' },
} as const;
const GRAB_TITLE_NOTCH_SX = { ...GRAB_TITLE_SX, fontSize: 13 } as const;
const X_NOTCH_SX = { ...WINDOW_X_SX, width: 28, height: 28, fontSize: 14 } as const;
const TOP_ROW_SX = { flex: 'none', display: 'flex', height: TOOLBAR_ROW_H } as const;
/** The compact header beside the notch; the body's top edge draws the line under it. */
const HEAD_NOTCH_SX = {
  ...HEAD_SX, flex: '1 1 auto', minWidth: 0, minHeight: 0, height: TOOLBAR_ROW_H, py: 0, px: 1, gap: 1,
  bgcolor: PANEL_BG, border: PANEL_EDGE, borderBottom: 'none', borderRight: 'none', borderTopLeftRadius: '8px',
} as const;
/** See-through: the toolbar paints, and is tapped, through it. */
const NOTCH_SX = { flex: `0 0 ${TOOLBAR_NOTCH_W}`, pointerEvents: 'none' } as const;
const NOTCH_BODY_SX = {
  flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', bgcolor: PANEL_BG,
  border: PANEL_EDGE, borderRight: 'none', borderRadius: '0 8px 0 8px',
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
  /** Esc closes it while open (escapeClosesPanel). */
  closeOnEscape?: boolean;
  /** Extra attributes on the Paper (E2E hooks). */
  paperAttrs?: Record<string, string>;
  /** The panel draws the header: this title (the grab handle) and a ✕. */
  title?: ReactNode;
  /** The header's test id (with `title`). */
  headerTestId?: string;
  /** The ✕'s test id (with `title`). */
  closeTestId?: string;
  children: ReactNode;
}

export function SidePanel({
  open, onClose, testId, handleTestId, size = SECTOR_PANEL_SIZE, closeOnEscape = false, paperAttrs, children,
  title, headerTestId, closeTestId,
}: SidePanelProps): JSX.Element {
  const dock = useSidePanelDock();
  const centred = size.centred === true;
  // A centred strip always docks right; it never becomes the bottom sheet.
  const anchor: FocusPanelDock = centred ? 'right' : dock;
  const touch = isTouchDevice();
  // The toolbar row needs the panel-drawn header; without one, the plain dock.
  const notch = title !== undefined && anchor === 'right' && touch && size.touchToolbarRow === true;
  const paperSize = notch || size.touchToolbarRow !== true ? size : { ...size, touchToolbarRow: false };
  useEffect(() => {
    if (!open || !closeOnEscape) return undefined;
    const onKey = (e: KeyboardEvent): void => { if (escapeClosesPanel(e)) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, onClose]);

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

  // The panel-drawn header: the title is the grab handle (its swipe closes);
  // the ✕ sits outside it so the handle's pointer capture never takes its click.
  const header = (compact: boolean): JSX.Element => (
    <Box sx={compact ? HEAD_NOTCH_SX : HEAD_SX} data-testid={headerTestId} data-compact={compact ? '1' : '0'}>
      <Box sx={compact ? GRAB_TITLE_NOTCH_SX : GRAB_TITLE_SX} onPointerDown={onHandleDown} onPointerMove={onHandleMove}
        onPointerUp={onHandleUp} onPointerCancel={onHandleCancel} data-testid={handleTestId} aria-label="Drag to close">
        {title}
      </Box>
      <Box component="button" type="button" sx={compact ? X_NOTCH_SX : WINDOW_X_SX} onClick={onClose}
        aria-label="Close" data-testid={closeTestId}>✕</Box>
    </Box>
  );

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
        sx: anchor === 'bottom' ? PAPER_BOTTOM : rightPaperSx(paperSize, touch),
        ...paperAttrs,
      }}
    >
      {centred && children}
      {!centred && title !== undefined && (notch ? (
        <>
          <Box sx={TOP_ROW_SX}>
            {header(true)}
            <Box sx={NOTCH_SX} aria-hidden data-testid="side-panel-notch" />
          </Box>
          <Box sx={NOTCH_BODY_SX}>{children}</Box>
        </>
      ) : (
        <>
          {header(false)}
          {children}
        </>
      ))}
      {/* Grab handle (swipe-to-close), when the content draws its own header. */}
      {!centred && title === undefined && <Box
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
      </Box>}
      {!centred && title === undefined && children}
    </Drawer>
    </Portal>
  );
}
