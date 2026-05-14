import { useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { Slot } from '../layout/Slot';
import { WarpStreaks } from './WarpStreaks';

/**
 * Unified room-loading overlay. Covers the full screen during every
 * entry into game phase so the player never sees the (0, 0)-ship-then-
 * snap intermediate state described in the 2026-05-14 smoke test.
 *
 * Visible when:
 *   - phase === 'connecting'                  (in-game ship swap window)
 *   - phase === 'game' && !gameReady          (initial join / transit /
 *                                              ship-swap arrival)
 *
 * The four readiness sub-flags drive an in-game-language status caption
 * so the player sees WHAT we're waiting on, not just an empty spinner:
 *
 *   ESTABLISHING SUBSPACE LINK   — WS not connected yet
 *   AWAITING NAVIGATION FIX      — connected but no welcome
 *   SYNCING SECTOR TELEMETRY     — welcomed but no first snapshot
 *   INITIALISING DISPLAY         — snapshot received but renderer hasn't
 *                                   painted with the local ship yet
 *
 * Elapsed timer (`T+X.Xs`) ticks at ~10 Hz via rAF + a `<span>` ref
 * write — no React re-renders for the digit changes. Resets on each
 * mount (i.e., each entry into the overlay-visible window).
 *
 * Auto-fade: 200 ms opacity transition when conditions flip to ready,
 * so the canvas-reveal feels smooth rather than a hard cut.
 */
export function WarpScreen(): JSX.Element | null {
  // Subscribe to each sub-flag individually so the status caption
  // refreshes as gates flip green.
  const phase = useUIStore((s) => s.phase);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const localShipInstanceId = useUIStore((s) => s.localShipInstanceId);
  const firstSnapshotApplied = useUIStore((s) => s.firstSnapshotApplied);
  const rendererFirstFrameRendered = useUIStore((s) => s.rendererFirstFrameRendered);

  const isConnecting = phase === 'connecting';
  // Mirrors `useGameReady` in state/store.ts — kept inline so the
  // status caption below can drive off the SAME sub-flag chain that
  // determines visibility. `firstSnapshotApplied` is part of the
  // status-caption progression but NOT part of the visibility gate
  // (see useGameReady doc — idle sectors don't broadcast snapshots).
  const ready =
    connectionStatus === 'connected'
    && localShipInstanceId !== null
    && rendererFirstFrameRendered;
  const inGameNotReady = phase === 'game' && !ready;
  const visible = isConnecting || inGameNotReady;

  // Status text driven off the first NOT-ready sub-flag (top to bottom
  // chain). Mirrors the `useGameReady` gate — we deliberately do NOT
  // include `firstSnapshotApplied` here because idle sectors don't
  // broadcast snapshots on a freshly-spawned stationary ship; the
  // gate would never advance past "SYNCING SECTOR TELEMETRY" until
  // the player touched the joystick. The three gates that DO advance
  // deterministically are: connection, welcome, first paint.
  let statusText: string;
  if (connectionStatus !== 'connected') {
    statusText = 'ESTABLISHING SUBSPACE LINK';
  } else if (localShipInstanceId === null) {
    statusText = 'AWAITING NAVIGATION FIX';
  } else if (!rendererFirstFrameRendered) {
    statusText = 'INITIALISING DISPLAY';
  } else {
    statusText = 'WARP COMPLETE';
  }
  // `firstSnapshotApplied` is still read so the linter doesn't complain
  // about the unused subscription; the flag is kept around as a
  // separate sub-flag for diagnostic captures (`local_pose_resolved`
  // event correlates with it) but doesn't affect the rendered status.
  void firstSnapshotApplied;

  // Elapsed timer. Reset on every mount (every entry into the
  // overlay-visible window). Updates the `<span>` textContent directly
  // via rAF to avoid React re-renders during the loading window.
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

  // Mount the slot whenever phase is game OR connecting so the auto-
  // fade can animate opacity even after `ready` flips. The slot still
  // renders nothing if neither condition matches (e.g. meta / auth /
  // galaxy-map phases never produce a warp screen).
  if (phase !== 'game' && phase !== 'connecting') return null;

  return (
    <Slot anchor="fullscreen" pointerEvents={visible ? 'auto' : 'none'}>
      <Box
        data-testid="warp-screen"
        data-warp-visible={visible ? '1' : '0'}
        sx={{
          position: 'absolute',
          inset: 0,
          bgcolor: '#05070f',
          // When hidden, both this Box AND the Slot wrapper above
          // (passed via the Slot's `pointerEvents` prop) must let
          // taps fall through — the Slot wrapper covers the entire
          // viewport for full-screen anchors and would otherwise
          // intercept every click before it reaches the gameplay
          // canvas / HUD beneath.
          pointerEvents: visible ? 'auto' : 'none',
          opacity: visible ? 1 : 0,
          transition: 'opacity 200ms ease-out',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
        }}
      >
        <WarpStreaks intensity="loading" />
        {/* Status + timer cluster — z-index above streaks via DOM order
            (streaks are first child, status is sibling that paints
            later). */}
        <Box
          sx={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0.75,
            px: 2,
            py: 1.5,
          }}
        >
          <Typography
            data-testid="warp-screen-status"
            sx={{
              color: '#00ff88',
              fontFamily: 'ui-monospace, "Roboto Mono", monospace',
              fontSize: 12,
              letterSpacing: 3,
              textTransform: 'uppercase',
              textShadow: '0 0 8px rgba(0, 255, 136, 0.45)',
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
              fontSize: 10,
              letterSpacing: 1,
              minHeight: 12,
            }}
          >
            T+0.0s
          </Typography>
        </Box>
      </Box>
    </Slot>
  );
}
