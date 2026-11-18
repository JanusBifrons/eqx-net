/**
 * Galaxy map FOCUS VIEW — the pure decisions (no Pixi). Tapping a hex on the
 * full-page map eases the map camera into that sector so it fills the height
 * of the screen space the info panel leaves free; its linked neighbours (the
 * REAL hexes round it) light up with an arrow on the shared edge, and tapping
 * one hops the focus there. `galaxyFocusView.ts` is the Pixi side; the camera
 * move is the existing `Camera.glideTo` (with its optional zoom).
 *
 * Everything here runs on a focus change or a tap, never per frame.
 */

/** Glide in / hop / back out duration (wall ms; UI motion, not game time). */
export const FOCUS_GLIDE_MS = 650;
/** Share of the free screen height (or width) the focused hex may take. */
export const FOCUS_FIT = 0.92;
/** The map camera's zoom range (`GalaxyMapLayer` builds its `Camera` with it). */
export const FOCUS_MAX_SCALE = 4;

// ── Panel dock (shared with SectorInfoDrawer so the two never disagree) ──

/** Any landscape screen (desktop or a phone held sideways) docks the info
 *  panel down the right; an upright screen uses a bottom sheet. */
export type FocusPanelDock = 'right' | 'bottom';

export function focusPanelDock(portrait: boolean): FocusPanelDock {
  return portrait ? 'bottom' : 'right';
}

/** Right panel width (CSS px). A phone gets a narrower panel: a share of the
 *  screen width, between the floor and the desktop width. */
export const PANEL_RIGHT_W = 296;
export const PANEL_TOUCH_FRAC = 0.3;
export const PANEL_TOUCH_MIN_W = 200;
/** On a phone the panel starts below the top-right toolbar (full-screen chip). */
export const PANEL_TOUCH_TOP = 56;
/** Bottom sheet (portrait): share of the visible height, and its cap. */
export const SHEET_FRAC_PORTRAIT = 0.4;
export const SHEET_MAX_H = 340;
/** The desktop app bar above the map (`--app-bar-h`; 0 on touch). */
export const APP_BAR_H = 48;

export function focusPanelWidth(screenW: number, touch: boolean): number {
  if (!touch) return Math.min(PANEL_RIGHT_W, screenW * 0.92);
  return Math.round(Math.min(PANEL_RIGHT_W, Math.max(PANEL_TOUCH_MIN_W, screenW * PANEL_TOUCH_FRAC)));
}

export interface ScreenInsets { top: number; right: number; bottom: number }

/** The screen strips the panel and app bar cover, for framing the focus. The
 *  phone panel's top gap sits under the toolbar, not over the map, so the hex
 *  keeps the full height. */
export function focusPanelInsets(dock: FocusPanelDock, screenW: number, screenH: number, touch: boolean): ScreenInsets {
  const top = touch ? 0 : APP_BAR_H;
  if (dock === 'right') return { top, right: focusPanelWidth(screenW, touch), bottom: 0 };
  return { top, right: 0, bottom: Math.min(screenH * SHEET_FRAC_PORTRAIT, SHEET_MAX_H) };
}

// ── Hop arrows ──

/** Arrow on the edge the focused hex shares with a neighbour, pointing into
 *  the neighbour: base and tip distance from the focused centre, in hex radii
 *  (the shared edge is at sqrt(3)/2), and half its width. It stays in the rim
 *  band, well clear of the neighbour's name in the middle of its hex. */
export const ARROW_BASE = 0.88;
export const ARROW_TIP = 1.02;
export const ARROW_HALF = 0.08;

/** The hop arrow's triangle (map space, flat x,y list) for a neighbour. */
export function hopArrow(cx: number, cy: number, nx: number, ny: number, hexR: number): number[] {
  const d = Math.hypot(nx - cx, ny - cy) || 1;
  const ux = (nx - cx) / d;
  const uy = (ny - cy) / d;
  const tip = hexR * ARROW_TIP;
  const base = hexR * ARROW_BASE;
  const half = hexR * ARROW_HALF;
  return [
    cx + ux * tip, cy + uy * tip,
    cx + ux * base - uy * half, cy + uy * base + ux * half,
    cx + ux * base + uy * half, cy + uy * base - ux * half,
  ];
}

// ── Framing ──

export interface FocusFrame { scale: number; cx: number; cy: number }

/**
 * The camera frame that shows the focused hex (pointy-top, radius `hexR`) as
 * large as fits in the screen area the panel leaves free, centred in that
 * area. `cx/cy` is the map point for the SCREEN centre (what
 * `Camera.glideTo` takes), so the hex lands in the middle of the free area.
 */
export function focusFrame(
  hexX: number, hexY: number, hexR: number,
  screenW: number, screenH: number, insets: ScreenInsets,
): FocusFrame {
  const freeW = Math.max(1, screenW - insets.right);
  const freeH = Math.max(1, screenH - insets.top - insets.bottom);
  const scale = Math.min(FOCUS_MAX_SCALE, FOCUS_FIT * Math.min(freeW / (Math.sqrt(3) * hexR), freeH / (2 * hexR)));
  // The free area's centre sits off the screen centre by this many px.
  const offX = screenW / 2 - freeW / 2;
  const offY = screenH / 2 - (insets.top + freeH / 2);
  return { scale, cx: hexX + offX / scale, cy: hexY + offY / scale };
}

// ── State machine ──

export type FocusPhase = 'idle' | 'in' | 'focused' | 'out';

export interface FocusState {
  readonly phase: FocusPhase;
  /** The focused sector (null while idle or backing out). */
  readonly key: string | null;
  /** The map view to return to when the focus closes. */
  readonly home: FocusFrame | null;
}

export const FOCUS_IDLE: FocusState = { phase: 'idle', key: null, home: null };

export type FocusEvent =
  | { type: 'open'; key: string; view: FocusFrame }
  | { type: 'close' }
  /** The glide finished. */
  | { type: 'arrived' }
  /** The player grabbed the map mid-glide: stop where it is. */
  | { type: 'interrupt' };

/** What the camera must do after a transition. */
export type FocusGlide = 'to-key' | 'home' | null;

export function focusStep(s: FocusState, e: FocusEvent): { state: FocusState; glide: FocusGlide } {
  switch (e.type) {
    case 'open': {
      if ((s.phase === 'in' || s.phase === 'focused') && s.key === e.key) return { state: s, glide: null };
      // From the plain map, remember where we were; a hop or a re-open while
      // backing out keeps the original view to return to.
      const home = s.phase === 'idle' ? e.view : s.home;
      return { state: { phase: 'in', key: e.key, home }, glide: 'to-key' };
    }
    case 'close':
      if (s.phase === 'idle' || s.phase === 'out') return { state: s, glide: null };
      return { state: { phase: 'out', key: null, home: s.home }, glide: 'home' };
    case 'arrived':
    case 'interrupt':
      if (s.phase === 'in') return { state: { ...s, phase: 'focused' }, glide: null };
      if (s.phase === 'out') return { state: FOCUS_IDLE, glide: null };
      return { state: s, glide: null };
  }
}

// ── Taps and hover ──

export type FocusTap = { kind: 'select'; key: string } | { kind: 'deselect' } | { kind: 'none' };

/**
 * What a confirmed tap does. Without a focus it is the plain map (a hex
 * selects, empty space deselects). In focus a lit neighbour hops to its
 * sector, the focused hex itself does nothing (its panel is already open),
 * and anything else backs out.
 */
export function focusTapResult(focusKey: string | null, neighbours: readonly string[], hexKey: string | null): FocusTap {
  if (focusKey === null) return hexKey !== null ? { kind: 'select', key: hexKey } : { kind: 'deselect' };
  if (hexKey === focusKey) return { kind: 'none' };
  if (hexKey !== null && neighbours.includes(hexKey)) return { kind: 'select', key: hexKey };
  return { kind: 'deselect' };
}

/** No hover tooltip while the camera glides, nor over the focused hex (the
 *  panel already says it all and the tooltip would cover the hex). */
export function focusHidesHover(phase: FocusPhase, focusKey: string | null, hoverKey: string): boolean {
  return phase === 'in' || phase === 'out' || (phase === 'focused' && hoverKey === focusKey);
}
