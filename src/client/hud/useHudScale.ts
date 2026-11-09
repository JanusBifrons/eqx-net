import { useEffect, useState } from 'react';

/**
 * HUD size class keyed on the screen's SHORT side and pointer type — not the
 * MUI `sm` width breakpoint. A landscape phone is 844 px wide, so width-based
 * breakpoints handed it desktop-sized cards (the "sector panel eats the
 * screen" bug). The short side is what actually limits a phone.
 *
 *  - `phone`  : coarse pointer and short side < 500 px
 *  - `tablet` : coarse pointer, bigger
 *  - `desk`   : fine pointer (mouse)
 */
export type HudSize = 'phone' | 'tablet' | 'desk';

export function hudSizeFor(width: number, height: number, coarse: boolean): HudSize {
  if (!coarse) return 'desk';
  return Math.min(width, height) < 500 ? 'phone' : 'tablet';
}

function read(): HudSize {
  if (typeof window === 'undefined') return 'desk';
  const coarse =
    window.matchMedia?.('(pointer: coarse)').matches === true || navigator.maxTouchPoints > 0;
  return hudSizeFor(window.innerWidth, window.innerHeight, coarse);
}

export function useHudSize(): HudSize {
  const [size, setSize] = useState<HudSize>(read);
  useEffect(() => {
    const on = (): void => setSize(read());
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);
  return size;
}

/** Scale multiplier for HUD dimensions: phones stay tiny, desktop roomier. */
export function hudScale(size: HudSize): number {
  return size === 'phone' ? 1 : size === 'tablet' ? 1.2 : 1.35;
}
