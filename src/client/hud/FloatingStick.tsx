/**
 * Floating thumbstick (exp/hud-mobile-first).
 *
 * A faint ring rests at a HOME spot. Touching anywhere inside the stick's
 * ZONE moves the ring under the finger (the "Nightfall" feel: no hunting for
 * a fixed stick); releasing glides it back home. With `floating={false}` it
 * is a fixed stick/button that only accepts touches that start on it (variant
 * C's attack button).
 *
 * Pointer Events + pointer capture, one pointerId per stick, so two sticks
 * (or a stick and a button) work as simultaneous fingers. All per-move work
 * writes CSS transforms straight to the DOM — no React render per move, no
 * allocation per move (scratch objects below).
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { clampStickOrigin, isTap, leashOrigin, stickVector, type StickVec } from './floatingStickMath';

export interface StickHome {
  /** Distance from the left edge to the ring's edge (px). Use left OR right. */
  left?: number;
  right?: number;
  /** Distance from the bottom edge to the ring's edge (px). */
  bottom: number;
}

export interface FloatingStickProps {
  /** data-testid prefix: renders `${id}-zone`, `${id}-home`, `${id}-knob`. */
  id: string;
  /** Fixed-position rectangle that accepts touches (floating mode). */
  zone: CSSProperties;
  home: StickHome;
  /** Travel radius in px (ring radius). */
  radius?: number;
  /** Knob diameter in px. */
  knob?: number;
  color: string;
  floating?: boolean;
  /** Drag-follow when the finger overruns the ring. */
  leash?: boolean;
  onStart?: () => void;
  onMove: (v: StickVec) => void;
  onEnd: (tapped: boolean) => void;
  /** Content drawn inside the knob (icon / label). */
  children?: ReactNode;
  /** Extra content drawn on the ring (e.g. a cooldown ring), centred. */
  ring?: ReactNode;
  /** Opacity of the resting stick. */
  idleOpacity?: number;
  zIndex?: number;
}

const GLIDE = 'transform 170ms cubic-bezier(.2,.8,.2,1), opacity 170ms linear';

export function FloatingStick(props: FloatingStickProps): JSX.Element {
  const {
    id,
    zone,
    home,
    radius = 52,
    knob = 46,
    color,
    floating = true,
    leash = true,
    children,
    ring,
    idleOpacity = 0.4,
    zIndex = 15,
  } = props;
  const baseRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  // Latest callbacks without re-binding listeners.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const base = baseRef.current;
    const knobEl = knobRef.current;
    if (!base || !knobEl) return;
    const zoneEl: HTMLElement | null = floating ? zoneRef.current : base;
    if (!zoneEl) return;

    const homePt = { x: 0, y: 0 };
    const origin = { x: 0, y: 0 };
    const vec: StickVec = { x: 0, y: 0, mag: 0 };
    let pointerId: number | null = null;
    let downAt = 0;
    let downX = 0;
    let downY = 0;
    let travel = 0;

    const computeHome = (): void => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      homePt.x = home.left !== undefined ? home.left + radius : w - (home.right ?? 0) - radius;
      homePt.y = h - home.bottom - radius;
    };
    const placeBase = (x: number, y: number, glide: boolean): void => {
      base.style.transition = glide ? GLIDE : 'none';
      base.style.transform = `translate3d(${x - radius}px, ${y - radius}px, 0)`;
    };
    const placeKnob = (dx: number, dy: number, glide: boolean): void => {
      knobEl.style.transition = glide ? GLIDE : 'none';
      knobEl.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    };
    const setActive = (on: boolean): void => {
      base.style.opacity = on ? '1' : String(idleOpacity);
      base.dataset.active = on ? '1' : '0';
    };

    computeHome();
    placeBase(homePt.x, homePt.y, false);
    placeKnob(0, 0, false);
    setActive(false);

    const onDown = (e: PointerEvent): void => {
      if (pointerId !== null) return;
      pointerId = e.pointerId;
      try {
        zoneEl.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events in tests can't be captured */
      }
      e.preventDefault();
      downAt = performance.now();
      downX = e.clientX;
      downY = e.clientY;
      travel = 0;
      if (floating) {
        clampStickOrigin(e.clientX, e.clientY, radius, window.innerWidth, window.innerHeight, origin);
      } else {
        origin.x = homePt.x;
        origin.y = homePt.y;
      }
      placeBase(origin.x, origin.y, false);
      setActive(true);
      cb.current.onStart?.();
      move(e.clientX, e.clientY);
    };
    const move = (px: number, py: number): void => {
      if (floating && leash && leashOrigin(origin, px, py, radius)) {
        placeBase(origin.x, origin.y, false);
      }
      stickVector(origin.x, origin.y, px, py, radius, vec);
      placeKnob(vec.x * radius, vec.y * radius, false);
      cb.current.onMove(vec);
    };
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      const t = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (t > travel) travel = t;
      move(e.clientX, e.clientY);
    };
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      const tapped = isTap(performance.now() - downAt, travel);
      placeBase(homePt.x, homePt.y, true);
      placeKnob(0, 0, true);
      setActive(false);
      vec.x = 0;
      vec.y = 0;
      vec.mag = 0;
      cb.current.onEnd(tapped);
    };
    const onResize = (): void => {
      computeHome();
      if (pointerId === null) placeBase(homePt.x, homePt.y, false);
    };

    zoneEl.addEventListener('pointerdown', onDown);
    zoneEl.addEventListener('pointermove', onMove);
    zoneEl.addEventListener('pointerup', end);
    zoneEl.addEventListener('pointercancel', end);
    zoneEl.addEventListener('lostpointercapture', end);
    window.addEventListener('resize', onResize);
    return () => {
      zoneEl.removeEventListener('pointerdown', onDown);
      zoneEl.removeEventListener('pointermove', onMove);
      zoneEl.removeEventListener('pointerup', end);
      zoneEl.removeEventListener('pointercancel', end);
      zoneEl.removeEventListener('lostpointercapture', end);
      window.removeEventListener('resize', onResize);
      if (pointerId !== null) cb.current.onEnd(false);
    };
  }, [id, floating, leash, radius, idleOpacity, home.left, home.right, home.bottom]);

  const d = radius * 2;
  return (
    <>
      {floating && (
        <div
          ref={zoneRef}
          data-stick-zone={id}
          data-testid={`${id}-zone`}
          style={{
            position: 'fixed',
            zIndex: zIndex - 1,
            touchAction: 'none',
            pointerEvents: 'auto',
            ...zone,
          }}
        />
      )}
      <div
        ref={baseRef}
        data-testid={`${id}-home`}
        data-hud-exclusion=""
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          width: d,
          height: d,
          zIndex,
          borderRadius: '50%',
          // A fixed stick IS the touch target; a floating one lets its zone
          // take the touch (the ring follows the finger, under it).
          pointerEvents: floating ? 'none' : 'auto',
          touchAction: 'none',
          border: `1.5px solid ${color}`,
          background: `radial-gradient(circle, ${color}22 0%, ${color}0d 55%, transparent 72%)`,
          boxShadow: `0 0 14px ${color}33, inset 0 0 10px ${color}22`,
          willChange: 'transform',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        {ring}
        <div
          ref={knobRef}
          data-testid={`${id}-knob`}
          style={{
            position: 'absolute',
            left: radius - knob / 2,
            top: radius - knob / 2,
            width: knob,
            height: knob,
            borderRadius: '50%',
            background: `radial-gradient(circle at 35% 30%, ${color}aa, ${color}44 60%, ${color}22)`,
            border: `1.5px solid ${color}`,
            boxShadow: `0 0 12px ${color}66`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            willChange: 'transform',
            pointerEvents: 'none',
          }}
        >
          {children}
        </div>
      </div>
    </>
  );
}
