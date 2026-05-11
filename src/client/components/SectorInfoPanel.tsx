import { Box } from '@mui/material';
import { useUIStore } from '../state/store';

/**
 * Top-left EVE-style sector readout. Three label/value rows at tiny-but-
 * legible font size — pure overlay text, no background or border (the Pixi
 * canvas behind provides contrast). Mounted via `<Slot anchor="top-left"
 * order={1}>` so it sits above the existing Hud (sectorAlert at order=10).
 *
 * Sovereignty + Region are hardcoded for now; field names + selector seam
 * are chosen so swapping them for live faction/region data later is a
 * one-line change.
 */
export function SectorInfoPanel(): JSX.Element | null {
  const sectorName = useUIStore((s) => s.sectorName);
  const currentSectorKey = useUIStore((s) => s.currentSectorKey);

  const sectorLabel = sectorName !== '' ? sectorName : (currentSectorKey === null ? 'Test arena' : '—');

  return (
    <Box
      data-testid="sector-info-panel"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        columnGap: 1,
        rowGap: '2px',
        color: '#dde',
        pointerEvents: 'none',
        userSelect: 'none',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <Label>Current sector</Label>
      <Value testid="sector-info-current">{sectorLabel}</Value>

      <Label>Sovereignty</Label>
      <Value testid="sector-info-sovereignty">Roman</Value>

      <Label>Region</Label>
      <Value testid="sector-info-region">Sol</Value>
    </Box>
  );
}

function Label({ children }: { children: string }): JSX.Element {
  return (
    <Box
      component="span"
      sx={{
        fontSize: 9,
        letterSpacing: 0.5,
        color: 'rgba(255,255,255,0.45)',
        textTransform: 'uppercase',
        alignSelf: 'baseline',
      }}
    >
      {children}
    </Box>
  );
}

function Value({ testid, children }: { testid: string; children: string }): JSX.Element {
  return (
    <Box
      component="span"
      data-testid={testid}
      sx={{
        fontSize: 11,
        color: '#dde',
        alignSelf: 'baseline',
      }}
    >
      {children}
    </Box>
  );
}
