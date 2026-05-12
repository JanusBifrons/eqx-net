import { Box } from '@mui/material';
import { useEffect, useState } from 'react';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';

/**
 * Top-left EVE-style sector readout. Four label/value rows at tiny-but-
 * legible font size — pure overlay text, no background or border (the Pixi
 * canvas behind provides contrast). Mounted via `<Slot anchor="top-left"
 * order={1}>` so it sits above the existing Hud (sectorAlert at order=10).
 *
 * Sovereignty + Region are hardcoded for now; field names + selector seam
 * are chosen so swapping them for live faction/region data later is a
 * one-line change.
 *
 * Grid row reads the local ship's position from the render mirror via
 * `getGameClient()` polled at 10 Hz. This is the sanctioned low-cadence
 * mirror read path (`src/client/net/clientSingleton.ts`); per-frame
 * spatial state must NOT flow through Zustand (invariant #2). The
 * displayed unit is one micro grid cell (200u) so the readout matches
 * the on-grid coordinate labels at every macro intersection.
 */

const GRID_CELL = 500;
const POLL_MS = 100;

export function SectorInfoPanel(): JSX.Element | null {
  const sectorName = useUIStore((s) => s.sectorName);
  const currentSectorKey = useUIStore((s) => s.currentSectorKey);
  const [coord, setCoord] = useState<{ gx: number; gy: number } | null>(null);

  useEffect(() => {
    const tick = (): void => {
      const c = getGameClient();
      const id = c?.mirror.localPlayerId;
      const ship = id ? c?.mirror.ships.get(id) : null;
      if (ship) {
        setCoord({
          gx: Math.round(ship.x / GRID_CELL),
          gy: Math.round(ship.y / GRID_CELL),
        });
      } else {
        setCoord(null);
      }
    };
    tick();
    const handle = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(handle);
  }, []);

  const sectorLabel = sectorName !== '' ? sectorName : (currentSectorKey === null ? 'Test arena' : '—');
  const gridLabel = coord ? `${coord.gx}, ${coord.gy}` : '—';

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

      <Label>Grid</Label>
      <Value testid="sector-info-grid">{gridLabel}</Value>
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
