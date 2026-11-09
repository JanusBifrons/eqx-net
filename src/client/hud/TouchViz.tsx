/**
 * Touch visualiser for screen recordings (`?touchviz=1`, exp/hud-mobile-first).
 *
 * Draws a translucent finger dot under every active pointer, so a recorded
 * HUD demo shows where the thumbs are. Mouse pointers get a small hover dot
 * that swells to finger size while a button is held (a screencast shows no
 * cursor otherwise).
 *
 * Deliberately OUTSIDE the Slot/anchor system and the Z tokens: it is a
 * recording overlay that must sit above everything (including portalled
 * drawers), never takes input (`pointer-events: none`) and is off unless the
 * URL asks for it. Portalled to `document.body` so no ancestor stacking
 * context can trap it.
 *
 * Hot path: window capture listeners (passive) write `transform` / `opacity`
 * on pooled dot elements keyed by pointerId — no React state, no per-event
 * allocation.
 */
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

const FINGER_PX = 44;
const MOUSE_PX = 14;

function enabledFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('touchviz') === '1';
}

/** Read once: toggling needs a reload (same as the HUD variant switch). */
const ENABLED = enabledFromUrl();

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 2147483000,
  overflow: 'hidden',
  contain: 'strict',
};

const DOT_CSS =
  'position:absolute;left:0;top:0;border-radius:50%;pointer-events:none;will-change:transform,opacity;' +
  `width:${FINGER_PX}px;height:${FINGER_PX}px;margin:${-FINGER_PX / 2}px 0 0 ${-FINGER_PX / 2}px;` +
  'background:radial-gradient(circle,rgba(255,255,255,0.42) 0%,rgba(255,255,255,0.32) 55%,rgba(255,255,255,0.12) 72%,rgba(255,255,255,0) 74%);' +
  'box-shadow:0 0 0 2px rgba(255,255,255,0.35),0 0 14px 2px rgba(255,255,255,0.18);' +
  'opacity:0;transition:opacity 140ms ease-out;';

interface Dot {
  el: HTMLDivElement;
  mouse: boolean;
  pressed: boolean;
}

export function TouchViz(): ReactElement | null {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ENABLED) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const dots = new Map<number, Dot>();
    const pool: HTMLDivElement[] = [];

    const acquire = (): HTMLDivElement => {
      const el = pool.pop() ?? document.createElement('div');
      if (!el.style.cssText) el.style.cssText = DOT_CSS;
      if (!el.parentNode) root.appendChild(el);
      return el;
    };

    const place = (d: Dot, x: number, y: number): void => {
      // Mouse hover = small dot; a held button or any touch/pen = finger size.
      const k = d.mouse && !d.pressed ? MOUSE_PX / FINGER_PX : 1;
      d.el.style.transform = `translate3d(${x}px,${y}px,0) scale(${k})`;
    };

    const onDown = (e: PointerEvent): void => {
      let d = dots.get(e.pointerId);
      if (!d) {
        d = { el: acquire(), mouse: e.pointerType === 'mouse', pressed: false };
        dots.set(e.pointerId, d);
      }
      d.pressed = true;
      place(d, e.clientX, e.clientY);
      d.el.style.opacity = '1';
    };

    const onMove = (e: PointerEvent): void => {
      let d = dots.get(e.pointerId);
      if (!d) {
        // Only a mouse shows a dot without a press (the hover cursor).
        if (e.pointerType !== 'mouse') return;
        d = { el: acquire(), mouse: true, pressed: false };
        dots.set(e.pointerId, d);
      }
      place(d, e.clientX, e.clientY);
      d.el.style.opacity = d.pressed ? '1' : '0.7';
    };

    const onUp = (e: PointerEvent): void => {
      const d = dots.get(e.pointerId);
      if (!d) return;
      d.pressed = false;
      if (d.mouse && e.type === 'pointerup') {
        // The cursor stays visible as a hover dot.
        place(d, e.clientX, e.clientY);
        d.el.style.opacity = '0.7';
        return;
      }
      d.el.style.opacity = '0';
      dots.delete(e.pointerId);
      pool.push(d.el);
    };

    const onLeave = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return;
      const d = dots.get(e.pointerId);
      if (!d || d.pressed) return;
      d.el.style.opacity = '0';
      dots.delete(e.pointerId);
      pool.push(d.el);
    };

    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('pointerup', onUp, opts);
    window.addEventListener('pointercancel', onUp, opts);
    document.addEventListener('pointerleave', onLeave, opts);
    return () => {
      window.removeEventListener('pointerdown', onDown, opts);
      window.removeEventListener('pointermove', onMove, opts);
      window.removeEventListener('pointerup', onUp, opts);
      window.removeEventListener('pointercancel', onUp, opts);
      document.removeEventListener('pointerleave', onLeave, opts);
      dots.clear();
      pool.length = 0;
      root.replaceChildren();
    };
  }, []);

  if (!ENABLED || typeof document === 'undefined') return null;
  return createPortal(<div ref={rootRef} data-testid="touchviz" aria-hidden="true" style={ROOT_STYLE} />, document.body);
}
