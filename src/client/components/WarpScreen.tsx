import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useIsLoadingActive, useUIStore } from '../state/store';
import { Slot } from '../layout/Slot';
import { logEvent } from '../debug/ClientLogger';

/**
 * Thin in-game-language HUD over the warping Pixi canvas. NOT an
 * overlay screen — the warp visual itself is a render state of the
 * gameplay `PixiRenderer` (`setWarpMode(true)`), painted on the same
 * canvas as gameplay.
 *
 * Visible when `useIsLoadingActive()` is true (curtain up — initial
 * join / respawn / transit arrival). Shows a single short status
 * label + a CSS-animated 3-dot pulse. Three labels:
 *
 *   CONNECTING       — pre-welcome (WS + initial state-diff)
 *   LOADING SECTOR   — bootstrap gates pending (snapshot, first frame,
 *                       minDisplay floor, client_ready handshake)
 *   WARPING IN       — handshake done, waiting for the synchronised
 *                       flash at server-picked `arrivalTick`
 *   WARP COMPLETE    — terminal (curtain mid-fade)
 *
 * Stall escape hatch: if the curtain stays up for 20 s, surfaces a
 * Cancel button that routes back to galaxy-map with a toast.
 *
 * `sx={{...}}` literals are HOISTED to module-level constants below
 * so the React render path doesn't reconstruct + diff them each pass.
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
// Plan: crispy-kazoo, Commit 9 — animated 3-dot ellipsis replaces
// the jittery `WARP STABILISATION X%` RAF counter. Pure CSS keyframes
// driven; zero JS allocation per frame.
const DOT_SX_BASE = {
  display: 'inline-block',
  width: 6,
  height: 6,
  mx: 0.4,
  borderRadius: '50%',
  bgcolor: '#9aa0b4',
  animation: 'eqx-warp-dot 1.2s ease-in-out infinite',
  '@keyframes eqx-warp-dot': {
    '0%, 80%, 100%': { opacity: 0.25, transform: 'scale(0.85)' },
    '40%': { opacity: 1, transform: 'scale(1)' },
  },
};
const DOT_SX_1 = { ...DOT_SX_BASE, animationDelay: '0s' };
const DOT_SX_2 = { ...DOT_SX_BASE, animationDelay: '0.18s' };
const DOT_SX_3 = { ...DOT_SX_BASE, animationDelay: '0.36s' };
const DOT_ROW_SX = {
  minHeight: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
// Pre-cache the two opacity-bearing variants so the most-common render
// path (opacity 0 in steady state, opacity 1 during warp) reuses a
// stable sx ref instead of allocating per-render.
const BOX_SX_HIDDEN = { ...BOX_SX_STATIC, opacity: 0 };
const BOX_SX_VISIBLE = { ...BOX_SX_STATIC, opacity: 1 };

// Plan: crispy-kazoo, Commit 8 — robustness.
// If `useIsLoadingActive` stays true past this floor, fire the soft-fail
// path (toast + back to galaxy-map). 20 s gives healthy bootstraps with
// 5 s minDisplay + ~300 ms handshake comfortable margin; anything past
// that is a real stall and the user should NOT be trapped.
const LOADING_STALL_TIMEOUT_MS = 20_000;

// Cancel button is pointer-active even though the surrounding Slot
// disables pointer events (the curtain is otherwise a pass-through
// for in-game touches on mobile — we re-enable the button alone).
const CANCEL_BUTTON_SX = {
  pointerEvents: 'auto' as const,
  mt: 2,
  px: 2,
  py: 0.5,
  fontSize: 10,
  letterSpacing: 1,
  color: '#ff6677',
  borderColor: 'rgba(255, 102, 119, 0.55)',
  '&:hover': {
    borderColor: '#ff6677',
    bgcolor: 'rgba(255, 102, 119, 0.08)',
  },
};
const STALL_TEXT_SX = {
  color: '#ffaa55',
  fontFamily: 'ui-monospace, "Roboto Mono", monospace',
  fontSize: 11,
  letterSpacing: 2,
  textTransform: 'uppercase' as const,
  mt: 1,
  maxWidth: 280,
  textAlign: 'center' as const,
  pointerEvents: 'auto' as const,
};

export function WarpScreen(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const localShipInstanceId = useUIStore((s) => s.localShipInstanceId);
  const firstSnapshotApplied = useUIStore((s) => s.firstSnapshotApplied);
  const rendererFirstFrameRendered = useUIStore((s) => s.rendererFirstFrameRendered);
  const clientReadySent = useUIStore((s) => s.clientReadySent);
  const arrivalTickFromServer = useUIStore((s) => s.arrivalTickFromServer);
  const arrivalAcked = useUIStore((s) => s.arrivalAcked);

  const joinMinimumElapsed = useUIStore((s) => s.joinMinimumElapsed);
  // Plan: crispy-kazoo Commit 1 — single source of truth is now
  // `useIsLoadingActive()` (which delegates to `computeGameReadyFromState`
  // and honours the `?loading=cosmetic` kill switch). Behaviour-equal
  // to the old `isConnecting || (phase==='game' && !useGameReady())`
  // composition; switching here so Commit 2's handshake gates land in
  // one place. The individual sub-flag selectors above stay — the
  // status text below still reports WHICH gate is still open.
  const visible = useIsLoadingActive();

  // Plan: crispy-kazoo, Commit 8 — stall detection. After
  // LOADING_STALL_TIMEOUT_MS of continuous loading-active, surface the
  // Cancel CTA + an explanatory line. Pure UI state — clicking Cancel
  // (or the timeout firing) routes the user back to galaxy-map via
  // App.tsx's setPhase. No more user-trapped-on-loading.
  //
  // Timer depends ONLY on `visible`. Mid-load gate transitions (e.g.
  // firstSnapshotApplied flipping true at t=10s) do NOT re-arm the
  // 20s window — the timer measures "continuous loading-active",
  // not "continuous no-state-change". Gate snapshots for the
  // diagnostic event are read at fire time via store.getState()
  // (live read, not closed-over from this effect).
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!visible) {
      setStalled(false);
      return undefined;
    }
    const handle = window.setTimeout(() => {
      setStalled(true);
      const s = useUIStore.getState();
      logEvent('respawn_loading_stall_detected', {
        stuckAtGate:
          s.connectionStatus !== 'connected' ? 'connection'
          : s.localShipInstanceId === null ? 'welcome'
          : !s.rendererFirstFrameRendered ? 'first-frame'
          : !s.firstSnapshotApplied ? 'first-snapshot'
          : !s.joinMinimumElapsed ? 'min-display'
          : !s.clientReadySent ? 'client-ready'
          : s.arrivalTickFromServer === null ? 'warp-in-broadcast'
          : !s.arrivalAcked ? 'arrival-tick-reached'
          : 'unknown',
      });
    }, LOADING_STALL_TIMEOUT_MS);
    return () => window.clearTimeout(handle);
  }, [visible]);

  const handleCancel = (): void => {
    logEvent('respawn_loading_cancelled', { stalled });
    const ui = useUIStore.getState();
    // Soft-fail back to galaxy-map. Mirrors App.tsx handleRespawn —
    // the user gets the spawn screen to retry without a full reload.
    ui.setLocalShipInstanceId(null);
    ui.setCurrentSectorKey(null);
    ui.setDead(false);
    ui.setGalaxyOverviewOpen(false);
    ui.setGalaxyMapOpen(false);
    ui.setDrawerOpen(false);
    ui.setPendingShipSwap(null);
    ui.setSectorAlert('Connection issue — please retry');
    ui.setPhase('galaxy-map');
    window.setTimeout(() => ui.setSectorAlert(null), 4000);
  };

  // Plan: crispy-kazoo, Commit 9 — collapsed the per-gate cascade to
  // three states that each persist long enough to be readable. The
  // prior 8-state cascade flashed by faster than the eye could parse
  // and produced the user-reported "jittery loading text" symptom
  // (most states ran for ~30-100ms). The three visible windows are:
  //   - CONNECTING:    pre-welcome + initial state-diff (~200-500ms)
  //   - LOADING SECTOR: minDisplay floor + first snapshot (~2.5s)
  //   - WARPING IN:    after handshake, before the synchronised flash
  //                    (~600ms, including the 380ms curtain fade-out)
  //   - WARP COMPLETE: terminal, opacity-0 already
  let statusText: string;
  if (connectionStatus !== 'connected' || localShipInstanceId === null) {
    statusText = 'CONNECTING';
  } else if (
    !rendererFirstFrameRendered
    || !firstSnapshotApplied
    || !joinMinimumElapsed
    || !clientReadySent
    || arrivalTickFromServer === null
  ) {
    statusText = 'LOADING SECTOR';
  } else if (!arrivalAcked) {
    statusText = 'WARPING IN';
  } else {
    statusText = 'WARP COMPLETE';
  }

  // Plan: crispy-kazoo, Commit 9 — replaced the `WARP STABILISATION X%`
  // 60Hz RAF counter with a CSS-animated 3-dot ellipsis. The X%
  // counter was the source of the user-reported "jittery loading
  // text" — it allocated a fresh string for every percentage change
  // AND was misleading once the loading window dropped to ~3s (it'd
  // only reach ~60% before curtain drop, leaving an "incomplete"
  // visual). The ellipsis is purely cosmetic (animation lives in the
  // sx below), zero JS work per frame.

  if (phase !== 'game' && phase !== 'connecting') return null;

  return (
    <Slot anchor="fullscreen" pointerEvents="none">
      <Box
        data-testid="warp-screen"
        data-warp-visible={visible ? '1' : '0'}
        data-warp-stalled={stalled ? '1' : '0'}
        sx={visible ? BOX_SX_VISIBLE : BOX_SX_HIDDEN}
      >
        <Typography data-testid="warp-screen-status" sx={STATUS_SX}>
          {statusText}
        </Typography>
        <Box data-testid="warp-screen-timer" sx={DOT_ROW_SX}>
          <Box component="span" sx={DOT_SX_1} />
          <Box component="span" sx={DOT_SX_2} />
          <Box component="span" sx={DOT_SX_3} />
        </Box>
        {stalled && visible && (
          <>
            <Typography data-testid="warp-screen-stall-msg" sx={STALL_TEXT_SX}>
              Taking longer than expected.<br />
              Check your connection or pick a different sector.
            </Typography>
            <Button
              data-testid="warp-screen-cancel"
              variant="outlined"
              size="small"
              onClick={handleCancel}
              sx={CANCEL_BUTTON_SX}
            >
              Cancel
            </Button>
          </>
        )}
      </Box>
    </Slot>
  );
}
