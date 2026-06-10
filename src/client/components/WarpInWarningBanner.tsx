import { useEffect, useState } from 'react';
import { Alert, Box } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store';

/**
 * Wave-system Phase 5 — the sector-wide "incoming warp" warning HUD.
 *
 * Shows one amber banner per pending `warpWarning` (a drone squad spooling at
 * the sector, e.g. "8 × Legionnaires", or a player) with a live countdown. The
 * countdown is computed LOCALLY from each warning's `countdownMs` anchored at
 * its client `observedAtMs` (first-observation — no server-clock skew, M1), and
 * ticks via one ~5 Hz interval (a banner doesn't need RAF). A warning whose
 * countdown reaches 0 self-removes from the store; a cancelled/aborted spool is
 * cleared by the `warp_warning_clear` handler.
 *
 * Positioning / z-index / safe-area are owned by the `<Slot>` host — never set
 * here. Purity: the store carries only count/label/timing (invariant #2).
 */
const ALERT_SX = { py: 0.25, fontSize: 11 } as const;
const STACK_SX = { display: 'flex', flexDirection: 'column', gap: 0.5 } as const;

function remainingSec(countdownMs: number, observedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((countdownMs - (nowMs - observedAtMs)) / 1000));
}

export function WarpInWarningBanner(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const warpWarnings = useUIStore((s) => s.warpWarnings);
  const removeWarpWarning = useUIStore((s) => s.removeWarpWarning);
  // A monotonic tick to re-render the countdown ~5 Hz without per-warning RAF.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (warpWarnings.length === 0) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 200);
    return () => window.clearInterval(id);
  }, [warpWarnings.length]);

  if (!shouldRender || warpWarnings.length === 0) return null;

  const now = (globalThis.performance ?? Date).now();
  return (
    <Box sx={STACK_SX} data-testid="warp-warning-banner">
      {warpWarnings.map((w) => {
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
            severity="warning"
            sx={ALERT_SX}
            data-testid="warp-warning"
            data-warning-id={w.id}
            data-warning-count={w.count}
            data-warning-secs={secs}
          >
            {`⚠ ${w.count} × ${w.label}${w.count === 1 ? '' : 's'} warping in — ${secs}s`}
          </Alert>
        );
      })}
    </Box>
  );
}
