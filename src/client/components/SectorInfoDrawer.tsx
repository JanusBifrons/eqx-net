import { useRef } from 'react';
import { Box, Button, Drawer, IconButton, Portal, Stack, Typography } from '@mui/material';
import { useMediaQuery } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { getShipKind } from '../../shared-types/shipKinds';
import { ShipSilhouette } from '../render/shipShapeSvg';
import { EntityBadge } from './EntityBadge';
import { entityLabel, type EntityKind } from '../render/entityVisuals';
import { Z } from '../layout/zIndex';
import type { SectorTooltipData, SectorShipEntry } from './galaxyTooltip';
import type { RecentCombat } from '../../shared-types/galaxySnapshot';

/**
 * Equinox Phase 9 (item 2) — the sector info DRAWER. Replaces the old fixed
 * popover (the desktop hover tooltip is separate + kept). Docks BOTTOM in
 * portrait and RIGHT in landscape (desktop is landscape → right), OVERLAYS the
 * map without a scrim (MUI `persistent` variant — NOT a `temporary`/Modal
 * drawer, so the map behind stays interactive + re-selectable, and there are no
 * global touch listeners → the SwipeableDrawer RTT regression is avoided). A
 * scoped swipe on the grab handle closes it (deselects the sector); the body
 * scrolls on overflow; a fixed action bar (red ✕ + a wide Join/Warp CTA) sits
 * outside the scroll.
 *
 * Presentational: GalaxyPickerChrome owns the data (the same pure
 * buildSectorTooltip / shipsInSector the popover used) + the spawn/warp wiring.
 */

const SWIPE_CLOSE_PX = 56; // swipe distance (in the dock-out direction) that closes

const PAPER_COMMON = {
  bgcolor: 'rgba(8,12,24,0.98)',
  color: '#dffff0',
  border: '1px solid #2a3550',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  // The host chrome root is pointerEvents:none (taps fall through to the canvas);
  // re-enable on the Paper so the drawer's controls are interactive.
  pointerEvents: 'auto',
  // MUI's persistent (docked) Drawer sets NO z-index on its Paper, so the
  // bottom-right chrome buttons (landing: single-player/engineering z3-4; in-game:
  // the AUTO/FIRE/BOOST HUD at Z.mobileControls) would render OVER the drawer's
  // action bar and intercept clicks. Pin it to the drawer tier (above both, below
  // the app bar — the drawer already starts under the app bar).
  zIndex: Z.drawer,
} as const;

const PAPER_RIGHT = {
  ...PAPER_COMMON,
  width: 296,
  maxWidth: '92vw',
  top: 'var(--app-bar-h, 48px)',
  // dvh tracks the VISIBLE viewport (mobile address/nav bars), so the panel
  // never overflows past the fold; `100%` resolves to the LARGE layout viewport
  // and clipped on a non-fullscreen mobile browser.
  height: 'calc(100dvh - var(--app-bar-h, 48px))',
  borderRadius: '8px 0 0 8px',
} as const;

const PAPER_BOTTOM = {
  ...PAPER_COMMON,
  width: '100%',
  // ~40% of the visible height — between the original 54% ("too big") and the
  // 28% pass ("too small"). dvh (dynamic viewport height) shrinks as the mobile
  // address bar shows, so the fixed action bar is never clipped below the fold
  // when NOT in fullscreen; the body scrolls on overflow.
  height: 'min(40dvh, 340px)',
  maxHeight: 'calc(100dvh - 8px)',
  borderRadius: '10px 10px 0 0',
} as const;

const HEADER_SX = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  px: 1.25,
  pt: 0.5,
  pb: 0.5,
  gap: 1,
} as const;

const SCROLL_SX = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  px: 1.25,
  pb: 1,
} as const;

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

const SECTION_LABEL_SX = {
  color: '#66ffcc',
  fontSize: 9,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  mt: 1,
} as const;

/** A breakdown / recent-activity row: the shared EntityBadge (shape + colour +
 *  cutout count — the game's visual language, identical to the galaxy-map count
 *  badges) followed by a plain-language label that explains it. */
const BADGE_ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.4 } as const;
const BADGE_LABEL_SX = { color: '#cfe', fontSize: 11, lineHeight: 1.3 } as const;

const SHIP_CARD_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  p: 0.5,
  border: '1px solid #2a3550',
  borderRadius: 1,
} as const;

const HANDLE_WRAP_SX = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  height: 24,
  cursor: 'grab',
  // `none` stops the browser claiming the drag as a scroll/pull-to-refresh and
  // firing pointercancel instead of the pointerup our swipe-close reads.
  touchAction: 'none',
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
  /** ✕ / swipe → deselect + close. */
  onClose: () => void;
  /** Resume one of the player's existing ships in this sector. */
  onSpawnExistingShip: (shipId: string, sectorKey: string) => void;
  /** Landing CTA — open the ship-kind picker for this sector. */
  onJoin: (sectorKey: string) => void;
  /** Warp CTA — engage transit to this (adjacent) sector. */
  onWarp: (sectorKey: string) => void;
  /** Equinox Phase 5 (WS-3) — landing CTA to join this sector as a SPECTATOR,
   *  SKIPPING the ship-kind picker (free-roam camera + construction; the hull
   *  parks as a lingering hull you can pilot later). Omitted ⇒ no Spectate
   *  button (back-compat / warp context). */
  onSpectate?: (sectorKey: string) => void;
}

function kindLabel(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** A badge + label row in the SHARED entity visual language (EntityBadge = solid
 *  shape + colour + cutout count). `labelSuffix` appends e.g. " destroyed" for the
 *  recent-activity rows. The label is conditionally pluralised by entityLabel. */
function BadgeRow({ kind, count, labelSuffix = '' }: { kind: EntityKind; count: number; labelSuffix?: string }): JSX.Element {
  return (
    <Box sx={BADGE_ROW_SX}>
      <EntityBadge kind={kind} count={count} size={18} />
      <Typography sx={BADGE_LABEL_SX}>{entityLabel(kind, count)}{labelSuffix}</Typography>
    </Box>
  );
}

/** Hull-bar colour by fraction: green (healthy) → amber → red (critical). */
function hullColor(frac: number): string {
  if (frac > 0.5) return '#6bff9b';
  if (frac > 0.2) return '#ffd479';
  return '#ff6b6b';
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
}: SectorInfoDrawerProps): JSX.Element {
  const portrait = useMediaQuery('(orientation: portrait)');
  const anchor: 'bottom' | 'right' = portrait ? 'bottom' : 'right';
  const isWarp = context === 'warp';

  // Scoped swipe-to-close on the grab handle (no global listeners — avoids the
  // SwipeableDrawer RTT regression). The Paper FOLLOWS the finger in the
  // dock-OUT direction (down for bottom, right for right) for live feedback;
  // release past SWIPE_CLOSE_PX closes (deselects), otherwise it snaps back.
  // Pointer capture keeps move/up on the handle even as the finger leaves it.
  const paperRef = useRef<HTMLDivElement | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const outDelta = (e: React.PointerEvent, s: { x: number; y: number }): number =>
    anchor === 'bottom' ? e.clientY - s.y : e.clientX - s.x;
  const onHandleDown = (e: React.PointerEvent): void => {
    dragStart.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent): void => {
    const s = dragStart.current;
    const p = paperRef.current;
    if (!s || !p) return;
    const out = Math.max(0, outDelta(e, s));
    p.style.transition = 'none';
    p.style.transform = anchor === 'bottom' ? `translateY(${out}px)` : `translateX(${out}px)`;
  };
  const onHandleUp = (e: React.PointerEvent): void => {
    const s = dragStart.current;
    dragStart.current = null;
    const p = paperRef.current;
    if (!s) return;
    const out = outDelta(e, s);
    if (out > SWIPE_CLOSE_PX) {
      // Hand the transform back to MUI; its exit slide animates the rest out.
      if (p) { p.style.transition = ''; p.style.transform = ''; }
      onClose();
    } else if (p) {
      // Snap back to docked.
      p.style.transition = 'transform 160ms ease';
      p.style.transform = '';
    }
  };
  const onHandleCancel = (): void => {
    dragStart.current = null;
    const p = paperRef.current;
    if (p) { p.style.transition = ''; p.style.transform = ''; }
  };

  const total = tip ? tip.players + tip.enemies + tip.neutrals + tip.structures : 0;

  return (
    // Portal to <body> so the drawer escapes the host chrome / GameSurface
    // stacking traps: its Paper z (Z.drawer) then lives at the body level, ABOVE
    // the gameplay HUD slot hosts (Z.mobileControls) whose action bar it overlaps
    // when docked. Without this, a z=1200 Paper nested in a z-auto chrome can't
    // beat a body-level z=15 sibling (CSS stacking-context isolation).
    <Portal>
    <Drawer
      variant="persistent"
      anchor={anchor}
      open={open}
      data-testid="sector-info-drawer"
      PaperProps={{
        ref: paperRef,
        sx: anchor === 'right' ? PAPER_RIGHT : PAPER_BOTTOM,
        // E2E hook for the live selection.
        ['data-drawer-sector' as string]: sectorKey ?? '',
      }}
    >
      {/* Grab handle (swipe-to-close). */}
      <Box
        sx={HANDLE_WRAP_SX}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleCancel}
        data-testid="sector-drawer-handle"
        aria-label="Drag to close"
      >
        <Box sx={{ width: anchor === 'bottom' ? 40 : 4, height: anchor === 'bottom' ? 4 : 40, borderRadius: 2, bgcolor: '#3a4660' }} />
      </Box>

      {!tip || !sectorKey ? (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
          <Typography sx={{ color: '#6b7280', fontSize: 12 }}>Select a sector</Typography>
        </Box>
      ) : (
        <>
          <Box sx={HEADER_SX}>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ color: '#dffff0', fontSize: 14, fontWeight: 700, lineHeight: 1.15 }} noWrap>
                {tip.name}
              </Typography>
              <Typography sx={{ color: '#8fe9c0', fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                {/* Everything is NEUTRAL today (no capture/faction mechanics — Phase 9
                    item 1); the server's region `owner` is cosmetic-static. Show
                    Neutral until real ownership exists, then switch to `tip.status`. */}
                Neutral
              </Typography>
            </Box>
            {recentCombat && (
              <Typography
                data-testid="sector-drawer-combat-icon"
                title="Recent combat"
                sx={{ color: '#ff7043', fontSize: 14, flex: '0 0 auto' }}
              >
                ⚔
              </Typography>
            )}
          </Box>

          <Box sx={SCROLL_SX}>
            {/* Above-the-fold breakdown — the SHARED entity badges (same visual
                language as the galaxy-map count badges) + plain-language labels
                that explain each one. */}
            {total > 0 ? (
              <Stack spacing={0} sx={{ mt: 0.5 }} data-testid="sector-drawer-breakdown">
                {tip.enemies > 0 && <BadgeRow kind="hostile" count={tip.enemies} />}
                {tip.neutrals > 0 && <BadgeRow kind="neutral" count={tip.neutrals} />}
                {tip.players > 0 && <BadgeRow kind="ship" count={tip.players} />}
                {tip.structures > 0 && <BadgeRow kind="structure" count={tip.structures} />}
              </Stack>
            ) : (
              <Typography sx={{ color: '#6b7280', fontSize: 10, mt: 0.5 }} data-testid="sector-drawer-breakdown">
                No ships or structures here.
              </Typography>
            )}
            {tip.features.length > 0 && (
              <Typography sx={{ color: '#7a8499', fontSize: 9, mt: 0.25, textTransform: 'capitalize' }}>
                {tip.features.join(' · ')}
              </Typography>
            )}

            {/* Recent events (Equinox Phase 9 item 5) — same entity badges + labels. */}
            <Typography sx={SECTION_LABEL_SX}>Recent activity</Typography>
            {recentCombat && (recentCombat.shipsDestroyed > 0 || recentCombat.structuresDestroyed > 0) ? (
              <Box data-testid="sector-drawer-recent">
                {recentCombat.shipsDestroyed > 0 && (
                  <BadgeRow kind="ship" count={recentCombat.shipsDestroyed} labelSuffix=" destroyed" />
                )}
                {recentCombat.structuresDestroyed > 0 && (
                  <BadgeRow kind="structure" count={recentCombat.structuresDestroyed} labelSuffix=" destroyed" />
                )}
                <Typography sx={{ color: '#7a8499', fontSize: 8, mt: 0.4 }}>last 5 min</Typography>
              </Box>
            ) : (
              <Typography data-testid="sector-drawer-recent" sx={{ color: '#6b7280', fontSize: 10, mt: 0.25 }}>
                No recent activity
              </Typography>
            )}

            {/* Ships in sector — per-ship cards. */}
            <Typography sx={SECTION_LABEL_SX}>Your ships in sector</Typography>
            {ships.length > 0 ? (
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                {ships.map((s) => {
                  const kind = getShipKind(s.kind);
                  const frac = kind.maxHealth > 0 ? Math.max(0, Math.min(1, s.health / kind.maxHealth)) : 0;
                  const pct = Math.round(frac * 100);
                  return (
                  <Box key={s.shipId} sx={SHIP_CARD_SX} data-testid={`sector-drawer-ship-${s.shipId}`}>
                    <Box sx={{ flex: '0 0 auto', lineHeight: 0 }}>
                      <ShipSilhouette shape={kind.shape} size={28} />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ color: '#cfe', fontSize: 11, lineHeight: 1.1 }} noWrap>
                        {kindLabel(s.kind)}
                        {s.isActive ? ' · active' : ''}
                      </Typography>
                      {/* Hull bar (health / kind maxHealth) + last-known position. */}
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
                        <Box sx={{ flex: 1, height: 4, borderRadius: 2, bgcolor: '#26304a', overflow: 'hidden' }}>
                          <Box
                            data-testid={`sector-drawer-hull-${s.shipId}`}
                            data-hull-pct={pct}
                            sx={{ width: `${pct}%`, height: '100%', bgcolor: hullColor(frac) }}
                          />
                        </Box>
                        <Typography sx={{ color: '#8a93a8', fontSize: 8, flex: '0 0 auto' }}>{pct}%</Typography>
                      </Box>
                      <Typography sx={{ color: '#7a8499', fontSize: 8, lineHeight: 1.1 }} noWrap>
                        ({Math.round(s.x)}, {Math.round(s.y)})
                      </Typography>
                    </Box>
                    <Button
                      size="small"
                      variant="outlined"
                      data-testid={`sector-drawer-spawn-${s.shipId}`}
                      onClick={() => sectorKey && onSpawnExistingShip(s.shipId, sectorKey)}
                      sx={{
                        flex: '0 0 auto', color: '#cfe', borderColor: '#2a3550',
                        fontSize: 10, py: 0.1, px: 1, textTransform: 'none',
                        '&:hover': { borderColor: '#66ffcc' },
                      }}
                    >
                      Spawn
                    </Button>
                  </Box>
                  );
                })}
              </Stack>
            ) : (
              <Typography sx={{ color: '#6b7280', fontSize: 10, mt: 0.5 }}>None</Typography>
            )}
          </Box>

          {/* Fixed action bar — red ✕ + wide Join/Warp CTA. */}
          <Box sx={ACTIONBAR_SX}>
            <IconButton
              size="small"
              data-testid="sector-drawer-close"
              aria-label="Close sector info"
              onClick={onClose}
              sx={{ flex: '0 0 auto', color: '#ff6b6b', border: '1px solid #5a2530', borderRadius: 1, '&:hover': { bgcolor: 'rgba(255,107,107,0.12)' } }}
            >
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
            {isWarp ? (
              warpable ? (
                <Button
                  fullWidth
                  size="small"
                  variant="contained"
                  data-testid="sector-drawer-warp"
                  onClick={() => sectorKey && onWarp(sectorKey)}
                  sx={{ flex: 1, bgcolor: '#0088cc', color: '#04140b', fontWeight: 700, fontSize: 12, '&:hover': { bgcolor: '#33bbff' } }}
                >
                  Warp here
                </Button>
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
                  Join sector
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
    </Drawer>
    </Portal>
  );
}
