import { useEffect, useState } from 'react';
import { Alert, Box } from '@mui/material';
import type { AlertColor } from '@mui/material';
import { useUIStore } from '../state/store';
import type { WarpRelation } from '../state/storeTypes';

/**
 * Wave-system Phase 5 — the sector-wide "incoming warp" warning HUD.
 * WS-11 (R2.21) — PERSISTENT + COLOUR-CODED.
 *
 * Shows one banner per pending `warpWarning` (a drone squad spooling at the
 * sector, e.g. "8 × Legionnaires", or a player) with a live countdown, COLOURED
 * BY RELATION (hostile=red, neutral=amber, friendly=green) so an incoming wave
 * reads as a threat at a glance. The countdown is computed LOCALLY from each
 * warning's `countdownMs` anchored at its client `observedAtMs` (no server-clock
 * skew), ticking via one ~5 Hz interval. A warning whose countdown reaches 0
 * self-removes; a cancelled/aborted spool is cleared by `warp_warning_clear`.
 *
 * The banner is ALWAYS MOUNTED and ALWAYS VISIBLE (P3.9, was R2.21). It does NOT
 * unmount on the load curtain (`useShouldRenderHud` gate removed — it's a passive
 * readout, not an interactive control, and an incoming wave often coincides with
 * the player being in transit), and when idle it shows a VISIBLE "nothing
 * incoming" chip rather than an invisible empty `<Box>` — so the player can
 * always SEE the incoming-warp readout exists (the R2.21 idle state read as
 * "missing"; the user "never saw it"). Positioning / z-index / safe-area are
 * owned by the `<Slot>` host — never set here. Purity: the store carries only
 * count / label / timing / the discrete `relation` enum (invariant #2).
 */
const ALERT_SX = { py: 0.25, fontSize: 11 } as const;
// Idle chip: small + muted so the always-present "all clear" readout is visible
// but unobtrusive (start-tiny HUD rule).
const IDLE_SX = { py: 0.25, fontSize: 11, opacity: 0.7 } as const;
const STACK_SX = { display: 'flex', flexDirection: 'column', gap: 0.5 } as const;

function remainingSec(countdownMs: number, observedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((countdownMs - (nowMs - observedAtMs)) / 1000));
}

/** Pure relation → MUI severity colour map (R2.21). Hostile reads RED (threat),
 *  neutral amber, friendly green. Exported for the component test. */
export function severityForRelation(relation: WarpRelation): AlertColor {
  switch (relation) {
    case 'hostile':
      return 'error';
    case 'friendly':
      return 'success';
    case 'neutral':
    default:
      return 'warning';
  }
}

export function WarpInWarningBanner(): JSX.Element {
  const warpWarnings = useUIStore((s) => s.warpWarnings);
  const removeWarpWarning = useUIStore((s) => s.removeWarpWarning);
  // A monotonic tick to re-render the countdown ~5 Hz without per-warning RAF.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (warpWarnings.length === 0) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 200);
    return () => window.clearInterval(id);
  }, [warpWarnings.length]);

  const now = (globalThis.performance ?? Date).now();
  // ALWAYS-MOUNTED + ALWAYS-VISIBLE (P3.9): the outer container persists, and the
  // idle (no-incoming) state shows a VISIBLE "nothing incoming" chip so the
  // readout is never invisible.
  return (
    <Box sx={STACK_SX} data-testid="warp-warning-banner" data-warning-active={warpWarnings.length > 0 ? '1' : '0'}>
      {warpWarnings.length === 0 ? (
        <Alert severity="success" icon={false} sx={IDLE_SX} data-testid="warp-warning-idle">
          ✓ Nothing incoming
        </Alert>
      ) : (
        warpWarnings.map((w) => {
          const secs = remainingSec(w.countdownMs, w.observedAtMs, now);
          // Self-clean once the spool window elapses (the actual warp-in flash is
          // a separate channel; the banner's job is the countdown).
          if (secs <= 0) {
            // Defer the store mutation out of render.
            queueMicrotask(() => removeWarpWarning(w.id));
          }
          return (
            <Alert
              key={w.id}
              severity={severityForRelation(w.relation)}
              sx={ALERT_SX}
              data-testid="warp-warning"
              data-warning-id={w.id}
              data-warning-count={w.count}
              data-warning-secs={secs}
              data-warning-relation={w.relation}
            >
              {`⚠ ${w.count} × ${w.label}${w.count === 1 ? '' : 's'} warping in — ${secs}s`}
            </Alert>
          );
        })
      )}
    </Box>
  );
}
