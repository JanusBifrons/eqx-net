/**
 * Press-and-hold for a panel button: hold `holdMs` and `onHold` fires once;
 * let go or slide off early and it cancels. `onTap` (optional) runs on a
 * plain click; the click that ends a completed hold is eaten. `holding` is
 * true while the press is counting, for a progress fill. Used by the Build
 * tab's tiles (tap +1, hold +5) and the Manage tab's hold-to-deconstruct.
 * UI timing, so wall time.
 */
import { useEffect, useRef, useState } from 'react';

export interface HoldPressHandlers {
  onClick: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
}

export function useHoldPress(holdMs: number, onHold: () => void, onTap?: () => void): { holding: boolean; handlers: HoldPressHandlers } {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const latest = useRef({ onHold, onTap });
  latest.current = { onHold, onTap };
  const [holding, setHolding] = useState(false);
  const clear = (): void => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    setHolding(false);
  };
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return {
    holding,
    handlers: {
      onPointerDown: () => {
        clear();
        held.current = false;
        setHolding(true);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          held.current = true;
          setHolding(false);
          latest.current.onHold();
        }, holdMs);
      },
      onPointerUp: clear,
      onPointerLeave: clear,
      onClick: () => {
        clear();
        if (held.current) { held.current = false; return; }
        latest.current.onTap?.();
      },
    },
  };
}
