/**
 * Galaxy map FOCUS VIEW — the pure decisions (no Pixi). Tapping a hex on the
 * full-page map eases the map camera into that sector so it fills most of the
 * screen, with its linked neighbours drawn as small "door" hexes round its rim;
 * the sector info panel docks beside it. `galaxyFocusView.ts` is the Pixi side;
 * the camera move is the existing `Camera.glideTo` (with its optional zoom).
 *
 * Everything here runs on a focus change or a tap, never per frame.
 */

/** Glide in / hop / back out duration (wall ms; UI motion, not game time). */
export const FOCUS_GLIDE_MS = 650;
/** Door centre distance from the focused hex centre, in hex radii. */
export const DOOR_RING = 1.45;
/** Door hex radius, in focused-hex radii. */
export const DOOR_SIZE = 0.3;
/** Smallest angle between two doors (rad) so their hexes never overlap. */
export const DOOR_MIN_SEP = (DOOR_SIZE * 2.3) / DOOR_RING;
/** Share of the free screen area the hex + its doors may take. */
export const FOCUS_FIT = 0.92;
/** The map camera's zoom range (`GalaxyMapLayer` builds its `Camera` with it). */
export const FOCUS_MAX_SCALE = 4;

// ── Panel dock (shared with SectorInfoDrawer so the two never disagree) ──

/** Desktop docks the info panel on the right; a phone (touch) or any portrait
 *  screen uses a bottom sheet. */
export type FocusPanelDock = 'right' | 'bottom';

export function focusPanelDock(portrait: boolean, touch: boolean): FocusPanelDock {
  return portrait || touch ? 'bottom' : 'right';
}

/** Right panel width (CSS px; never more than 92% of the screen). */
export const PANEL_RIGHT_W = 296;
/** Bottom sheet: share of the visible height (portrait, landscape) and cap. */
export const SHEET_FRAC_PORTRAIT = 0.4;
export const SHEET_FRAC_LANDSCAPE = 0.5;
export const SHEET_MAX_H = 340;
/** The app bar above the map (`--app-bar-h` fallback). */
export const APP_BAR_H = 48;

export interface ScreenInsets { top: number; right: number; bottom: number }

/** The screen strips the panel and app bar cover, for framing the focus. */
export function focusPanelInsets(dock: FocusPanelDock, screenW: number, screenH: number): ScreenInsets {
  if (dock === 'right') {
    return { top: APP_BAR_H, right: Math.min(PANEL_RIGHT_W, screenW * 0.92), bottom: 0 };
  }
  const frac = screenH >= screenW ? SHEET_FRAC_PORTRAIT : SHEET_FRAC_LANDSCAPE;
  return { top: APP_BAR_H, right: 0, bottom: Math.min(screenH * frac, SHEET_MAX_H) };
}

// ── Door layout ──

export interface DoorSlot {
  key: string;
  /** Door centre, map space (the same space as the hex centres). */
  x: number;
  y: number;
  /** Direction from the focused hex (rad). */
  angle: number;
}

/**
 * Place one door per linked neighbour on a ring round the focused hex, each in
 * the direction of that neighbour, spread apart so no two overlap. Order of
 * the result follows the angle round the ring.
 */
export function layoutDoors(
  cx: number, cy: number, hexR: number,
  neighbours: ReadonlyArray<{ key: string; x: number; y: number }>,
): DoorSlot[] {
  const slots = neighbours.map((n) => ({ key: n.key, angle: Math.atan2(n.y - cy, n.x - cx) }));
  slots.sort((a, b) => a.angle - b.angle);
  spreadAngles(slots, DOOR_MIN_SEP);
  const ring = hexR * DOOR_RING;
  return slots.map((s) => ({ key: s.key, angle: s.angle, x: cx + Math.cos(s.angle) * ring, y: cy + Math.sin(s.angle) * ring }));
}

/** Push sorted angles apart (circularly) until every gap is at least `sep`.
 *  A few relaxation passes; the ring always has room for the 6 doors a
 *  sector can have. */
function spreadAngles(slots: Array<{ angle: number }>, sep: number): void {
  const n = slots.length;
  if (n < 2) return;
  const gap = Math.min(sep, (Math.PI * 2) / n);
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = slots[i]!;
      const b = slots[(i + 1) % n]!;
      let d = b.angle - a.angle;
      if (i === n - 1) d += Math.PI * 2;
      if (d < gap - 1e-9) {
        const push = (gap - d) / 2;
        a.angle -= push;
        b.angle += push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** The door under a map-space point, or null. */
export function doorAt(doors: readonly DoorSlot[], x: number, y: number, doorR: number): string | null {
  for (const d of doors) {
    if (Math.hypot(x - d.x, y - d.y) <= doorR) return d.key;
  }
  return null;
}

// ── Framing ──

export interface FocusFrame { scale: number; cx: number; cy: number }

/**
 * The camera frame that shows the focused hex (pointy-top, radius `hexR`) and
 * its doors as large as fits in the screen area the panel leaves free, centred
 * in that area. `cx/cy` is the map point for the SCREEN centre (what
 * `Camera.glideTo` takes), so the hex lands in the middle of the free area.
 */
export function focusFrame(
  hexX: number, hexY: number, hexR: number, doors: readonly DoorSlot[],
  screenW: number, screenH: number, insets: ScreenInsets,
): FocusFrame {
  let ex = hexR * (Math.sqrt(3) / 2);
  let ey = hexR;
  const doorR = hexR * DOOR_SIZE;
  for (const d of doors) {
    ex = Math.max(ex, Math.abs(d.x - hexX) + doorR);
    ey = Math.max(ey, Math.abs(d.y - hexY) + doorR);
  }
  const freeW = Math.max(1, screenW - insets.right);
  const freeH = Math.max(1, screenH - insets.top - insets.bottom);
  const scale = Math.min(FOCUS_MAX_SCALE, FOCUS_FIT * Math.min(freeW / (2 * ex), freeH / (2 * ey)));
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

// ── Taps ──

export type FocusTap = { kind: 'select'; key: string } | { kind: 'deselect' } | { kind: 'none' };

/**
 * What a confirmed tap does. Without a focus it is the plain map (a hex
 * selects, empty space deselects). In focus a door hops to its sector, the
 * focused hex itself does nothing (its panel is already open), and anything
 * else backs out.
 */
export function focusTapResult(focusKey: string | null, doorKey: string | null, hexKey: string | null): FocusTap {
  if (focusKey === null) return hexKey !== null ? { kind: 'select', key: hexKey } : { kind: 'deselect' };
  if (doorKey !== null) return { kind: 'select', key: doorKey };
  if (hexKey === focusKey) return { kind: 'none' };
  return { kind: 'deselect' };
}
