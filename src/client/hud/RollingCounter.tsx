/**
 * Cyberpunk-2077-style credits counter (exp/hud-mobile-first).
 *
 * When the value changes:
 *  1. A short chromatic-split glitch (CSS keyframes, ~280 ms).
 *  2. The digits that are changing SCRAMBLE (random glyphs) for the first
 *     half of the roll, then the number counts to the new value with an
 *     ease-out over ~750 ms.
 *  3. A "+¢250" / "−¢80" delta pops up beside it and drifts up and fades.
 *
 * The animation writes `textContent` from its own animation loop: no React
 * render per frame, and the store is only read on change.
 */
import { memo, useEffect, useRef } from 'react';
import { HUD } from './tokens';

export function formatCredits(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
}

/**
 * Replace each digit of `shown` that differs from `target` (same index from
 * the right) with a random digit. Separators and unchanged digits are kept,
 * so the number "boils" only where it is changing. Pure given `rand`.
 */
export function scrambleChangedDigits(shown: string, target: string, rand: () => number): string {
  let out = '';
  const n = shown.length;
  for (let i = 0; i < n; i++) {
    const c = shown[i]!;
    const fromRight = n - 1 - i;
    const t = target[target.length - 1 - fromRight];
    if (c >= '0' && c <= '9' && c !== t) {
      out += String(Math.floor(rand() * 10));
    } else {
      out += c;
    }
  }
  return out;
}

const ROLL_MS = 750;
const SCRAMBLE_FRAC = 0.5;
const SCRAMBLE_EVERY_MS = 40;

const STYLE_ID = 'eqx-rolling-counter-css';
function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
@keyframes eqxGlitch {
  0%   { text-shadow: 2px 0 #ff2a6d, -2px 0 #05d9e8; transform: translateX(0) skewX(0); clip-path: inset(0 0 0 0); }
  20%  { text-shadow: -3px 0 #ff2a6d, 3px 0 #05d9e8; transform: translateX(-1px) skewX(-8deg); clip-path: inset(10% 0 45% 0); }
  40%  { text-shadow: 3px 0 #ff2a6d, -1px 0 #05d9e8; transform: translateX(2px) skewX(6deg); clip-path: inset(50% 0 5% 0); }
  60%  { text-shadow: -1px 0 #ff2a6d, 2px 0 #05d9e8; transform: translateX(-1px); clip-path: inset(0 0 0 0); }
  100% { text-shadow: 0 0 6px rgba(255,215,106,.45); transform: none; clip-path: inset(0 0 0 0); }
}
@keyframes eqxDelta {
  0%   { opacity: 0; transform: translate3d(0, 4px, 0); }
  12%  { opacity: 1; transform: translate3d(0, 0, 0); }
  70%  { opacity: 1; }
  100% { opacity: 0; transform: translate3d(0, -14px, 0); }
}
.eqx-glitch { animation: eqxGlitch 280ms steps(6, end) 1; }
.eqx-delta  { animation: eqxDelta 1300ms ease-out 1 forwards; }
`;
  document.head.appendChild(el);
}

export interface RollingCounterProps {
  value: number | null;
  /** px */
  size?: number;
  testId?: string;
}

export const RollingCounter = memo(function RollingCounter({
  value,
  size = 11,
  testId = 'hud-credits',
}: RollingCounterProps): JSX.Element | null {
  const numRef = useRef<HTMLSpanElement | null>(null);
  const deltaRef = useRef<HTMLSpanElement | null>(null);
  const shownRef = useRef<number | null>(null);
  const rafRef = useRef(0);

  useEffect(ensureStyles, []);

  useEffect(() => {
    const numEl = numRef.current;
    if (!numEl || value === null) return;
    const from = shownRef.current;
    if (from === null) {
      // First value: no roll, just show it.
      shownRef.current = value;
      numEl.textContent = formatCredits(value);
      return;
    }
    if (from === value) return;
    cancelAnimationFrame(rafRef.current);

    // Delta popup.
    const delta = value - from;
    const dEl = deltaRef.current;
    if (dEl) {
      dEl.textContent = `${delta > 0 ? '+' : '−'}¢${formatCredits(Math.abs(delta))}`;
      dEl.style.color = delta > 0 ? '#7dffb2' : HUD.color.danger;
      dEl.classList.remove('eqx-delta');
      void dEl.offsetWidth; // restart the CSS animation
      dEl.classList.add('eqx-delta');
    }
    // Glitch.
    numEl.classList.remove('eqx-glitch');
    void numEl.offsetWidth;
    numEl.classList.add('eqx-glitch');

    const target = formatCredits(value);
    const start = performance.now();
    let lastScramble = 0;
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ROLL_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = from + (value - from) * eased;
      shownRef.current = t >= 1 ? value : cur;
      let text = formatCredits(cur);
      if (t < SCRAMBLE_FRAC) {
        if (now - lastScramble > SCRAMBLE_EVERY_MS) {
          lastScramble = now;
          text = scrambleChangedDigits(text, target, Math.random);
          numEl.textContent = text;
        }
      } else {
        numEl.textContent = t >= 1 ? target : text;
      }
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);

  if (value === null) return null;
  return (
    <span
      data-testid={testId}
      data-wallet={value}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 3,
        color: HUD.color.credits,
        fontFamily: HUD.font.num,
        fontSize: size,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: 0.3,
        whiteSpace: 'nowrap',
        textShadow: '0 0 6px rgba(255,215,106,.45)',
        pointerEvents: 'none',
      }}
    >
      <span style={{ fontFamily: HUD.font.label, opacity: 0.85 }}>¢</span>
      <span ref={numRef} style={{ display: 'inline-block' }} />
      <span
        ref={deltaRef}
        style={{
          position: 'absolute',
          left: '100%',
          top: -2,
          marginLeft: 6,
          fontSize: Math.round(size * 0.9),
          opacity: 0,
          whiteSpace: 'nowrap',
          textShadow: '0 0 6px rgba(0,0,0,.8)',
        }}
      />
    </span>
  );
});
