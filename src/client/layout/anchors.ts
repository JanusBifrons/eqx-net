import type { CSSProperties } from 'react';
import { Z } from './zIndex';
import { RAIL_W_CSS } from './railWidth';

/**
 * Named slot anchors. A 3x3 corner/edge/center grid plus specials, and the
 * right rail / left strip of the UI language (plan B2).
 *
 * The layout host renders one fixed-position div per anchor inside
 * `LayoutProvider`; widgets register into an anchor via `<Slot anchor=...>`.
 *
 * Hosts default to `pointer-events: none` so empty regions pass clicks
 * through to the Pixi canvas underneath. Each `<Slot>` re-enables
 * `pointer-events: auto` on its own wrapper.
 */
export type AnchorName =
  | 'top-left'
  | 'top-center'
  | 'top-center-prompt'
  | 'top-right'
  | 'middle-left'
  | 'middle-left-over'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'fullscreen'
  | 'transit'
  | 'rotate'
  | 'right-rail'
  | 'left-strip'
  | 'left-column';

export const ANCHOR_NAMES: readonly AnchorName[] = [
  'top-left',
  'top-center',
  'top-center-prompt',
  'top-right',
  'middle-left',
  'middle-left-over',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'fullscreen',
  'transit',
  'rotate',
  'right-rail',
  'left-strip',
  'left-column',
] as const;

// The game has no top bar (UI plan U5-3): anchors start under the safe area only.
const SAFE_TOP = 'calc(env(safe-area-inset-top, 0px) + 16px)';
const SAFE_BOTTOM = 'calc(env(safe-area-inset-bottom, 0px) + 16px)';
const SAFE_LEFT = 'calc(env(safe-area-inset-left, 0px) + 16px)';
// Right-edge HUD sits in by the right rail (`--rail-w`, 0px until it mounts).
export const SAFE_RIGHT = `calc(env(safe-area-inset-right, 0px) + ${RAIL_W_CSS} + 16px)`;
// Top of the full-height edge anchors: under the safe area.
const EDGE_TOP = 'env(safe-area-inset-top, 0px)';

// Joystick / fire / boost — driven by --mobile-edge-inset (defined in
// index.html) so a single landscape-on-touch media query kicks all three
// further from the bezel without touching the typed CSSProperties map.
const THUMB_BOTTOM = 'calc(env(safe-area-inset-bottom, 0px) + var(--mobile-edge-inset, 16px))';
const THUMB_LEFT   = 'calc(env(safe-area-inset-left, 0px) + var(--mobile-edge-inset, 16px))';
const THUMB_RIGHT  = `calc(env(safe-area-inset-right, 0px) + ${RAIL_W_CSS} + var(--mobile-edge-inset, 16px))`;

const STACK_GAP = 8;

/**
 * Per-anchor host styles. Each anchor host is `position: fixed` so it sits
 * on top of the Pixi canvas regardless of which container it's rendered in.
 *
 * Stacking direction:
 *   - top-* and middle-*: column (children grow downward)
 *   - bottom-*: column-reverse (children grow upward, away from joystick/fire)
 *   - bottom-right: row-reverse (fire stays rightmost when boost is added)
 *
 * Center anchors translate themselves to the centre point so children just
 * stack naturally.
 */
export const ANCHOR_STYLES: Record<AnchorName, CSSProperties> = {
  'top-left': {
    position: 'fixed',
    top: SAFE_TOP,
    left: SAFE_LEFT,
    zIndex: Z.hud,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  'top-center': {
    position: 'fixed',
    top: SAFE_TOP,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: Z.mobileControls,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  // The answer-me prompts and toasts (EqxPrompt, plan A6): top centre, just
  // under the top-centre HUD column (`--hud-tc-bottom`, measured by
  // layout/topCenterPromptFit.ts), on `Z.prompt` so a Window never hides them.
  'top-center-prompt': {
    position: 'fixed',
    top: `max(${SAFE_TOP}, calc(var(--hud-tc-bottom, 0px) + ${STACK_GAP}px))`,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: Z.prompt,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  'top-right': {
    position: 'fixed',
    top: SAFE_TOP,
    right: SAFE_RIGHT,
    zIndex: Z.hud,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  // Beside the left strip while it shows (`--left-strip-w`, layout/leftStripFit.ts),
  // so the warp spool bar's Abort is never under the strip's ✕.
  'middle-left': {
    position: 'fixed',
    top: '50%',
    left: `max(${SAFE_LEFT}, var(--left-strip-w, 0px))`,
    transform: 'translateY(-50%)',
    zIndex: Z.hud,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  // Same place as `middle-left`, but drawn over the left strip and rail
  // (`Z.overStrip`): the warp spool bar must never sit under the strip
  // (owner 2026-11-22). The strip itself is untouched.
  'middle-left-over': {
    position: 'fixed',
    top: '50%',
    left: `max(${SAFE_LEFT}, var(--left-strip-w, 0px))`,
    transform: 'translateY(-50%)',
    zIndex: Z.overStrip,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  'middle-center': {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: Z.hud,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  'middle-right': {
    position: 'fixed',
    top: '50%',
    right: SAFE_RIGHT,
    transform: 'translateY(-50%)',
    zIndex: Z.hud,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  'bottom-left': {
    position: 'fixed',
    bottom: THUMB_BOTTOM,
    left: THUMB_LEFT,
    zIndex: Z.mobileControls,
    display: 'flex',
    flexDirection: 'column-reverse',
    alignItems: 'flex-start',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  'bottom-center': {
    position: 'fixed',
    bottom: SAFE_BOTTOM,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: Z.hudOverSticks,
    display: 'flex',
    flexDirection: 'column-reverse',
    alignItems: 'center',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  'bottom-right': {
    position: 'fixed',
    bottom: THUMB_BOTTOM,
    right: THUMB_RIGHT,
    zIndex: Z.mobileControls,
    display: 'flex',
    flexDirection: 'row-reverse',
    alignItems: 'flex-end',
    gap: 18,
    pointerEvents: 'none',
  },
  fullscreen: {
    position: 'fixed',
    inset: 0,
    zIndex: Z.overlay,
    pointerEvents: 'none',
  },
  transit: {
    position: 'fixed',
    inset: 0,
    zIndex: Z.transit,
    pointerEvents: 'none',
  },
  // Turn-your-phone-sideways picture (RotatePhoneOverlay): over everything
  // but the lost-connection and error overlays.
  rotate: {
    position: 'fixed',
    inset: 0,
    zIndex: Z.rotatePrompt,
    pointerEvents: 'none',
  },
  // Right rail (plan B2): flush to the right edge, full height below the safe
  // top, `--rail-w` wide (0 until U1-5 mounts the rail and sets it).
  'right-rail': {
    position: 'fixed',
    top: EDGE_TOP,
    right: 'env(safe-area-inset-right, 0px)',
    bottom: 'env(safe-area-inset-bottom, 0px)',
    width: RAIL_W_CSS,
    zIndex: Z.railStrip,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    pointerEvents: 'none',
  },
  // Left strip (plan B2): left edge, centred at 57% of the height (the approved
  // EqxLayout composition, mock .lbar), clear of the Fly contacts tab (left
  // edge, top 30%). A tall strip never rises over the top-left HUD: its top is
  // at least 8px under it (vars measured by layout/leftStripFit.ts).
  'left-strip': {
    position: 'fixed',
    top: 'max(calc(var(--hud-tl-bottom, 0px) + 8px), calc(57% - var(--left-strip-h, 0px) / 2))',
    // Flush with the screen edge: the strip's own background covers the camera
    // band (safe-area-inset-left) and only its buttons step clear of it (EqxStrip).
    left: 0,
    // Scaled down only when taller than the room under the HUD (leftStripFit.ts).
    transform: 'scale(var(--left-strip-scale, 1))',
    transformOrigin: 'top left',
    zIndex: Z.railStrip,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
  // The who-hex column (selection HUD S5): as high and far left as it can go,
  // 8px under the whole top-left HUD (sector chip, mode switch, cargo chip,
  // alert; `--hud-tl-bottom`) and in line with it (SAFE_LEFT). Scaled down
  // only when taller than the room under the HUD (leftStripFit.ts).
  'left-column': {
    position: 'fixed',
    top: `calc(var(--hud-tl-bottom, 0px) + ${STACK_GAP}px)`,
    left: SAFE_LEFT,
    transform: 'scale(var(--left-column-scale, 1))',
    transformOrigin: 'top left',
    zIndex: Z.railStrip,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: STACK_GAP,
    pointerEvents: 'none',
  },
};
