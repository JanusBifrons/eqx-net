import { Box, keyframes } from '@mui/material';

/**
 * Warp-streak background visual. CSS-only — pure
 * `background-image` + `keyframes`-animated `background-position`.
 *
 * Lives in a single component so both [HyperspaceOverlay.tsx](./HyperspaceOverlay.tsx)
 * (transit) and [WarpScreen.tsx](./WarpScreen.tsx) (initial join /
 * ship-swap / transit arrival) share the same aesthetic.
 *
 * Why CSS rather than a second Pixi `Application`: the prior Pixi
 * implementation (`src/client/render/warp/WarpEffect.ts`) added a
 * second canvas with its own rAF + BlurFilter, which on mobile
 * starved the gameplay renderer's main thread and the page became
 * unresponsive after the warp screen faded. Single-canvas integration
 * via `IRenderer.addOverlayContainer` is the future polish path; for
 * now, CSS is the safer model — zero extra GPU contention,
 * zero second canvas, and the animated streak aesthetic is
 * preserved.
 *
 * `intensity` chooses the visual weight:
 *   - `loading`  — slower, softer streaks (calmer rhythm).
 *   - `transit`  — full warp visual; used by HyperspaceOverlay
 *                  during IN_TRANSIT.
 *   - `arrived`  — radial green flash for the brief ARRIVED moment.
 */
interface WarpStreaksProps {
  intensity: 'loading' | 'transit' | 'arrived';
}

const streakMove = keyframes`
  from { background-position-x: 0; }
  to   { background-position-x: 220px; }
`;

const arrivalPulse = keyframes`
  from { opacity: 0.85; }
  to   { opacity: 0.55; }
`;

export function WarpStreaks({ intensity }: WarpStreaksProps): JSX.Element {
  if (intensity === 'arrived') {
    return (
      <Box
        data-testid="warp-streaks"
        data-warp-intensity={intensity}
        sx={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(ellipse at center, rgba(0,255,136,0.22), rgba(5,7,15,0))',
          animation: `${arrivalPulse} 800ms ease-out infinite alternate`,
        }}
      />
    );
  }

  // Loading + transit share the streak look; only density + speed vary.
  const isTransit = intensity === 'transit';
  return (
    <Box
      data-testid="warp-streaks"
      data-warp-intensity={intensity}
      sx={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        backgroundImage: isTransit
          ? 'repeating-linear-gradient(90deg, rgba(0,255,136,0) 0, rgba(0,255,136,0) 12px, rgba(0,255,136,0.22) 13px, rgba(0,255,136,0) 14px)'
          : 'repeating-linear-gradient(90deg, rgba(0,255,136,0) 0, rgba(0,255,136,0) 18px, rgba(0,255,136,0.14) 19px, rgba(0,255,136,0) 20px)',
        backgroundSize: '220px 100%',
        opacity: isTransit ? 0.85 : 0.7,
        animation: `${streakMove} ${isTransit ? '350ms' : '1100ms'} linear infinite`,
        willChange: 'background-position',
      }}
    />
  );
}
