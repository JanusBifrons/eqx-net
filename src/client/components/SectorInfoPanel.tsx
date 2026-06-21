import { Box } from '@mui/material';
import { useEffect, useState } from 'react';
import { useUIStore, useShouldRenderHud } from '../state/store';
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
// Phase 5 — responsive: stays a tiny bare overlay on MOBILE (the "start tiny"
// sizing default) but becomes a LARGER, semi-transparent MUI card on DESKTOP
// (sm+), where the panel "is absolutely tiny" and has room. Breakpoint objects
// are literal-stable at module scope, so hoisting (the 10 Hz re-render alloc
// guard) is preserved.
const GRID_SX = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: { xs: 1, sm: 1.5 },
  rowGap: { xs: '2px', sm: '4px' },
  color: '#dde',
  pointerEvents: 'none' as const,
  userSelect: 'none' as const,
  fontFamily: 'system-ui, sans-serif',
  // Desktop: a transparent dark card with padding; mobile: no chrome.
  bgcolor: { xs: 'transparent', sm: 'rgba(8,12,22,0.42)' },
  border: { xs: 'none', sm: '1px solid rgba(255,255,255,0.08)' },
  borderRadius: { xs: 0, sm: 1 },
  p: { xs: 0, sm: 1.25 },
  backdropFilter: { xs: 'none', sm: 'blur(2px)' },
};
const LABEL_SX = {
  fontSize: { xs: 9, sm: 12 },
  letterSpacing: 0.5,
  color: 'rgba(255,255,255,0.45)',
  textTransform: 'uppercase' as const,
  alignSelf: 'baseline',
};
const VALUE_SX = {
  fontSize: { xs: 11, sm: 15 },
  color: '#dde',
  alignSelf: 'baseline',
};

export function SectorInfoPanel(): JSX.Element | null {
  // Plan: crispy-kazoo, Commit 5 — hide HUD during loading curtain.
  // All hooks called unconditionally per React's Rules of Hooks; the
  // early-return is placed AFTER every hook below.
  const shouldRender = useShouldRenderHud();
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

  if (!shouldRender) return null;

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
