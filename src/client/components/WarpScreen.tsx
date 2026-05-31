import { useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import { useIsLoadingActive, useUIStore } from '../state/store';
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
 *
 * Allocation discipline (plan: melodic-engelbart Step 4):
 * - The RAF tick allocates a string ONLY when `pct` changes (clamped
 *   to int) — at 60 Hz over the 5 s warp window that's ≤ 101 strings,
 *   not 300+ identical "WARP STABILISATION 100%" allocations.
 * - The RAF SELF-TERMINATES once `pct` reaches 100 — without this the
 *   component stays mounted during steady-state gameplay (returns null
 *   only on phase change, useEffect cleanup never fires while alive)
 *   and the loop runs forever, allocating + setting the same text every
 *   frame. Surfaced by the hostile CDP profile as rank-2 / 28 KB.
 * - `sx={{...}}` literals are HOISTED to module-level constants below
 *   so the React render path doesn't reconstruct + diff them each pass.
 *   The one dynamic property (`opacity`) is composed at render time via
 *   a tiny inline `{ ...staticSx, opacity }` so the rest of the object
 *   tree is reused.
 */

// Static sx objects — module-level so each render reuses the same
// reference. The MUI styled-component machinery short-circuits diffing
// when the sx ref is unchanged.
const BOX_SX_STATIC = {
  position: 'absolute' as const,
  inset: 0,
  pointerEvents: 'none' as const,
  transition: 'opacity 200ms ease-out',
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  gap: 0.75,
};
const STATUS_SX = {
  color: '#00ff88',
  fontFamily: 'ui-monospace, "Roboto Mono", monospace',
  fontSize: 14,
  letterSpacing: 4,
  textTransform: 'uppercase' as const,
  textShadow:
    '0 0 12px rgba(0, 255, 136, 0.65), 0 0 24px rgba(0, 255, 136, 0.35)',
};
const TIMER_SX = {
  color: '#9aa0b4',
  fontFamily: 'ui-monospace, "Roboto Mono", monospace',
  fontSize: 11,
  letterSpacing: 2,
  minHeight: 12,
  textShadow: '0 0 8px rgba(0, 0, 0, 0.6)',
};
// Pre-cache the two opacity-bearing variants so the most-common render
// path (opacity 0 in steady state, opacity 1 during warp) reuses a
// stable sx ref instead of allocating per-render.
const BOX_SX_HIDDEN = { ...BOX_SX_STATIC, opacity: 0 };
const BOX_SX_VISIBLE = { ...BOX_SX_STATIC, opacity: 1 };

export function WarpScreen(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const localShipInstanceId = useUIStore((s) => s.localShipInstanceId);
  const firstSnapshotApplied = useUIStore((s) => s.firstSnapshotApplied);
  const rendererFirstFrameRendered = useUIStore((s) => s.rendererFirstFrameRendered);

  const joinMinimumElapsed = useUIStore((s) => s.joinMinimumElapsed);
  // Plan: crispy-kazoo Commit 1 — single source of truth is now
  // `useIsLoadingActive()` (which delegates to `computeGameReadyFromState`
  // and honours the `?loading=cosmetic` kill switch). Behaviour-equal
  // to the old `isConnecting || (phase==='game' && !useGameReady())`
  // composition; switching here so Commit 2's handshake gates land in
  // one place. The individual sub-flag selectors above stay — the
  // status text below still reports WHICH gate is still open.
  const visible = useIsLoadingActive();

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

  const progressRef = useRef<HTMLSpanElement | null>(null);
  const mountedAtRef = useRef<number>(performance.now());
  const lastPctRef = useRef<number>(-1);
  useEffect(() => {
    mountedAtRef.current = performance.now();
    lastPctRef.current = -1;
    let raf = 0;
    const tick = (): void => {
      const el = progressRef.current;
      if (el !== null) {
        const ms = performance.now() - mountedAtRef.current;
        const pct = Math.min(100, Math.round((ms / 5000) * 100));
        // Only allocate + write when pct actually changes — at 60 Hz
        // most adjacent frames share the same int.
        if (pct !== lastPctRef.current) {
          lastPctRef.current = pct;
          el.textContent = `WARP STABILISATION ${pct}%`;
        }
      }
      // Self-terminate at 100 % — the visual job is done and the
      // component may stay mounted indefinitely during gameplay (its
      // useEffect cleanup only fires on actual unmount). Without this
      // the loop runs forever allocating a stale template literal.
      if (lastPctRef.current < 100) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);

  if (phase !== 'game' && phase !== 'connecting') return null;

  return (
    <Slot anchor="fullscreen" pointerEvents="none">
      <Box
        data-testid="warp-screen"
        data-warp-visible={visible ? '1' : '0'}
        sx={visible ? BOX_SX_VISIBLE : BOX_SX_HIDDEN}
      >
        <Typography data-testid="warp-screen-status" sx={STATUS_SX}>
          {statusText}
        </Typography>
        <Typography
          component="span"
          data-testid="warp-screen-timer"
          ref={progressRef}
          sx={TIMER_SX}
        >
          WARP STABILISATION 0%
        </Typography>
      </Box>
    </Slot>
  );
}
