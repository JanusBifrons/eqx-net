import { useEffect, useRef, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useIsLoadingActive, useUIStore } from '../state/store';
import { Slot } from '../layout/Slot';
import { logEvent } from '../debug/ClientLogger';

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
  } else if (!firstSnapshotApplied) {
    statusText = 'SYNCING SECTOR TELEMETRY';
  } else if (!joinMinimumElapsed) {
    statusText = 'STABILISING TRAJECTORY';
  } else if (!clientReadySent) {
    statusText = 'NEGOTIATING ARRIVAL';
  } else if (arrivalTickFromServer === null) {
    statusText = 'AWAITING ARRIVAL CLEARANCE';
  } else if (!arrivalAcked) {
    statusText = 'WARP IN T-MINUS';
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
        data-warp-stalled={stalled ? '1' : '0'}
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
