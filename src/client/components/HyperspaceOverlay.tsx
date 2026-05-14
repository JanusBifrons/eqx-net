import { useEffect, useRef, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import StopIcon from '@mui/icons-material/Stop';
import { useUIStore } from '../state/store';
import { Slot } from '../layout/Slot';
import { useIsCompact } from '../layout/useIsCompact';
import { WarpStreaks } from './WarpStreaks';

interface HyperspaceOverlayProps {
  /** Cancel callback, fired when the player clicks the abort button. Wired
   *  to `transitClient.cancelTransit(room)` by App.tsx. */
  onCancel: () => void;
}

/**
 * Inter-sector transit overlay.
 *
 * Renders nothing while `transitState === 'DOCKED'`.
 *
 * SPOOLING (the new design): a slim vertical bar pinned to the left edge,
 * volume-bar styled. From top to bottom:
 *   - rocket icon (running indicator)
 *   - countdown in `S.MMM` form, ms-precision
 *   - bottom-up green fill that tracks `transitProgress`
 *   - red abort button at the bottom
 * Smaller / more transparent on desktop (wide viewport), bolder on mobile.
 *
 * IN_TRANSIT and ARRIVED unchanged: full-screen warp-streak / radial flash
 * overlay using the `transit` anchor at click-through pointer-events.
 */
export function HyperspaceOverlay({ onCancel }: HyperspaceOverlayProps): JSX.Element | null {
  const transitState     = useUIStore((s) => s.transitState);
  const transitProgress  = useUIStore((s) => s.transitProgress);

  if (transitState === 'DOCKED') return null;

  if (transitState === 'SPOOLING') {
    return (
      <Slot anchor="middle-left" order={100}>
        <SpoolingBar onCancel={onCancel} progress={transitProgress} />
      </Slot>
    );
  }

  if (transitState === 'IN_TRANSIT' || transitState === 'ARRIVED') {
    // Share the warp visual with WarpScreen so the player gets the
    // same aesthetic across initial join, ship-swap, and transit.
    // Spool bar / abort button continue to live in the SPOOLING branch
    // above — transit-specific UX is separate from the streak visual.
    return (
      <Slot anchor="transit">
        <Box
          data-testid="hyperspace-overlay"
          data-transit-state={transitState}
          sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          <WarpStreaks intensity={transitState === 'ARRIVED' ? 'arrived' : 'transit'} />
        </Box>
      </Slot>
    );
  }

  return null;
}

interface SpoolingBarProps {
  onCancel: () => void;
  /** 0..1 from Zustand. Drives the fill height; the countdown reads
   *  `transitSpoolMs` directly so it updates at RAF rate even between
   *  Zustand notifications. */
  progress: number;
}

function SpoolingBar({ onCancel, progress }: SpoolingBarProps): JSX.Element {
  const compact = useIsCompact();
  const remainingText = useRemainingText();

  const width = compact ? 28 : 36;
  const bg = compact ? 'rgba(5, 7, 15, 0.75)' : 'rgba(5, 7, 15, 0.55)';
  const abortDiameter = compact ? 28 : 24;

  return (
    <Box
      data-testid="hyperspace-overlay"
      data-transit-state="SPOOLING"
      sx={{
        width,
        height: 'min(60vh, 360px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.5,
        py: 1,
        bgcolor: bg,
        border: '1px solid rgba(0, 255, 136, 0.35)',
        borderRadius: 18,
        boxShadow: compact ? '0 0 12px rgba(0, 255, 136, 0.18)' : 'none',
        // backdropFilter removed 2026-05-13 — GPU readPixels stall.
      }}
    >
      <RocketLaunchIcon sx={{ fontSize: 18, color: '#00ff88' }} />

      <Box
        component="span"
        data-testid="hyperspace-countdown"
        sx={{
          fontFamily: 'ui-monospace, "Roboto Mono", monospace',
          fontSize: 10,
          color: '#9aa0b4',
          letterSpacing: 0.5,
          lineHeight: 1,
          minHeight: 12,
        }}
      >
        {remainingText}
      </Box>

      {/* Fill column — flex:1 takes the remaining vertical room between the
          countdown above and the abort button below. The inner div grows
          from the bottom up as `progress` advances. */}
      <Box
        sx={{
          flex: 1,
          width: '60%',
          mt: 0.5,
          mb: 0.5,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 4,
          bgcolor: 'rgba(0, 255, 136, 0.08)',
        }}
      >
        <Box
          data-testid="hyperspace-fill"
          data-progress={progress.toFixed(3)}
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: `${Math.max(0, Math.min(1, progress)) * 100}%`,
            background: 'linear-gradient(to top, #00cc6a, #00ff88)',
            transition: 'height 80ms linear',
          }}
        />
      </Box>

      <Tooltip title="Abort spool" placement="right">
        <IconButton
          data-testid="hyperspace-cancel"
          onClick={onCancel}
          size="small"
          sx={{
            width: abortDiameter,
            height: abortDiameter,
            bgcolor: '#aa1f1f',
            color: '#fff',
            '&:hover, &:active, &:focus': { bgcolor: '#cc2828' },
          }}
        >
          <StopIcon sx={{ fontSize: compact ? 18 : 16 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

/**
 * Live "S.MMM" countdown that updates at RAF rate, independent of Zustand
 * notification cadence. Reads `transitSpoolMs` and the wall-clock SPOOLING
 * start time (captured the first time we observe a non-null `transitSpoolMs`
 * within a SPOOLING state) to compute remaining ms with millisecond
 * precision — a humanising touch the bare 60 Hz progress ramp can't deliver.
 */
function useRemainingText(): string {
  const spoolMs = useUIStore((s) => s.transitSpoolMs);
  const transitState = useUIStore((s) => s.transitState);
  const startRef = useRef<number | null>(null);
  const [text, setText] = useState<string>('');

  // Anchor `start` the first frame we know the duration. Reset once
  // SPOOLING ends so the next transit gets a fresh anchor.
  useEffect(() => {
    if (transitState !== 'SPOOLING' || spoolMs === null) {
      startRef.current = null;
      setText('');
      return;
    }
    if (startRef.current === null) startRef.current = performance.now();

    let raf = 0;
    const tick = (): void => {
      const start = startRef.current;
      if (start === null || spoolMs === null) return;
      const remaining = Math.max(0, spoolMs - (performance.now() - start));
      const seconds = Math.floor(remaining / 1000);
      const millis = Math.floor(remaining % 1000);
      setText(`${seconds}.${millis.toString().padStart(3, '0')}`);
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [transitState, spoolMs]);

  return text;
}
