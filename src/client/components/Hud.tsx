import { Alert, Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';

/**
 * Top-left HUD: sector name + sector alert.
 *
 * Diagnostic readouts (hull/ammo/connection/clock/server-Hz chips and
 * ship/swarm/correction counters) used to live here as always-visible chips
 * — they're now in the AdvancedDrawer's Dev tab. Hull and ammo are also
 * shown in `ShipStatsCard` (top-right), so the in-game HUD stays minimal.
 *
 * Positioning, z-index, and safe-area insets are owned by the
 * `<Slot anchor="top-left">` host — never set here.
 */
export function Hud(): JSX.Element | null {
  const sectorName = useUIStore((s) => s.sectorName);
  const sectorAlert = useUIStore((s) => s.sectorAlert);

  if (!sectorName && !sectorAlert) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {sectorName && (
        <Typography variant="overline" sx={{ color: '#fff', opacity: 0.7 }}>
          {sectorName}
        </Typography>
      )}
      {sectorAlert && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {sectorAlert}
        </Alert>
      )}
    </Box>
  );
}
