import { useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { Slot } from '../layout/Slot';

/**
 * Thin in-game-language HUD over the warping Pixi canvas. NOT an
 * overlay screen — the warp visual itself is a render state of the
 * gameplay `PixiRenderer` (`setWarpMode(true)`), painted on the same
 * canvas as gameplay. This component just adds a small status
 * caption + elapsed-time readout on top of that, transparent
 * everywhere except for the text.
 *
 * Visible when:
 *   - phase === 'connecting'                  (in-game ship swap window)
 *   - phase === 'game' && !gameReady          (initial join / transit /
 *                                              ship-swap arrival)
 *
 * Status text drives off the three readiness sub-flags so the player
 * sees which gate is open / closed:
 *
 *   ESTABLISHING SUBSPACE LINK   — WS not connected yet
 *   AWAITING NAVIGATION FIX      — connected but no welcome
 *   INITIALISING DISPLAY         — welcomed but renderer hasn't
 *                                   painted with the local ship yet
 *   WARP COMPLETE                — all gates clear (during 200 ms
 *                                   fade-out before unmount)
 *
 * The elapsed timer (`T+X.Xs`) ticks at rAF via `<span>.textContent`
 * write — no React re-renders for the digit changes. Resets on each
 * mount.
 */
export function WarpScreen(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const localShipInstanceId = useUIStore((s) => s.localShipInstanceId);
  const firstSnapshotApplied = useUIStore((s) => s.firstSnapshotApplied);
  const rendererFirstFrameRendered = useUIStore((s) => s.rendererFirstFrameRendered);

  const joinMinimumElapsed = useUIStore((s) => s.joinMinimumElapsed);
  const isConnecting = phase === 'connecting';
  // Mirrors `useGameReady` — all four gates must be true.
  const ready =
    connectionStatus === 'connected'
    && localShipInstanceId !== null
    && rendererFirstFrameRendered
    && joinMinimumElapsed;
  const inGameNotReady = phase === 'game' && !ready;
  const visible = isConnecting || inGameNotReady;

  // Status text follows the ordered readiness chain — first NOT-ready
  // sub-flag wins. The 5 s minimum-display floor surfaces as
  // "STABILISING TRAJECTORY" while the reconciler settles below the
  // warp visual.
  let statusText: string;
  if (connectionStatus !== 'connected') {
    statusText = 'ESTABLISHING SUBSPACE LINK';
  } else if (localShipInstanceId === null) {
    statusText = 'AWAITING NAVIGATION FIX';
  } else if (!rendererFirstFrameRendered) {
    statusText = 'INITIALISING DISPLAY';
  } else if (!joinMinimumElapsed) {
    statusText = firstSnapshotApplied
      ? 'STABILISING TRAJECTORY'
      : 'SYNCING SECTOR TELEMETRY';
  } else {
    statusText = 'WARP COMPLETE';
  }

  const timerRef = useRef<HTMLSpanElement | null>(null);
  const mountedAtRef = useRef<number>(performance.now());
  useEffect(() => {
    mountedAtRef.current = performance.now();
    let raf = 0;
    const tick = (): void => {
      const el = timerRef.current;
      if (el !== null) {
        const ms = performance.now() - mountedAtRef.current;
        el.textContent = `T+${(ms / 1000).toFixed(1)}s`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (phase !== 'game' && phase !== 'connecting') return null;

  return (
    <Slot anchor="fullscreen" pointerEvents="none">
      <Box
        data-testid="warp-screen"
        data-warp-visible={visible ? '1' : '0'}
        sx={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          opacity: visible ? 1 : 0,
          transition: 'opacity 200ms ease-out',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.75,
        }}
      >
        <Typography
          data-testid="warp-screen-status"
          sx={{
            color: '#00ff88',
            fontFamily: 'ui-monospace, "Roboto Mono", monospace',
            fontSize: 14,
            letterSpacing: 4,
            textTransform: 'uppercase',
            textShadow:
              '0 0 12px rgba(0, 255, 136, 0.65), 0 0 24px rgba(0, 255, 136, 0.35)',
          }}
        >
          {statusText}
        </Typography>
        <Typography
          component="span"
          data-testid="warp-screen-timer"
          ref={timerRef}
          sx={{
            color: '#9aa0b4',
            fontFamily: 'ui-monospace, "Roboto Mono", monospace',
            fontSize: 11,
            letterSpacing: 1,
            minHeight: 12,
            textShadow: '0 0 8px rgba(0, 0, 0, 0.6)',
          }}
        >
          T+0.0s
        </Typography>
      </Box>
    </Slot>
  );
}
