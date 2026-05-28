/**
 * Circular cooldown progress ring for the mobile fire button.
 *
 * Reads `lastFireMs` + `activeWeapon` from Zustand. On each RAF, computes
 * elapsed-since-fire as a fraction of the active weapon's cooldown and
 * sets a CSS variable that drives an SVG arc — no React re-render per
 * frame (subscribes only to the two discrete fields).
 *
 * Conic gradient was tempted but SVG gives crisper edges at small radii
 * and lets us animate via `stroke-dashoffset` which Pixi-native devices
 * handle without compositor churn.
 *
 * The ring **drains** as cooldown elapses: full ring at fire time
 * (= "busy, wait"), empty ring at cooldown end (= "ready, fire again").
 * Matches the user's mental model of "loading bar that fills" inverted —
 * tested both directions during design and "draining" reads as more
 * urgent ("see the wait shrinking") than "filling" ("when does it stop
 * filling? oh now it's ready").
 *
 * Hidden when no fire has happened yet (`lastFireMs === null`) and when
 * the ring would render at 0 % (cooldown elapsed) — keeps the button
 * uncluttered in the idle / ready state.
 */
import { useEffect, useRef } from 'react';
import { useUIStore } from '../state/store';
import { getWeapon } from '../../core/combat/WeaponCatalogue';

const SIZE = 84;          // px — slightly larger than the 76 px fire button so the ring sits OUTSIDE
const STROKE = 3;         // ring stroke width
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function FireCooldownRing(): JSX.Element | null {
  const lastFireMs = useUIStore((s) => s.lastFireMs);
  const activeWeapon = useUIStore((s) => s.activeWeapon);
  const ringRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => {
    if (lastFireMs === null) return;
    const cooldownTicks = getWeapon(activeWeapon).cooldownTicks;
    const cooldownMs = (cooldownTicks * 1000) / 60;
    if (cooldownMs <= 0) return;
    let rafId = 0;
    const tick = (): void => {
      const elapsed = performance.now() - lastFireMs;
      const remaining = Math.max(0, 1 - elapsed / cooldownMs);
      const ring = ringRef.current;
      if (ring) {
        // stroke-dashoffset 0 ⇒ full circle visible; CIRCUMFERENCE ⇒ empty.
        // remaining=1 (just fired) → offset=0 (full ring); remaining=0
        // (ready) → offset=CIRCUMFERENCE (no ring).
        ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - remaining));
        // Fade out the wrapper when fully drained so it doesn't intercept
        // visual attention while ready-to-fire.
        const wrapper = ring.parentElement?.parentElement as HTMLElement | null;
        if (wrapper) wrapper.style.opacity = remaining > 0.01 ? '1' : '0';
      }
      if (remaining > 0) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [lastFireMs, activeWeapon]);

  // First render before any fire: render nothing (the wrapper would
  // otherwise paint at full ring with no animation).
  if (lastFireMs === null) return null;

  return (
    <div
      data-testid="fire-cooldown-ring"
      style={{
        position: 'absolute',
        inset: '50%',
        width: SIZE,
        height: SIZE,
        marginLeft: -SIZE / 2,
        marginTop: -SIZE / 2,
        pointerEvents: 'none',
        transition: 'opacity 120ms linear',
      }}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle
          ref={ringRef}
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="rgba(0, 255, 136, 0.75)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={0}
          // Rotate so the dash starts at 12 o'clock and drains clockwise.
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
    </div>
  );
}
