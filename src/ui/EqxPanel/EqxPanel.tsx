/**
 * EqxPanel: the one right panel (UI language plan A4), SidePanel evolved and
 * moved here; `src/client/components/SidePanel.tsx` re-exports it, so the old
 * name and path still work. Panel-drawn header: optional ← back (`onBack`),
 * title, ✕. Footer only with `apply`: a cyan Apply button, off until `dirty`.
 *
 * The game's side panel shell: a docked, NON-dimming panel with the world live
 * and interactive behind it. Docks RIGHT on any landscape screen (narrower on a
 * phone) and as a BOTTOM sheet upright (`focusPanelDock`). MUI `persistent`
 * Drawer — NOT a `temporary`/Modal drawer, so there is no scrim, the map behind
 * stays interactive and re-selectable, and there are no global touch listeners
 * (avoids the SwipeableDrawer RTT regression). A scoped swipe on the grab
 * handle closes it; the content (children) lays out its own header, scroll body
 * and action bar inside the Paper's column — or, given a `title`, the panel
 * draws the header itself (the title is the grab handle, plus a ✕). A
 * `centred` size is a slim strip of its own
 * children only, vertically centred on the right edge (unused since UI U3-7 moved the placing tools to the left strip).
 *
 * Used by the galaxy map's sector drawer (SectorInfoDrawer.tsx), the right
 * panels (Details, where a building's settings live, and the rest) and the
 * Build sidebar (BuildSidebar.tsx); one right panel is open at a time. A new docked panel
 * builds on this, never on a copy of it; a full-screen window uses EqxWindow.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Box, Drawer, Portal, useMediaQuery } from '@mui/material';
import { Z } from '../../client/layout/zIndex.js';
import { RAIL_W_CSS } from '../../client/layout/railWidth.js';
import { HUD } from '../../client/hud/tokens.js';
import { isTouchDevice } from '../../client/input/TouchInput.js';
import {
  focusPanelDock, PANEL_RIGHT_W, PANEL_TOUCH_FRAC, PANEL_TOUCH_MIN_W, PANEL_TOUCH_TOP, SHEET_FRAC_PORTRAIT, SHEET_MAX_H,
  type FocusPanelDock,
} from '../../client/render/galaxy/galaxyFocus.js';
import { useUIStore } from '../../client/state/store.js';
import { EqxButton } from '../EqxButton/EqxButton.js';

const SWIPE_CLOSE_PX = 56; // swipe distance (in the dock-out direction) that closes

/** How wide the right dock is. On a touch screen: `touchFrac` of the width,
 *  clamped to [`touchMinW`, `width`]; `touchTop` is where it starts (null =
 *  under the app bar, like on desktop). */
export interface SidePanelSize {
  width: number;
  touchFrac: number;
  touchMinW: number;
  touchTop: number | null;
  /** A slim strip: auto height, vertically centred on the right edge (any
   *  orientation), no header, no grab handle; `width` on desktop,
   *  `touchMinW` on touch. */
  centred?: boolean;
  /** The mock's dock: the right edge, top 0 to bottom 0, on any screen (touch
   *  and desktop); `touchTop` is ignored. Covers the top-right toolbar (⛶). */
  fullHeight?: boolean;
}

/** The catalogue panel (mock `.panel`): full height on the right edge, ~36% of
 *  a sideways phone (915 px: ~330 px), 380 px on desktop. */
export const EQX_PANEL_SIZE: SidePanelSize = {
  width: 380, touchFrac: 0.36, touchMinW: 300, touchTop: null, fullHeight: true,
};

/** The galaxy map's sector panel (galaxyFocus.ts frames the sector beside it). */
export const SECTOR_PANEL_SIZE: SidePanelSize = {
  width: PANEL_RIGHT_W, touchFrac: PANEL_TOUCH_FRAC, touchMinW: PANEL_TOUCH_MIN_W, touchTop: PANEL_TOUCH_TOP,
};

/** The Build sidebar (BuildSidebar.tsx): 0.4 of a sideways phone's width
 *  (915 px: 366 px), full height over the top-right toolbar like every panel
 *  (owner 2026-11-22: cover ⛶, leave no gap for it); 380 px on desktop. */
export const BUILD_PANEL_SIZE: SidePanelSize = {
  width: 380, touchFrac: 0.4, touchMinW: 280, touchTop: null, fullHeight: true,
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
  bgcolor: HUD.color.sidePanelBg,
  color: HUD.color.ink,
  border: `1px solid ${HUD.color.sidePanelEdge}`,
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  // The host chrome root is pointerEvents:none (taps fall through to the canvas);
  // re-enable on the Paper so the panel's controls are interactive.
  pointerEvents: 'auto',
  // MUI's persistent (docked) Drawer sets NO z-index on its Paper, so the
  // bottom-right chrome buttons (landing: single-player/engineering z3-4; in-game:
  // the AUTO/FIRE/BOOST HUD at Z.mobileControls) would render OVER the panel's
  // action bar and intercept clicks. Pin it to the panel tier: above both, and
  // UNDER the right rail (Z.railStrip), so its open / close slide passes beneath
  // the rail (mock: .panel z 4, .rail z 5).
  zIndex: Z.panel,
} as const;

/** The right dock's Paper sx (exported for the size locks). */
export function rightPaperSx(size: SidePanelSize, touch: boolean): Record<string, unknown> {
  if (size.centred === true) return centredPaperSx(size, touch);
  const right = {
    ...PAPER_COMMON,
    // Docked LEFT of the right rail (`--rail-w`, 0px until the rail mounts).
    right: RAIL_W_CSS,
    width: size.width,
    maxWidth: '92vw',
    top: 'var(--app-bar-h, 48px)',
    // dvh tracks the VISIBLE viewport (mobile address/nav bars), so the panel
    // never overflows past the fold; `100%` resolves to the LARGE layout viewport
    // and clipped on a non-fullscreen mobile browser.
    height: 'calc(100dvh - var(--app-bar-h, 48px))',
    // Mock `.panel`: flush to the edge, one edge2 line on the left, no card corners.
    border: 'none',
    borderLeft: `1px solid ${HUD.color.edge2}`,
    borderRadius: 0,
  };
  if (size.fullHeight === true) {
    // Desktop: the same share of the width, capped at `width` (a 915 px window matches the phone).
    const frac = `${size.touchFrac * 100}vw`;
    const w = touch ? `clamp(${size.touchMinW}px, ${frac}, ${size.width}px)` : `min(${size.width}px, ${frac})`;
    // Top = the app bar's height: 0 on touch (covers ⛶, owner 2026-11-22); on
    // desktop it starts under the AppHeader, level with the rail, so the header's
    // settings cog (z appBar) never sits over the panel's ✕.
    return { ...right, width: w, top: 'var(--app-bar-h, 0px)', bottom: 0, height: 'calc(100dvh - var(--app-bar-h, 0px))' };
  }
  if (!touch) return right;
  // Phone held sideways: a narrower panel; the sector panel starts below the
  // top-right toolbar (full-screen chip), so the hex keeps the height.
  const width = `clamp(${size.touchMinW}px, ${size.touchFrac * 100}vw, ${size.width}px)`;
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
    right: RAIL_W_CSS,
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
  // Flat like the right dock: one edge2 line on top, no card corners.
  border: 'none',
  borderTop: `1px solid ${HUD.color.edge2}`,
  borderRadius: 0,
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

const P = HUD.panel;
/** Mock `.ph`: title row with a bottom edge; ← and ✕ are small outlined squares. */
const HEAD_SX = {
  flex: 'none', display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: `${P.rowGap}px`,
  px: `${P.padX}px`, py: `${P.padY}px`, minHeight: P.headMinH, boxSizing: 'border-box',
  borderBottom: `1px solid ${HUD.color.panelEdge}`,
} as const;
const GRAB_TITLE_SX = {
  fontFamily: HUD.font.label, fontWeight: 700, fontSize: P.titleSize, color: HUD.color.ink,
  flex: '1 1 auto', minWidth: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center',
  touchAction: 'none', '@media (pointer: coarse)': { cursor: 'grab' },
} as const;
const HEAD_BTN_SX = {
  flex: 'none', width: P.headBtn, height: P.headBtn, p: 0, display: 'grid', placeItems: 'center',
  border: `1px solid ${HUD.color.edge2}`, borderRadius: `${P.radius}px`, background: 'transparent',
  color: HUD.color.inkDim, fontFamily: HUD.font.label, fontSize: P.titleSize - 1, cursor: 'pointer',
} as const;
/** Mock `.pb`: the body takes the spare height and scrolls; rows keep their size. */
const BODY_PADDED_SX = {
  flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
  display: 'flex', flexDirection: 'column', gap: `${P.bodyGap}px`, px: `${P.padX}px`, py: `${P.padY}px`,
  '& > *': { flex: 'none' },
} as const;
/** `body="bare"`: the content lays out its own padding and scroll. */
const BODY_BARE_SX = { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } as const;

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
  /** A ← back button before the title (drill-down sub-pages; with `title`). */
  onBack?: () => void;
  /** The footer: a cyan Apply button, dimmed and off until `dirty` (changed, not applied). No footer without it. */
  apply?: EqxPanelApply;
  /** With `title`: 'padded' (default) is the mock body (padding, row gap, scrolls);
   *  'bare' when the content lays out its own (the Build sidebar). */
  body?: 'padded' | 'bare';
  children: ReactNode;
}

/** The panel's Apply footer (plan A4): `dirty` = a changed but unapplied value. */
export interface EqxPanelApply {
  onApply: () => void;
  dirty: boolean;
  /** Default "Apply". */
  label?: string;
  /** An outlined action left of Apply (the mock fleet panel's Stop). */
  secondary?: { label: string; onClick: () => void; testId?: string };
}

/** The old name for the same props. */
export type EqxPanelProps = SidePanelProps;

/** Mock `.pf`: buttons share the row; a top edge. */
const FOOTER_SX = {
  flex: 'none', display: 'flex', gap: `${P.rowGap}px`, px: `${P.padX}px`, py: `${P.padY}px`,
  borderTop: `1px solid ${HUD.color.panelEdge}`, bgcolor: HUD.color.sidePanelBg,
} as const;

/** Apply is the primary (mock `.btn.pri`): filled cyan, dimmed and off until
 *  something changed (`.btn.off`), plain cyan while `dirty`. The amber cue for
 *  an unapplied change is on the changed EqxSegmented (`appliedValue`). */
function ApplyFooter({ apply }: { apply: EqxPanelApply }): JSX.Element {
  return (
    <Box sx={FOOTER_SX} data-testid="eqx-panel-footer" data-dirty={apply.dirty ? '1' : '0'}>
      {apply.secondary !== undefined && (
        <EqxButton fullWidth onClick={apply.secondary.onClick} data-testid={apply.secondary.testId}>
          {apply.secondary.label}
        </EqxButton>
      )}
      <EqxButton fullWidth onClick={apply.onApply} tone="primary" disabled={!apply.dirty}
        data-testid="eqx-panel-apply">{apply.label ?? 'Apply'}</EqxButton>
    </Box>
  );
}

export function EqxPanel({
  open, onClose, testId, handleTestId, size = SECTOR_PANEL_SIZE, closeOnEscape = false, paperAttrs, children,
  title, headerTestId, closeTestId, onBack, apply, body = 'padded',
}: SidePanelProps): JSX.Element {
  const dock = useSidePanelDock();
  const centred = size.centred === true;
  // A centred strip always docks right; it never becomes the bottom sheet.
  const anchor: FocusPanelDock = centred ? 'right' : dock;
  const touch = isTouchDevice();
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
      p.style.transition = `transform ${HUD.motion.snapBackMs}ms ease`;
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
  const header = (
    <Box sx={HEAD_SX} data-testid={headerTestId}>
      {onBack !== undefined && <Box component="button" type="button" sx={HEAD_BTN_SX}
        onClick={onBack} aria-label="Back" data-testid="eqx-panel-back">←</Box>}
      <Box sx={GRAB_TITLE_SX} onPointerDown={onHandleDown} onPointerMove={onHandleMove}
        onPointerUp={onHandleUp} onPointerCancel={onHandleCancel} data-testid={handleTestId} aria-label="Drag to close">
        {title}
      </Box>
      <Box component="button" type="button" sx={HEAD_BTN_SX} onClick={onClose}
        aria-label="Close" data-testid={closeTestId}>✕</Box>
    </Box>
  );

  const footer = apply !== undefined ? <ApplyFooter apply={apply} /> : null;
  const bodyBox = <Box sx={body === 'bare' ? BODY_BARE_SX : BODY_PADDED_SX} data-testid="eqx-panel-body">{children}</Box>;

  return (
    // Portal to <body> so the panel escapes the host chrome / GameSurface
    // stacking traps: its Paper z (Z.panel) then lives at the body level, ABOVE
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
        sx: anchor === 'bottom' ? PAPER_BOTTOM : rightPaperSx(size, touch),
        ...paperAttrs,
      }}
    >
      {centred && children}
      {!centred && title !== undefined && (
        <>
          {header}
          {bodyBox}
          {footer}
        </>
      )}
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
      {!centred && title === undefined && footer}
    </Drawer>
    </Portal>
  );
}

/** The old name: the same component (src/client/components/SidePanel.tsx re-exports it). */
export const SidePanel = EqxPanel;
