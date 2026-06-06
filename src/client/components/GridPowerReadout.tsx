import { Box } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store';

/**
 * Grid power readout (speed-dial-resource-structures plan, Phase 3). A small
 * HUD chip showing the player's live grid net power (Σ output − Σ consumption
 * over their powered component), updated at the 1 Hz pulse cadence from the
 * `structures[]` snapshot slice via Zustand `gridNetPower`.
 *
 * Hidden when the player has no powered grid (`gridNetPower === 0`) so it
 * doesn't clutter the HUD before any structure is placed. Discrete value
 * (purity-clean). Static `sx` hoisted (drawer-perf rule).
 */
export function GridPowerReadout(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const netPower = useUIStore((s) => s.gridNetPower);
  if (!shouldRender || netPower === 0) return null;
  const positive = netPower > 0;
  return (
    <Box data-testid="grid-power" data-net-power={netPower} sx={positive ? CHIP_SX : CHIP_LOW_SX}>
      ⚡ {netPower > 0 ? '+' : ''}{netPower}
    </Box>
  );
}

const CHIP_SX = {
  px: 1,
  py: 0.25,
  borderRadius: 1,
  bgcolor: 'rgba(5,7,15,0.78)',
  border: '1px solid rgba(120,220,160,0.4)',
  color: '#9f9',
  fontSize: 12,
  fontFamily: 'monospace',
  fontWeight: 700,
} as const;

const CHIP_LOW_SX = {
  ...CHIP_SX,
  border: '1px solid rgba(255,120,120,0.5)',
  color: '#f99',
} as const;
