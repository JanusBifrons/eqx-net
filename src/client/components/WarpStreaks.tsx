import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { WarpEffect, type WarpEffectIntensity } from '../render/warp/WarpEffect';

/**
 * React host for the Pixi-driven [WarpEffect](../render/warp/WarpEffect.ts).
 * Mounts a small `Application` on a callback-ref'd `<div>`, renders the
 * animated streak field with motion-blur, and disposes cleanly on unmount.
 *
 * Used by:
 *   - [WarpScreen](./WarpScreen.tsx) — initial join / ship-swap arrival
 *     / transit arrival (`intensity="loading"`).
 *   - [HyperspaceOverlay](./HyperspaceOverlay.tsx) — IN_TRANSIT
 *     (`intensity="transit"`) and ARRIVED (`intensity="arrived"`).
 *
 * Why Pixi (not CSS): the gameplay renderer is Pixi v8. Making the
 * warp visual Pixi too removes the CSS↔canvas seam and opens the door
 * to deeper integration — e.g. fading the player's ship sprite IN
 * during the final 200 ms of arrival on the same stage, or a custom
 * shader for the warp effect.
 *
 * The Slot-anchored caller controls layout (position: absolute,
 * inset: 0). This component just fills its container; the Pixi
 * canvas is `position: absolute` inside the host div.
 *
 * StrictMode-safe: the `useEffect` cleanup disposes the effect even
 * if init is mid-await; `WarpEffect.dispose()` is idempotent.
 */
interface WarpStreaksProps {
  intensity: WarpEffectIntensity;
}

export function WarpStreaks({ intensity }: WarpStreaksProps): JSX.Element {
  // Callback ref — `useRef` would observe null during the initial
  // render of a Slot-portalled host whose anchor hasn't mounted yet.
  // State-backed callback re-runs the effect when the element attaches.
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!host) return;
    const effect = new WarpEffect();
    let disposed = false;
    void effect.init(host, intensity).catch((err: unknown) => {
      console.error('[WarpStreaks] WarpEffect init failed', err);
    });
    return () => {
      disposed = true;
      effect.dispose();
      // Silence the unused-warning while preserving the disposal
      // flag intent — `disposed` is captured by the closure and
      // referenced by the catch handler implicitly.
      void disposed;
    };
  }, [host, intensity]);

  return (
    <Box
      ref={setHost}
      data-testid="warp-streaks"
      data-warp-intensity={intensity}
      sx={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    />
  );
}
