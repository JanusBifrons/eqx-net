import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useIsLoadingActive, useUIStore } from '../state/store';
import { Slot } from '../layout/Slot';
import { logEvent } from '../debug/ClientLogger';
import { WarpBriefing, WARP_STATUS_SX } from './WarpBriefing';
import { currentJoinStepIndex, joinGatesDone, joinGateSteps, type JoinGateState } from './sectorBriefing';

/**
 * Thin in-game-language HUD over the Pixi canvas. NOT an overlay
 * screen — the dark cover is the gameplay `PixiRenderer`'s load curtain
 * (`setLoadCurtain`), painted on the same canvas as gameplay.
 *
 * Visible when `useIsLoadingActive()` is true (curtain up — initial
 * join / respawn). While visible it shows the "sector briefing"
 * (`WarpBriefing`): where you are arriving, who holds it, four live
 * facts the client already has (galaxy snapshot + roster polls), a
 * slim bar filled one step per REAL join gate, and a CSS radar sweep.
 * Under the bar, a status label naming the loading step in progress
 * (`joinGateSteps`: six named steps over the nine gates; WARP COMPLETE
 * once all are done), its plain-English explainer, an "N of 6" count
 * and the step list (done / current / waiting).
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
/** A sector-to-sector trip runs ~25 s by design (it hides the loading), so a
 *  stall only counts well past it. */
const TRAVEL_STALL_TIMEOUT_MS = 45_000;

// Cancel button is pointer-active even though the surrounding Slot
// disables pointer events (the curtain is otherwise a pass-through
// for in-game touches on mobile — we re-enable the button alone).
const CANCEL_BUTTON_SX = {
  pointerEvents: 'auto' as const,
  px: 1.5,
  py: 0.25,
  minWidth: 0,
  fontSize: 10,
  letterSpacing: 1,
  color: '#cfe3f7',
  borderColor: 'rgba(207, 227, 247, 0.4)',
  '&:hover': {
    borderColor: '#cfe3f7',
    bgcolor: 'rgba(207, 227, 247, 0.08)',
  },
};
const STALL_ROW_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 1.5,
  mt: 1.5,
};
const STALL_TEXT_SX = {
  color: '#7d93ab',
  fontSize: 11,
};

export interface WarpScreenProps {
  /** The sector the pending join targets (from the join's room name), so
   *  the briefing can name it before `welcome` sets `currentSectorKey`. */
  targetSectorKey?: string | null;
}

export function WarpScreen({ targetSectorKey = null }: WarpScreenProps = {}): JSX.Element | null {
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
  const loadingActive = useIsLoadingActive();
  // Phase 4 travel state: a sector-to-sector trip IS the loading screen, so
  // this screen stays hidden during it — unless the trip stalls (below),
  // when it appears with the Cancel button so nobody is stuck flying forever.
  const travelling = useUIStore((s) => s.travelling);
  const currentSectorKey = useUIStore((s) => s.currentSectorKey);
  const transitTargetSectorKey = useUIStore((s) => s.transitTargetSectorKey);
  const pilotMode = useUIStore((s) => s.pilotMode);
  const localPoseResolved = useUIStore((s) => s.localPoseResolved);
  // The step list and the bar come from ONE function over the gate flags
  // already subscribed above (render-only, on gate flips; no per-frame work).
  const gateState: JoinGateState = {
    connectionStatus, localShipInstanceId, rendererFirstFrameRendered, firstSnapshotApplied,
    joinMinimumElapsed, localPoseResolved, clientReadySent, arrivalTickFromServer, arrivalAcked, pilotMode,
  };
  const steps = joinGateSteps(gateState);
  const currentStep = currentJoinStepIndex(steps);
  const gatesDone = joinGatesDone(gateState);

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
  const visible = loadingActive && (!travelling || stalled);
  useEffect(() => {
    if (!loadingActive) {
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
    }, useUIStore.getState().travelling ? TRAVEL_STALL_TIMEOUT_MS : LOADING_STALL_TIMEOUT_MS);
    return () => window.clearTimeout(handle);
  }, [loadingActive]);

  const handleCancel = (): void => {
    logEvent('respawn_loading_cancelled', { stalled });
    const ui = useUIStore.getState();
    // Soft-fail back to galaxy-map. Mirrors App.tsx handleRespawn —
    // the user gets the spawn screen to retry without a full reload.
    ui.setLocalShipInstanceId(null);
    ui.setCurrentSectorKey(null);
    ui.setDead(false);
    ui.setGalaxyMapOpen(false);
    ui.setRightPanel(null);
    ui.setPendingShipSwap(null);
    ui.setSectorAlert('Connection issue — please retry');
    ui.setPhase('galaxy-map');
    window.setTimeout(() => ui.setSectorAlert(null), 4000);
  };

  // The status label names the step in progress (its playful name; the
  // plain explainer and the full step list sit under it in WarpBriefing).
  // The nine gates are grouped into six steps (`joinGateSteps`) so no step
  // is a 30-100 ms flash on its own; the display floor folds into drawing.
  // Terminal (curtain mid-fade / hidden): WARP COMPLETE.
  const statusText = currentStep >= 0 ? steps[currentStep]!.name : 'WARP COMPLETE';

  // Which sector the briefing names: a stalled trip's destination; before
  // `welcome` the join's own target (`currentSectorKey` may still be the
  // last sector); after it the live `currentSectorKey`.
  const preWelcome = connectionStatus !== 'connected' || localShipInstanceId === null;
  const briefingKey =
    travelling && transitTargetSectorKey !== null ? transitTargetSectorKey
    : preWelcome ? (targetSectorKey ?? currentSectorKey)
    : (currentSectorKey ?? targetSectorKey);

  // The progress bar fills one step per REAL join gate done (never a timer).
  // The old `WARP STABILISATION X%` RAF counter and the 3-dot ellipsis are
  // gone; everything that moves is CSS (see WarpBriefing).

  if (phase !== 'game' && phase !== 'connecting') return null;

  const status = (
    <Typography data-testid="warp-screen-status" sx={WARP_STATUS_SX}>
      {statusText}
    </Typography>
  );

  // The briefing is MOUNTED only while visible: once loading lifts (or
  // during a trip) only the terminal status label stays, aria-hidden, so
  // no stale "Arriving at" text, store subscriptions or sweep linger in play.
  return (
    <Slot anchor="fullscreen" pointerEvents="none">
      <Box
        data-testid="warp-screen"
        data-warp-visible={visible ? '1' : '0'}
        data-warp-stalled={stalled ? '1' : '0'}
        sx={visible ? BOX_SX_VISIBLE : BOX_SX_HIDDEN}
        aria-hidden={visible ? undefined : true}
      >
        {visible ? (
        <WarpBriefing
          sectorKey={briefingKey}
          gatesDone={gatesDone}
          steps={steps}
          currentStep={currentStep}
          status={status}
          footer={stalled ? (
            <Box sx={STALL_ROW_SX}>
              <Typography data-testid="warp-screen-stall-msg" sx={STALL_TEXT_SX}>
                Still loading…
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
            </Box>
          ) : null}
        />
        ) : status}
      </Box>
    </Slot>
  );
}
