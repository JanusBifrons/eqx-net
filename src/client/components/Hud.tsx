import { Alert } from '@mui/material';
import { useUIStore } from '../state/store';

/**
 * Top-left HUD: sector alert only. The sector-name readout moved into
 * `SectorInfoPanel` (top-left, order=1) so this component now just hosts
 * the warning Alert that pops in when the server reports a sector-wide
 * event. Mounted at order=10 so it stacks below the sector panel.
 *
 * Positioning, z-index, and safe-area insets are owned by the
 * `<Slot anchor="top-left">` host — never set here.
 */
export function Hud(): JSX.Element | null {
  const sectorAlert = useUIStore((s) => s.sectorAlert);

  if (!sectorAlert) return null;

  return (
    <Alert severity="warning" sx={{ py: 0 }}>
      {sectorAlert}
    </Alert>
  );
}
