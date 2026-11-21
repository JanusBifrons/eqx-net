import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import type { SectorTooltipData, SectorShipEntry } from './galaxyTooltip';
import type { RecentCombat } from '../../shared-types/galaxySnapshot';
import { isTouchDevice } from '../input/TouchInput';
import { SidePanel, useSidePanelDock } from './SidePanel';
import { useSectorHistory } from './SectorHistorySparkline';
import { ControlSection, MONO, RecentSection, SectorStats } from './sectorPanelParts';

/**
 * Equinox Phase 9 (item 2) — the sector info DRAWER, on the shared SidePanel
 * shell (SidePanel.tsx). Replaces the old fixed
 * popover (the desktop hover tooltip is separate + kept). Docks RIGHT on any
 * landscape screen (narrower on a phone, below its top-right toolbar) and as a
 * BOTTOM sheet upright (the map's focus view frames the sector in the space
 * left: `focusPanelDock` / `focusPanelInsets`). OVERLAYS the
 * map without a scrim (MUI `persistent` variant — NOT a `temporary`/Modal
 * drawer, so the map behind stays interactive + re-selectable, and there are no
 * global touch listeners → the SwipeableDrawer RTT regression is avoided). A
 * scoped swipe on the grab handle closes it (deselects the sector); the body
 * scrolls on overflow; a fixed action bar (Join / Spectate, or Warp) sits
 * outside the scroll.
 *
 * Layout, top to bottom: "◀ Galaxy" back control, name, "HELD BY … · UPDATED
 * n S AGO"; CONTROL (bar, gaining line, last-hour sparkline); IN THE SECTOR
 * (2×2 live counts); RECENT (losses, last change of hands, your ships). The
 * sections live in `sectorPanelParts.tsx`.
 *
 * GalaxyPickerChrome owns the feed data (the pure buildSectorTooltip /
 * shipsInSector) + the spawn/warp wiring; the drawer fetches the sector's
 * history itself (`useSectorHistory`, once per sector opened).
 */

const HEADER_SX = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  px: 1.25,
  pb: 0.5,
  gap: 1,
} as const;

const BACK_SX = {
  p: 0, minWidth: 0, color: '#9aa0b4', fontSize: 9, fontWeight: 700, letterSpacing: 1, fontFamily: MONO,
  textTransform: 'uppercase', lineHeight: 1.6, '&:hover': { color: '#fff', bgcolor: 'transparent' },
} as const;
const META_SX = { color: '#8fe9c0', fontSize: 9, letterSpacing: 0.75, textTransform: 'uppercase', fontFamily: MONO } as const;

const SCROLL_SX = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  px: 1.25,
  pb: 1,
} as const;

const WARP_CELL_SX = { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 0.25 } as const;
const WARP_BUTTON_SX = {
  bgcolor: '#0088cc', color: '#04140b', fontWeight: 700, fontSize: 12, '&:hover': { bgcolor: '#33bbff' },
  '&.Mui-disabled': { bgcolor: '#1f2a33', color: '#6b7280' },
} as const;
const WARP_HINT_SX = { color: '#9ca3af', fontSize: 9, textAlign: 'center' } as const;

const ACTIONBAR_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  px: 1,
  pt: 0.75,
  // Clear the home indicator / on-screen nav bar so the CTAs are never tucked
  // under it (pairs with the dvh height fix). Falls back to ~6px on devices
  // with no inset.
  pb: 'calc(6px + env(safe-area-inset-bottom, 0px))',
  borderTop: '1px solid #1c2438',
  flex: '0 0 auto',
} as const;

export interface SectorInfoDrawerProps {
  open: boolean;
  sectorKey: string | null;
  tip: SectorTooltipData | null;
  ships: readonly SectorShipEntry[];
  recentCombat: RecentCombat | null;
  context: 'landing' | 'warp';
  warpable: boolean;
  currentSectorKey: string | null;
  /** When the galaxy feed last arrived (wall ms), for "UPDATED n S AGO"; null = not yet. */
  updatedAtMs?: number | null;
  /** "◀ Galaxy" / swipe → deselect + close (the focus view backs out). */
  onClose: () => void;
  /** Resume one of the player's existing ships in this sector. */
  onSpawnExistingShip: (shipId: string, sectorKey: string) => void;
  /** Landing CTA — open the ship-kind picker for this sector. */
  onJoin: (sectorKey: string) => void;
  /** Warp CTA — engage transit to this (adjacent) sector. */
  onWarp: (sectorKey: string) => void;
  /** RTS fleet warp: when set, "Warp here" is shown DISABLED with this hint
   *  (Command view with no ships selected: "Select ships to warp"). */
  warpBlockedHint?: string | null;
  /** Equinox Phase 5 (WS-3) — landing CTA to join this sector as a SPECTATOR,
   *  SKIPPING the ship-kind picker (free-roam camera + construction; the hull
   *  parks as a lingering hull you can pilot later). Omitted ⇒ no Spectate
   *  button (back-compat / warp context). */
  onSpectate?: (sectorKey: string) => void;
}

export function SectorInfoDrawer({
  open,
  sectorKey,
  tip,
  ships,
  recentCombat,
  context,
  warpable,
  currentSectorKey,
  onClose,
  onSpawnExistingShip,
  onJoin,
  onWarp,
  onSpectate,
  warpBlockedHint = null,
  updatedAtMs = null,
}: SectorInfoDrawerProps): JSX.Element {
  const anchor = useSidePanelDock();
  const isWarp = context === 'warp';
  // A phone (sideways side panel or upright sheet) gets the tighter layout.
  const compact = anchor === 'bottom' || isTouchDevice();
  const samples = useSectorHistory(open ? sectorKey : null);
  // Wall clock for the relative times, ticking once a second while open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return undefined;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      testId="sector-info-drawer"
      handleTestId="sector-drawer-handle"
      // E2E hook for the live selection.
      paperAttrs={{ 'data-drawer-sector': sectorKey ?? '' }}
    >
      {!tip || !sectorKey ? (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
          <Typography sx={{ color: '#6b7280', fontSize: 12 }}>Select a sector</Typography>
        </Box>
      ) : (
        <>
          <Box sx={HEADER_SX}>
            <Box sx={{ minWidth: 0 }}>
              {/* Back out of the focus view (the drawer close: deselects). */}
              <Button
                size="small"
                disableRipple
                data-testid="sector-drawer-close"
                aria-label="Back to the galaxy"
                onClick={onClose}
                sx={BACK_SX}
              >
                ◀ Galaxy
              </Button>
              <Typography sx={{ color: '#dffff0', fontSize: compact ? 16 : 20, fontWeight: 700, lineHeight: 1.15 }} noWrap>
                {tip.name}
              </Typography>
              <Typography data-testid="sector-drawer-meta" sx={META_SX}>
                {tip.holderId !== null ? `Held by ${tip.faction}` : 'Unclaimed'}
                {updatedAtMs !== null && ` · Updated ${Math.max(0, Math.round((nowMs - updatedAtMs) / 1000))} s ago`}
              </Typography>
            </Box>
            {recentCombat && (
              <Typography
                data-testid="sector-drawer-combat-icon"
                title="Recent combat"
                sx={{ color: '#ff7043', fontSize: 14, flex: '0 0 auto', mt: 2 }}
              >
                ⚔
              </Typography>
            )}
          </Box>

          <Box sx={SCROLL_SX}>
            <ControlSection tip={tip} samples={samples} compact={compact} />
            <SectorStats tip={tip} compact={compact} />
            <RecentSection
              tip={tip}
              recentCombat={recentCombat}
              ships={ships}
              nowMs={nowMs}
              onSpawn={(shipId) => onSpawnExistingShip(shipId, sectorKey)}
            />
          </Box>

          {/* Fixed action bar — Join the fight + Spectate (or Warp here). */}
          <Box sx={ACTIONBAR_SX}>
            {isWarp ? (
              warpable ? (
                <Box sx={WARP_CELL_SX}>
                  <Button
                    fullWidth
                    size="small"
                    variant="contained"
                    data-testid="sector-drawer-warp"
                    disabled={warpBlockedHint !== null}
                    onClick={() => sectorKey && warpBlockedHint === null && onWarp(sectorKey)}
                    sx={WARP_BUTTON_SX}
                  >
                    Warp here
                  </Button>
                  {warpBlockedHint !== null && (
                    <Typography data-testid="sector-drawer-warp-hint" sx={WARP_HINT_SX}>
                      {warpBlockedHint}
                    </Typography>
                  )}
                </Box>
              ) : (
                <Typography sx={{ flex: 1, color: '#6b7280', fontSize: 9, textAlign: 'center' }}>
                  {sectorKey === currentSectorKey ? 'You are here' : 'Not adjacent — warp via a neighbour'}
                </Typography>
              )
            ) : (
              <>
                <Button
                  fullWidth
                  size="small"
                  variant="contained"
                  data-testid="sector-drawer-join"
                  onClick={() => sectorKey && onJoin(sectorKey)}
                  sx={{ flex: 1, bgcolor: '#00aa55', color: '#04140b', fontWeight: 700, fontSize: 12, '&:hover': { bgcolor: '#00cc66' } }}
                >
                  Join the fight
                </Button>
                {onSpectate && (
                  // Equinox Phase 5 (WS-3) — join as a SPECTATOR, skipping the
                  // ship-kind picker (free-roam + construction; hull parks as a
                  // pilotable lingering hull).
                  <Button
                    size="small"
                    variant="outlined"
                    data-testid="sector-drawer-spectate"
                    onClick={() => sectorKey && onSpectate(sectorKey)}
                    sx={{ flex: '0 0 auto', color: '#9ad8ff', borderColor: '#2c6a8f', fontWeight: 600, fontSize: 11, '&:hover': { borderColor: '#33bbff', bgcolor: 'rgba(51,187,255,0.08)' } }}
                  >
                    Spectate
                  </Button>
                )}
              </>
            )}
          </Box>
        </>
      )}
    </SidePanel>
  );
}
