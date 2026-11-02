/**
 * v4 A — "Systems disabled": the local ship was hit by an alien gate's guns
 * (for attacking the gate, or firing inside its zone). Engines and weapons
 * are offline until the countdown ends.
 *
 * Reads the discrete Zustand `disabledUntil` (written from the own-ship
 * snapshot's `disabledMs`, #16) and ticks a local countdown at 4 Hz only
 * while it runs.
 */
import { memo, useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { useUIStore } from '../state/store';

const SX = {
  px: 1, py: 0.25, borderRadius: '4px', fontSize: 11, fontWeight: 700, textAlign: 'center' as const,
  color: '#eafffb', backgroundColor: 'rgba(10,90,80,0.9)', border: '1px solid #3fe0c5', pointerEvents: 'none' as const,
};

export const DisabledIndicator = memo(function DisabledIndicator(): JSX.Element | null {
  const until = useUIStore((s) => s.disabledUntil);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [until]);
  const left = until - now;
  if (left <= 0) return null;
  const secs = Math.ceil(left / 1000);
  return (
    <Box sx={SX} data-testid="ship-disabled" data-seconds={secs}>
      {`Systems disabled by the alien gate: ${secs}s`}
    </Box>
  );
});
