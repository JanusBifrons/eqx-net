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
 * displayed unit is one micro grid cell (500u — matches
 * `BackgroundGrid.GRID_CELL_SIZE`), and `BackgroundGrid` now draws a
 * coordinate label at EVERY micro intersection, so this readout always
 * lands on a visible labelled grid line (2026-05-15 fix).
 */

// Keep in sync with `BackgroundGrid.GRID_CELL_SIZE` (same 500u micro
// cell). Not imported to keep this React component off the Pixi module
// graph; the value is locked by `BackgroundGrid.labels.test.ts`.
const GRID_CELL = 500;
const POLL_MS = 100;

// Module-level sx — re-using the same object reference across renders
// short-circuits the MUI styled-component diff path (plan: melodic-
// engelbart Step 4 — wb1al4 heap-leak hunt). The component re-renders
// at 10 Hz via the polling tick; without hoisting each render produced
// 9 fresh sx literals (1 grid + 4 labels + 4 values) → ~90 sx allocs/s.
const GRID_SX = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: 1,
  rowGap: '2px',
  color: '#dde',
  pointerEvents: 'none' as const,
  userSelect: 'none' as const,
  fontFamily: 'system-ui, sans-serif',
};
const LABEL_SX = {
  fontSize: 9,
  letterSpacing: 0.5,
  color: 'rgba(255,255,255,0.45)',
  textTransform: 'uppercase' as const,
  alignSelf: 'baseline',
};
const VALUE_SX = {
  fontSize: 11,
  color: '#dde',
  alignSelf: 'baseline',
};

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
    <Box data-testid="sector-info-panel" sx={GRID_SX}>
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
    <Box component="span" sx={LABEL_SX}>
      {children}
    </Box>
  );
}

function Value({ testid, children }: { testid: string; children: string }): JSX.Element {
  return (
    <Box component="span" data-testid={testid} sx={VALUE_SX}>
      {children}
    </Box>
  );
}
