import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
  Alert,
  CircularProgress,
} from '@mui/material';
import { getSector } from '../../core/galaxy/galaxy';
import { loadStoredPlayerId } from '../identity/token';
import { ShipPickerModal } from './ShipPickerModal';
import { acquireRosterPolling, releaseRosterPolling } from './rosterPoller';
import { useUIStore } from '../state/store';
import type { ShipKindId } from '../../shared-types/shipKinds';
import { logEvent } from '../debug/ClientLogger';
import { useMountLog } from '../debug/useMountLog';
import { buildSectorTooltip, shipsInSector } from './galaxyTooltip';
import { SectorInfoDrawer } from './SectorInfoDrawer';
import { isSectorWarpable } from '../render/galaxy/galaxyLayerDecisions';
import { isTouchDevice } from '../input/TouchInput';
import { Z } from '../layout/zIndex';
import type { MutableRefObject } from 'react';

interface EngineeringRoom {
  roomName: string;
  label: string;
  description: string;
}

/** Phase 2 #2 — one-shot loading overlay (static sx, hoisted per the drawer-perf
 *  rule) shown over the galaxy map until the first `/galaxy/snapshot` resolves, so
 *  the live count icons appear WITH the map instead of popping in out of sync. */
const GALAXY_LOADING_SX = {
  position: 'absolute' as const,
  inset: 0,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1.5,
  pointerEvents: 'none' as const,
  zIndex: 2,
};

const ENGINEERING_ROOMS: EngineeringRoom[] = [
  { roomName: 'sector',          label: 'Sector (legacy)',     description: 'Original Phase-1..7 default room. 30-drone hostile ring, no persistence.' },
  { roomName: 'test-sector',     label: 'Test Sector',         description: 'Deterministic E2E room. Zero drones, zero asteroids.' },
  { roomName: 'shield-test',     label: 'Shield Test (5)',     description: 'Five non-hostile drones (one of each non-fighter kind) in a 200 u ring. Ram + shoot to verify shield bubble math. Drones only turn hostile after they take damage.' },
  { roomName: 'hull-collision-test', label: 'Hull Collision (T-pair)', description: 'Two stationary Crossguard T-ships, shields off, stem-tips facing with a 20 u gap. Bounding circles overlap massively but polygon hulls do NOT touch. Negative control for concave-hull collision correctness — server log should show NO collision_resolved between the pair.' },
  { roomName: 'hull-collision-overlap-test', label: 'Hull Collision (overlap +control)', description: 'Two Crossguards stacked at (0,0), shields off. POSITIVE control: polygons fully overlap so collision_resolved + ram_damage must fire constantly. If they do NOT, the test surface is dead.' },
  { roomName: 'mount-test',      label: 'Mount Test (6)',      description: 'Phase 4c turret refactor room. 6 interceptor+gunship drones in a 250 u ring for verifying rotating-mount visuals.' },
  { roomName: 'feel-test',       label: 'Feel Test (10)',      description: 'AI lockstep / network-feel test room. 10 drones in a 300 u ring around origin; player spawns at (0,0).' },
  { roomName: 'swarm-soak',      label: 'Swarm Soak (500)',    description: 'Phase 5e bandwidth + perf soak. 500 mixed entities. Stress room — server can hitch under combat.' },
  { roomName: 'swarm-tidi',      label: 'Swarm TiDi (4000)',   description: 'Phase 6 stress room. 4000 entities; TiDi rarely engages.' },
  { roomName: 'swarm-tidi-burn', label: 'Swarm TiDi (burn)',   description: 'Phase 6 synthetic burn. Forces TiDi to ramp to its 0.7× floor.' },
];

/**
 * Imperative handle exposed by {@link GalaxyPickerChrome} so the host
 * (which owns the shared canvas + the galaxy selector layer) can open
 * the kind-picker when the player taps a sector on the Pixi map.
 */
export interface GalaxyPickerApi {
  /**
   * Open the ship-kind picker for a tapped sector. SYNCHRONOUS — the
   * caller owns any tap-shield deferral, because the tap originates on
   * the Pixi canvas and the bleed-through guard belongs at the tap site
   * (single-canvas refactor; the old in-renderer 200 ms defer moved to
   * the host's onSelectorPick wiring).
   */
  openForSector(sectorKey: string): void;
  /**
   * Equinox Phase 9 — BLUR/deselect: close the SectorInfoDrawer + clear the
   * selection. Fired by the host when a galaxy tap hits no hex (empty space).
   */
  deselect(): void;
}

export interface GalaxyPickerChromeProps {
  /** Set by the chrome on mount so the host can drive the picker. */
  apiRef?: MutableRefObject<GalaxyPickerApi | null>;
  /** Engineering-room / single-player entry points. */
  onSelectRoom?: (roomName: string) => void;
  onSpawnExistingShip?: (shipId: string, sectorKey: string) => void;
  onSpawnNewShip?: (kind: ShipKindId, sectorKey: string) => void;
  onSelectLocal?: () => void;
  /** Pre-resolved limbo sector; when omitted the chrome runs its own
   *  /dev/limbo lookup (matches the legacy spawn-screen behaviour). */
  activeLimboSectorKey?: string | null;
  /** Equinox Phase 7 (Item 1) — `'landing'` (default, post-auth spawn picker) or
   *  `'warp'` (the in-game full-page map opened by the Map button). In `'warp'`
   *  the popover's CTA is "Warp here" (adjacent only) instead of "Join the
   *  fight", landing-only chrome (engineering/single-player/landing-info) is
   *  hidden, and a Close button is shown. */
  context?: 'landing' | 'warp';
  /** Warp to an adjacent sector (warp context only). */
  onWarp?: (sectorKey: string) => void;
  /** Close the in-game warp map (warp context only). */
  onClose?: () => void;
}

/**
 * The React chrome of the post-auth galaxy picker, WITHOUT any Pixi
 * surface of its own. It is transparent overlay UI layered over the
 * single shared gameplay canvas (which draws the hex map via
 * `GalaxyMapLayer` in selector mode). Extracted from
 * `GalaxyOverviewScreen` (spawn mode) so the second Pixi `Application`
 * can be retired. Preserves every load-bearing testid:
 * `galaxy-map-screen`, `limbo-resume-banner` (+ `data-limbo-sector-key`),
 * the roster panel, `single-player-button`, `engineering-rooms-button`,
 * and the `ship-picker-modal`.
 *
 * The root is `pointerEvents: 'none'` so taps in empty regions fall
 * through to the canvas (the galaxy layer's hit-test); interactive
 * children re-enable pointer events.
 */
export function GalaxyPickerChrome({
  apiRef,
  onSelectRoom,
  onSpawnExistingShip,
  onSpawnNewShip,
  onSelectLocal,
  activeLimboSectorKey,
  context = 'landing',
  onWarp,
  onClose,
}: GalaxyPickerChromeProps): JSX.Element {
  useMountLog('GalaxyPickerChrome', { context });
  const isWarp = context === 'warp';
  const selectedShipKindId = useUIStore((s) => s.selectedShipKind);
  const setSelectedShipKind = useUIStore((s) => s.setSelectedShipKind);
  // Living Galaxy P5 — folded MetaLandingScreen bits (server health + live
  // player count), surfaced over the map now that it's the landing screen.
  const serverHealth = useUIStore((s) => s.serverHealth);
  const playersOnline = useUIStore((s) => s.playersOnline);
  // Living Galaxy Phase 6 — hovered sector + live stats drive the tooltip.
  const galaxyHover = useUIStore((s) => s.galaxyHover);
  const galaxyStats = useUIStore((s) => s.galaxyStats);
  // Phase 2 #2 — false until the first /galaxy/snapshot poll resolves; drives the
  // one-shot loading spinner so the map's live counts don't pop in out of sync.
  const galaxyStatsLoaded = useUIStore((s) => s.galaxyStatsLoaded);
  // Equinox Phase 7 (Item 4) — the popover's "your ships" sub-list reads the
  // roster + live current sector. The visible top-bar roster panel is gone; we
  // still POLL it (refcounted singleton) so the popover has data.
  const shipRoster = useUIStore((s) => s.shipRoster);
  const currentSectorKey = useUIStore((s) => s.currentSectorKey);
  // Equinox Phase 7 (Item 1) — warp context gates "Warp here" on the player being
  // DOCKED + the sector being an adjacent neighbour.
  const transitState = useUIStore((s) => s.transitState);
  const storedPlayerId = loadStoredPlayerId() ?? '';

  const [engineeringOpen, setEngineeringOpen] = useState(false);
  const [pendingSpawnSector, setPendingSpawnSector] = useState<string | null>(null);
  // Equinox Phase 9 (item 2) — a hex tap SELECTS a sector, opening the docked
  // SectorInfoDrawer (replaces the old fixed popover; the desktop hover tooltip is
  // separate + kept). The drawer reads this key; ✕ / swipe deselects.
  const [selectedSectorKey, setSelectedSectorKey] = useState<string | null>(null);

  // Keep the roster polled while the picker is mounted (the popover sub-list +
  // RosterCountBadge consume store.shipRoster). Refcounted — safe alongside the
  // drawer Galaxy-tab panel.
  useEffect(() => {
    if (!storedPlayerId) return undefined;
    acquireRosterPolling(storedPlayerId);
    return () => releaseRosterPolling();
  }, [storedPlayerId]);

  // --- Limbo lookup (populates data-limbo-sector-key for E2E + the
  //     caption copy). The roster panel surfaces lingering ships per-card;
  //     all sectors stay selectable so the player can spawn anywhere. ---
  const [limboSectorKey, setLimboSectorKey] = useState<string | null>(null);
  useEffect(() => {
    if (activeLimboSectorKey !== undefined) {
      setLimboSectorKey(activeLimboSectorKey);
      return;
    }
    let cancelled = false;
    const playerId = loadStoredPlayerId();
    if (!playerId) return;
    (async () => {
      try {
        const res = await fetch(`/dev/limbo?playerId=${encodeURIComponent(playerId)}`);
        if (!res.ok) return;
        const body = await res.json() as { exists?: boolean; sectorKey?: string };
        if (!cancelled && body.exists && typeof body.sectorKey === 'string') {
          setLimboSectorKey(body.sectorKey);
        }
      } catch {
        // 404 / offline — treat as no limbo.
      }
    })();
    return () => { cancelled = true; };
  }, [activeLimboSectorKey]);
  const limboSector = limboSectorKey ? getSector(limboSectorKey) : null;

  // Expose the imperative opener to the host (the shared-canvas owner).
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      openForSector: (key: string) => {
        logEvent('picker_open_scheduled', { key, ts: performance.now() });
        // Equinox Phase 9 (item 2) — a hex tap SELECTS the sector → the docked
        // SectorInfoDrawer (sector info + your ships + recent activity + Join/Warp),
        // NOT the ship-picker directly. TOGGLE: re-tapping the already-selected
        // sector DESELECTS it and dismisses the drawer (the user's "dismiss the
        // drawer when you deselect"). On touch there's no empty-canvas deselect
        // target and no hover-to-dismiss, so re-tapping the hex is the
        // discoverable deselect gesture (plus the ✕ and swipe-down handle). The
        // functional updater reads the latest selection, so the once-set apiRef
        // closure never goes stale.
        setSelectedSectorKey((cur) => (cur === key ? null : key));
      },
      // Empty-space tap (blur) → close the drawer + deselect.
      deselect: () => { setSelectedSectorKey(null); },
    };
    return () => { if (apiRef) apiRef.current = null; };
  }, [apiRef]);

  // Living Galaxy Phase 6 — derive the hovered-sector tooltip content (pure).
  const sectorTip = galaxyHover ? buildSectorTooltip(galaxyHover.sectorKey, galaxyStats) : null;
  // Equinox Phase 9 (item 2) — the SELECTED sector's drawer content (sector
  // breakdown + the player's ships there + recent combat), all pure.
  const drawerTip = selectedSectorKey ? buildSectorTooltip(selectedSectorKey, galaxyStats) : null;
  const drawerShips = selectedSectorKey ? shipsInSector(shipRoster, selectedSectorKey, currentSectorKey) : [];
  const drawerRecentCombat = selectedSectorKey
    ? (galaxyStats.find((s) => s.key === selectedSectorKey)?.recentCombat ?? null)
    : null;
  // Equinox Phase 7 (Item 1) — is the selected sector a warp target (warp context
  // + docked + adjacent neighbour)?
  const drawerWarpable = selectedSectorKey
    ? isSectorWarpable({ docked: transitState === 'DOCKED', currentSectorKey, sectorKey: selectedSectorKey })
    : false;

  return (
    <Box
      data-testid="galaxy-map-screen"
      sx={{
        position: 'fixed',
        inset: 0,
        pt: 'var(--app-bar-h, 48px)',
        // Transparent — the shared canvas underneath IS the backdrop.
        // pointerEvents:none lets empty-region taps reach the galaxy
        // layer's hit-test; interactive children re-enable below.
        pointerEvents: 'none',
        // Equinox Phase 9 (item 2) — in the in-game WARP map the gameplay HUD
        // (bottom-right AUTO/FIRE/BOOST) is a body-level z=Z.mobileControls(15)
        // host, so the SectorInfoDrawer's z (1200) is trapped inside this
        // z-auto chrome root and can't beat it. Lift the whole (still
        // pointer-none) chrome above the HUD here so the docked drawer's action
        // bar is clickable; below the app bar + modals. Landing has no HUD, so
        // no lift is needed there.
        ...(isWarp ? { zIndex: Z.drawer } : {}),
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Phase 3 multi-ship: the "Resume in {Sector}" pill is gone; the
       *  testid stub is preserved at zero height so existing E2E specs
       *  that probe `data-limbo-sector-key` still resolve. */}
      <Box
        data-testid="limbo-resume-banner"
        data-limbo-sector-key={limboSector?.key ?? ''}
        sx={{ display: 'none' }}
      />

      {/* Phase 2 #2 — one-shot loading spinner over the whole map until the first
       *  /galaxy/snapshot resolves, so the live count icons appear WITH the map
       *  rather than popping in ~a few hundred ms later ("out of sync"). */}
      {!galaxyStatsLoaded && (
        <Box data-testid="galaxy-loading" sx={GALAXY_LOADING_SX}>
          <CircularProgress size={28} thickness={4} sx={{ color: '#00ff88' }} />
          <Typography variant="caption" sx={{ color: '#9aa0b4', fontSize: 10, letterSpacing: 0.5 }}>
            Charting the galaxy…
          </Typography>
        </Box>
      )}

      {/* Living Galaxy P5 — folded landing info over the map (replaces the
       *  retired MetaLandingScreen's banner + hype count). Non-interactive,
       *  small per the start-tiny rule. The server-health banner is the
       *  load-bearing surface while the server cold-boots. */}
      <Box
        data-testid="galaxy-landing-info"
        sx={{
          position: 'absolute',
          top: 'calc(var(--app-bar-h, 48px) + 8px)',
          left: 0,
          right: 0,
          // Equinox Phase 7 (Item 1) — landing-only; hidden on the in-game warp map.
          display: isWarp ? 'none' : 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          pointerEvents: 'none',
          zIndex: 1,
        }}
      >
        {(serverHealth === 'warming' || serverHealth === 'unreachable') && (
          <Alert
            severity={serverHealth === 'warming' ? 'info' : 'error'}
            variant="outlined"
            data-testid="server-health-banner"
            data-state={serverHealth}
            sx={{
              py: 0,
              fontSize: 11,
              bgcolor: serverHealth === 'warming' ? 'rgba(2,136,209,0.08)' : 'rgba(211,47,47,0.08)',
              color: serverHealth === 'warming' ? '#90caf9' : '#ef9a9a',
              '& .MuiAlert-icon': { color: serverHealth === 'warming' ? '#90caf9' : '#ef9a9a' },
            }}
          >
            {serverHealth === 'warming'
              ? 'Server is starting up — spawning will be ready in a moment.'
              : 'Server unavailable. Reconnecting…'}
          </Alert>
        )}
        <Typography
          data-testid="galaxy-landing-player-count"
          variant="caption"
          sx={{ color: '#9aa0b4', fontSize: 10, letterSpacing: 0.5 }}
        >
          <span style={{ color: '#00ff88' }} data-testid="galaxy-landing-player-count-number">
            {playersOnline !== null ? playersOnline.toLocaleString() : '—'}
          </span>{' '}
          pilots online
        </Typography>
      </Box>

      {/* Equinox Phase 7 (Item 4) — the floating top-bar roster panel is GONE;
       *  the per-sector popover's "your ships" sub-list replaces it (the roster
       *  is still polled above so the popover + RosterCountBadge have data). */}

      <Box sx={{ flex: 1, minHeight: 0 }} />

      <Box sx={{ minHeight: 24, px: 3, pb: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="caption" sx={{ color: '#555', textAlign: 'center', fontSize: 10 }}>
          {isWarp
            ? 'Tap a sector for info · highlighted neighbours are warp targets.'
            : limboSector
              ? 'Other sectors are locked while your ship is in flight.'
              : 'Tap a sector to spawn a new ship · tap a card to resume an existing one.'}
        </Typography>
      </Box>

      {!isWarp && !selectedSectorKey && (
      <Stack
        direction="row"
        spacing={2}
        sx={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          alignItems: 'center',
          pointerEvents: 'auto',
          // Above the roster panel (zIndex 2). The roster column hugs the
          // viewport's right edge now (the chrome is transparent over the
          // full-bleed shared canvas, not a centred max-width box like the
          // retired GalaxyOverviewScreen), so these CTAs would otherwise sit
          // under the roster's pointer-capture region.
          zIndex: 3,
        }}
      >
        {onSelectLocal && (
          <Button
            variant="text"
            size="small"
            onClick={onSelectLocal}
            sx={{ color: '#ff8800', '&:hover': { bgcolor: 'rgba(255,136,0,0.08)' } }}
            data-testid="single-player-button"
          >
            Single-Player Diagnostic
          </Button>
        )}
        <Button
          variant="outlined"
          size="small"
          onClick={() => setEngineeringOpen(true)}
          sx={{ color: '#9aa0b4', borderColor: '#2a2f40', '&:hover': { borderColor: '#9aa0b4' } }}
          data-testid="engineering-rooms-button"
        >
          Engineering rooms
        </Button>
      </Stack>
      )}

      {/* Equinox Phase 7 (Item 1) — Close button for the in-game warp map. */}
      {isWarp && (
        <Box
          component="button"
          data-testid="galaxy-warp-close"
          onClick={() => onClose?.()}
          aria-label="Close galaxy map"
          sx={{
            position: 'absolute',
            top: 'calc(var(--app-bar-h, 48px) + 12px)',
            right: 16,
            zIndex: 4,
            pointerEvents: 'auto',
            cursor: 'pointer',
            bgcolor: 'rgba(5,7,15,0.8)',
            color: '#9aa0b4',
            border: '1px solid #2a2f40',
            borderRadius: 1,
            px: 1.25,
            py: 0.5,
            fontSize: 12,
            fontWeight: 700,
            '&:hover': { borderColor: '#33ddff', color: '#fff' },
          }}
        >
          ✕ Close
        </Box>
      )}

      {/* Living Galaxy Phase 6 — sector tooltip on desktop hover. Anchored
       *  ABOVE-CENTRE of the hovered hex (Equinox Phase 9); non-interactive.
       *  Sector name + faction + status + live counts (icons) + features, from the
       *  static graph + the /galaxy/snapshot slice. Kept on desktop alongside the
       *  click-selected drawer (the doc: "desktop keeps the tooltips").
       *  DESKTOP-ONLY: on a touch device a tap synthesises a pointermove → a
       *  hover, which would flash this tooltip over the freshly-opened drawer
       *  (the user's "still shows the tooltip on mobile"). The drawer is the
       *  touch affordance; the hover tooltip is gated out entirely on touch. */}
      {!isTouchDevice() && galaxyHover && sectorTip && (
        <Box
          data-testid="galaxy-sector-tooltip"
          data-tooltip-sector={galaxyHover.sectorKey}
          sx={{
            position: 'fixed',
            // Equinox Phase 9 — anchored ABOVE-CENTRE of the hex. galaxyHover now
            // carries the hex's TOP-centre (GalaxyMapLayer.updateHover), so centre
            // the tooltip horizontally on it and float it just above (vs the old
            // down-right-of-cursor offset). `textAlign:center` keeps the copy tidy
            // under the centred anchor.
            left: galaxyHover.left,
            top: galaxyHover.top,
            transform: 'translate(-50%, calc(-100% - 6px))',
            textAlign: 'center',
            zIndex: 5,
            pointerEvents: 'none',
            bgcolor: 'rgba(8,12,24,0.94)',
            border: '1px solid #2a3550',
            borderRadius: 1,
            px: 1,
            py: 0.75,
            maxWidth: 220,
          }}
        >
          <Typography sx={{ color: '#dffff0', fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>
            {sectorTip.name}
          </Typography>
          <Typography sx={{ color: '#8fe9c0', fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            Neutral
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.75, mt: 0.5, flexWrap: 'wrap' }}>
            {sectorTip.players > 0 && (
              <Typography sx={{ color: '#6bff9b', fontSize: 10 }} title="Players">▲ {sectorTip.players}</Typography>
            )}
            {sectorTip.enemies > 0 && (
              <Typography sx={{ color: '#ff6b6b', fontSize: 10 }} title="Hostiles">✦ {sectorTip.enemies}</Typography>
            )}
            {sectorTip.neutrals > 0 && (
              <Typography sx={{ color: '#ffd479', fontSize: 10 }} title="Neutrals">◇ {sectorTip.neutrals}</Typography>
            )}
            {sectorTip.structures > 0 && (
              <Typography sx={{ color: '#9ab4dd', fontSize: 10 }} title="Structures">⬡ {sectorTip.structures}</Typography>
            )}
            {sectorTip.players + sectorTip.enemies + sectorTip.neutrals + sectorTip.structures === 0 && (
              <Typography sx={{ color: '#6b7280', fontSize: 10 }}>no activity</Typography>
            )}
          </Box>
          {sectorTip.features.length > 0 && (
            <Typography sx={{ color: '#7a8499', fontSize: 9, mt: 0.25, textTransform: 'capitalize' }}>
              {sectorTip.features.join(' · ')}
            </Typography>
          )}
        </Box>
      )}

      {/* Equinox Phase 9 (item 2) — the docked SectorInfoDrawer REPLACES the old
       *  fixed popover. A hex tap selects the sector → drawer (bottom in portrait,
       *  right in landscape; overlay, no scrim, so the map stays selectable); ✕ /
       *  swipe deselects. The desktop hover tooltip above is separate + kept. */}
      <SectorInfoDrawer
        open={selectedSectorKey !== null}
        sectorKey={selectedSectorKey}
        tip={drawerTip}
        ships={drawerShips}
        recentCombat={drawerRecentCombat}
        context={context}
        warpable={drawerWarpable}
        currentSectorKey={currentSectorKey}
        onClose={() => setSelectedSectorKey(null)}
        onSpawnExistingShip={(shipId, sector) => {
          logEvent('galaxy_drawer_resume', { shipId, sector });
          onSpawnExistingShip?.(shipId, sector);
          setSelectedSectorKey(null);
        }}
        onJoin={(sector) => {
          logEvent('galaxy_drawer_join', { sector });
          setPendingSpawnSector(sector);
          setSelectedSectorKey(null);
        }}
        onWarp={(sector) => {
          logEvent('galaxy_drawer_warp', { sector });
          onWarp?.(sector);
          setSelectedSectorKey(null);
        }}
      />

      {/* Sector-click confirmation. Opened imperatively via apiRef when the
       *  player taps a galaxy sector hex on the shared canvas; picking a
       *  kind fires onSpawnNewShip with the captured sector. */}
      <ShipPickerModal
        open={pendingSpawnSector !== null}
        onClose={() => {
          logEvent('ship_picker_close', { pendingSpawnSector, ts: performance.now() });
          setPendingSpawnSector(null);
        }}
        selectedKind={selectedShipKindId}
        title={pendingSpawnSector !== null
          ? `Spawn in ${getSector(pendingSpawnSector)?.name ?? pendingSpawnSector}`
          : undefined}
        subtitle={pendingSpawnSector !== null ? 'Pick a ship kind for this sector.' : undefined}
        onSelect={(kind) => {
          logEvent('ship_picker_select', { kind, pendingSpawnSector, ts: performance.now() });
          setSelectedShipKind(kind);
          if (pendingSpawnSector !== null) {
            onSpawnNewShip?.(kind, pendingSpawnSector);
            setPendingSpawnSector(null);
          }
        }}
      />

      <Dialog open={engineeringOpen} onClose={() => setEngineeringOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ bgcolor: '#0c1020', color: '#00ff88' }}>Engineering rooms</DialogTitle>
        <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc' }}>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Engineering rooms have no persistence. Disconnects lose all state.
          </Alert>
          <Stack spacing={1.5}>
            {ENGINEERING_ROOMS.map((r) => (
              <Box
                key={r.roomName}
                sx={{
                  p: 1.5,
                  border: '1px solid #2a2f40',
                  borderRadius: 1,
                  cursor: 'pointer',
                  '&:hover': { borderColor: '#1f7a4d', bgcolor: 'rgba(0,255,136,0.04)' },
                }}
                onClick={() => onSelectRoom?.(r.roomName)}
                data-testid={`engineering-room-${r.roomName}`}
              >
                <Typography variant="subtitle2" sx={{ color: '#00ff88' }}>{r.label}</Typography>
                <Typography variant="caption" sx={{ color: '#888' }}>{r.description}</Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ bgcolor: '#0c1020' }}>
          <Button onClick={() => setEngineeringOpen(false)} sx={{ color: '#9aa0b4' }}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
