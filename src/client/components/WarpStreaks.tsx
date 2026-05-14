import { Box } from '@mui/material';

/**
 * Warp-streak background visual. Extracted from the IN_TRANSIT branch
 * of [HyperspaceOverlay.tsx](./HyperspaceOverlay.tsx) so both transit
 * and join-loading surfaces share one aesthetic.
 *
 * `intensity` chooses the visual weight:
 *   - `loading`  — softer streaks (lower contrast, calmer); used by
 *                  WarpScreen during initial join / ship-swap / transit
 *                  arrival while the destination room loads.
 *   - `transit`  — full warp visual; used by HyperspaceOverlay during
 *                  IN_TRANSIT (player actively warping between sectors).
 *   - `arrived`  — radial green flash; used by HyperspaceOverlay's
 *                  ARRIVED state.
 *
 * Pure visual. `pointerEvents: none` so it never blocks anything that
 * mounts above. Caller wraps in `<Slot>` to pick the layout anchor +
 * z-index.
 */
interface WarpStreaksProps {
  intensity: 'loading' | 'transit' | 'arrived';
}

export function WarpStreaks({ intensity }: WarpStreaksProps): JSX.Element {
  let background: string;
  let opacity: number;
  switch (intensity) {
    case 'arrived':
      background =
        'radial-gradient(ellipse at center, rgba(0,255,136,0.22), rgba(5,7,15,0))';
      opacity = 0.65;
      break;
    case 'transit':
      background =
        'repeating-linear-gradient(90deg, rgba(0,255,136,0.0) 0, rgba(0,255,136,0.0) 12px, rgba(0,255,136,0.18) 13px, rgba(0,255,136,0.0) 14px)';
      opacity = 0.85;
      break;
    case 'loading':
    default:
      // Slightly softer streaks for the room-loading case. The player
      // isn't supposed to feel "in motion" — they're waiting for the
      // sector to render. Lower alpha + slower visual rhythm.
      background =
        'repeating-linear-gradient(90deg, rgba(0,255,136,0.0) 0, rgba(0,255,136,0.0) 16px, rgba(0,255,136,0.10) 17px, rgba(0,255,136,0.0) 18px)';
      opacity = 0.70;
      break;
  }
  return (
    <Box
      data-testid="warp-streaks"
      data-warp-intensity={intensity}
      sx={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background,
        opacity,
        transition: 'opacity 400ms, background 400ms',
      }}
    />
  );
}
