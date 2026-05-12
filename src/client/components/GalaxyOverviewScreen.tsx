import { useState, useEffect, useRef } from 'react';
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
  IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  GalaxyOverviewRenderer,
  type GalaxyOverviewMode,
} from '../render/galaxy/GalaxyOverviewRenderer';
import { getSector } from '../../core/galaxy/galaxy';
import { loadStoredPlayerId } from '../identity/token';
import { ShipPickerModal } from './ShipPickerModal';
import { ShipRosterPanel } from './ShipRosterPanel';
import { useUIStore } from '../state/store';
import { useIsCompact } from '../layout/useIsCompact';
import type { ShipKindId } from '../../shared-types/shipKinds';
import { logEvent } from '../debug/ClientLogger';

/** Delay between sector tap and picker mount, in milliseconds. Long
 *  enough to drain the originating touchend (~50 ms on slow phones is
 *  the empirical ceiling), short enough that the UI still feels
 *  responsive. 200 ms is comfortably above both. */
const PICKER_OPEN_DELAY_MS = 200;

interface LimboSummary {
  sectorKey: string;
}

interface EngineeringRoom {
  roomName: string;
  label: string;
  description: string;
}

const ENGINEERING_ROOMS: EngineeringRoom[] = [
  { roomName: 'sector',          label: 'Sector (legacy)',     description: 'Original Phase-1..7 default room. 30-drone hostile ring, no persistence.' },
  { roomName: 'test-sector',     label: 'Test Sector',         description: 'Deterministic E2E room. Zero drones, zero asteroids.' },
  { roomName: 'feel-test',       label: 'Feel Test (10)',      description: 'AI lockstep / network-feel test room. 10 drones in a 300 u ring around origin; player spawns at (0,0).' },
  { roomName: 'swarm-soak',      label: 'Swarm Soak (500)',    description: 'Phase 5e bandwidth + perf soak. 500 mixed entities. Stress room — server can hitch under combat.' },
  { roomName: 'swarm-tidi',      label: 'Swarm TiDi (4000)',   description: 'Phase 6 stress room. 4000 entities; TiDi rarely engages.' },
  { roomName: 'swarm-tidi-burn', label: 'Swarm TiDi (burn)',   description: 'Phase 6 synthetic burn. Forces TiDi to ramp to its 0.7× floor.' },
];

interface GalaxyOverviewScreenProps {
  /**
   * Selection rules:
   *  - 'spawn': any sector tappable; limbo override forces resume.
   *  - 'warp':  only neighbours of `currentSectorKey` are tappable.
   */
  mode: GalaxyOverviewMode;
  /**
   * Spawn-mode entry point: called with a room name (galaxy-${key} or
   * engineering room) when the player picks. Must be provided in spawn mode.
   */
  onSelectRoom?: (roomName: string) => void;
  /**
   * Phase 3 multi-ship — called when the player picks a specific ship
   * from the roster panel's detail modal. Parent routes to a Colyseus
   * `joinOrCreate('sector', { shipId, ... })` so the server binds that
   * exact roster row instead of the default most-recent.
   */
  onSpawnExistingShip?: (shipId: string, sectorKey: string) => void;
  /**
   * Phase 3 multi-ship — called when the player picks a sector on the
   * map and then picks a kind in the post-click ShipPickerModal. Parent
   * routes to `joinOrCreate('sector', { shipKind, isNewShip: true })`
   * so the server creates a fresh roster entry instead of resuming.
   */
  onSpawnNewShip?: (kind: ShipKindId, sectorKey: string) => void;
  /** Spawn-mode local-diagnostic entry. */
  onSelectLocal?: () => void;
  /** Warp-mode tap handler — receives the chosen neighbour key. */
  onPickNeighbour?: (sectorKey: string) => void;
  /** Warp-mode close button. */
  onClose?: () => void;
  /** Optional pre-resolved limbo sector (skips internal /dev/limbo fetch). */
  activeLimboSectorKey?: string | null;
}

/**
 * Pixi-rendered galaxy overview. Used in two roles:
 *  - mode='spawn': post-auth landing / spawn-select. Replicates the legacy
 *    GalaxyMapScreen UX (limbo banner, ship picker, single-player diagnostic,
 *    engineering rooms) but draws the hex map onto a Pixi canvas with
 *    drag/pinch/wheel pan & zoom. Limbo override: when the player has a held
 *    ship, only that sector is selectable, with an in-canvas RESUME pulse and
 *    the React-side stats banner kept for parity with the existing E2E.
 *  - mode='warp': lightweight in-game viewer reached from the drawer's Galaxy
 *    tab. Only neighbours of the current sector are selectable; non-neighbours
 *    render as faint outlines for spatial context. Tapping an adjacent sector
 *    fires `onPickNeighbour`; the parent calls `engageTransit` and closes.
 */
export function GalaxyOverviewScreen({
  mode,
  onSelectRoom,
  onSpawnExistingShip,
  onSpawnNewShip,
  onSelectLocal,
  onPickNeighbour,
  onClose,
  activeLimboSectorKey,
}: GalaxyOverviewScreenProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GalaxyOverviewRenderer | null>(null);

  const currentSectorKey = useUIStore((s) => s.currentSectorKey);
  const selectedShipKindId = useUIStore((s) => s.selectedShipKind);
  const setSelectedShipKind = useUIStore((s) => s.setSelectedShipKind);
  const isCompact = useIsCompact();
  const storedPlayerId = loadStoredPlayerId() ?? '';

  const [engineeringOpen, setEngineeringOpen] = useState(false);
  // Phase 3 — sector-click → kind-picker → spawn confirmation flow.
  // When the player taps a sector on the map (renderer onPick) we stash
  // the sectorKey here and open the picker. Picking a kind fires
  // onSpawnNewShip(kind, sectorKey) with the captured sector.
  //
  // Tap-shield: the diagnostic capture (2026-05-12T19-50) showed only
  // 72 ms between `galaxy_sector_click` and `ship_picker_select` — far
  // too fast for a deliberate human click. What was happening: the same
  // touch that selected the sector hex bled through onto the picker
  // modal mounted under the player's finger, auto-resolving whichever
  // card landed at that screen position. We defer the modal mount by
  // PICKER_OPEN_DELAY_MS so the rogue touchend has fully drained before
  // the modal becomes interactive.
  const [pendingSpawnSector, setPendingSpawnSector] = useState<string | null>(null);
  // Capture into a ref so the renderer's mount-once onPick callback
  // sees the latest setter (the setter from useState is stable, but
  // we route through a ref for parity with onSelectRoomRef below).
  const setPendingSpawnSectorRef = useRef(setPendingSpawnSector);
  useEffect(() => { setPendingSpawnSectorRef.current = setPendingSpawnSector; }, []);

  // --- Limbo lookup (spawn-mode only) ---
  const [limboSummary, setLimboSummary] = useState<LimboSummary | null>(null);
  useEffect(() => {
    if (mode !== 'spawn') return;
    if (activeLimboSectorKey !== undefined) return;
    let cancelled = false;
    const playerId = loadStoredPlayerId();
    if (!playerId) return;
    (async () => {
      try {
        const res = await fetch(`/dev/limbo?playerId=${encodeURIComponent(playerId)}`);
        if (!res.ok) return;
        const body = await res.json() as { exists?: boolean; sectorKey?: string };
        if (!cancelled && body.exists && typeof body.sectorKey === 'string') {
          setLimboSummary({ sectorKey: body.sectorKey });
        }
      } catch {
        // 404 / offline — treat as no limbo.
      }
    })();
    return () => { cancelled = true; };
  }, [mode, activeLimboSectorKey]);

  const effectiveLimboSectorKey =
    mode === 'spawn'
      ? (activeLimboSectorKey ?? limboSummary?.sectorKey ?? null)
      : null;
  const limboSector = effectiveLimboSectorKey ? getSector(effectiveLimboSectorKey) : null;

  // --- Pick handler — bridges the renderer's onPick callback into the
  //     prop-driven mode behaviour. The renderer itself is mount-once
  //     (creating a Pixi Application is expensive), so we route the
  //     onPick body through a ref that's updated on every render. That
  //     way Vite Fast Refresh updates to this file flow through the
  //     existing renderer instance without needing to recreate it. ---
  const onSelectRoomRef = useRef(onSelectRoom);
  const onPickNeighbourRef = useRef(onPickNeighbour);
  useEffect(() => { onSelectRoomRef.current = onSelectRoom; }, [onSelectRoom]);
  useEffect(() => { onPickNeighbourRef.current = onPickNeighbour; }, [onPickNeighbour]);
  const onPickBodyRef = useRef<(key: string) => void>(() => { /* set on mount */ });

  // --- Mount the Pixi renderer once. Mode is captured at mount time and
  //     propagated via setMode() / setLimbo() / setCurrentSector() on prop
  //     changes so we never tear the renderer down mid-session. ---
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    let disposed = false;

    // Mount-once: the renderer reads the up-to-date onPick body from a
    // ref every click. That keeps Fast Refresh updates to the
    // sector-click flow (e.g. swapping in / out the kind-picker
    // intercept) live without recreating the Pixi Application.
    const renderer = new GalaxyOverviewRenderer({
      onPick: (key) => { onPickBodyRef.current(key); },
    });
    rendererRef.current = renderer;

    // Init is async (Pixi Application bootstrap). Catch errors so a Pixi
    // failure (e.g. headless Chromium running out of WebGL contexts when
    // gameplay's PixiRenderer is also live) doesn't propagate as an
    // unhandled rejection that crashes the page; the React UI still
    // renders the testid'd container even if the canvas mount fails.
    renderer
      .init(el, {
        mode,
        currentSectorKey,
        // Phase 3 — multi-ship: don't lock other sectors when a Limbo
        // entry exists. The roster panel surfaces lingering ships
        // separately; all sectors stay selectable so the player can
        // spawn a new ship anywhere.
        limbo: null,
      })
      .then(() => {
        if (disposed) renderer.destroy();
      })
      .catch((err: unknown) => {
        console.error('[GalaxyOverviewScreen] renderer.init failed', err);
      });

    return () => {
      disposed = true;
      renderer.destroy();
      rendererRef.current = null;
    };
    // Mount-once: subsequent prop changes flow through dedicated effects.
  }, []);

  // Keep the renderer's onPick body in sync with the latest mode +
  // callback wiring. Runs on every render — the ref read inside the
  // mount-once renderer always picks up the freshest closure, so
  // sector clicks behave according to the current source code even
  // when Vite Fast Refresh has preserved the renderer instance.
  onPickBodyRef.current = (key: string): void => {
    const t0 = performance.now();
    logEvent('galaxy_sector_click', { key, mode, ts: t0 });
    if (mode === 'spawn') {
      // Defer the picker open so the originating touchend finishes
      // bubbling before the modal mounts. Otherwise the same touch
      // auto-resolves whichever card lands under the user's finger.
      window.setTimeout(() => {
        const t1 = performance.now();
        logEvent('picker_open_scheduled', { key, dispatchLatencyMs: t1 - t0 });
        setPendingSpawnSectorRef.current(key);
      }, PICKER_OPEN_DELAY_MS);
    } else {
      onPickNeighbourRef.current?.(key);
    }
  };
  // Belt-and-braces against Fast Refresh: also push the latest callback
  // into the renderer instance directly on every render. The mount-once
  // useEffect wires the initial onPick; this re-wires it whenever the
  // surrounding component re-renders, so a preserved renderer always
  // ends up calling the freshest closure.
  if (rendererRef.current !== null) {
    rendererRef.current.setOnPick((key) => onPickBodyRef.current(key));
  }

  // Reflect prop / store changes onto the live renderer.
  useEffect(() => {
    rendererRef.current?.setMode(mode);
  }, [mode]);
  useEffect(() => {
    rendererRef.current?.setCurrentSector(currentSectorKey);
  }, [currentSectorKey]);
  useEffect(() => {
    // Phase 3 — always pass null; multi-ship roster handles "you have a
    // ship here" affordance via the floating panel, not the renderer's
    // sector-lock constraint.
    rendererRef.current?.setLimbo(null);
  }, [effectiveLimboSectorKey]);

  // ----- Render -----

  if (mode === 'warp') {
    return (
      <Box
        data-testid="galaxy-overview-warp"
        sx={{
          position: 'absolute',
          inset: 0,
          bgcolor: '#05070f',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          ref={mountRef}
          sx={{ flex: 1, minHeight: 0, position: 'relative', touchAction: 'none' }}
        />
        <IconButton
          onClick={onClose}
          data-testid="galaxy-overview-close"
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            color: '#9aa0b4',
            bgcolor: 'rgba(5,7,15,0.7)',
            border: '1px solid #2a2f40',
            '&:hover': { borderColor: '#1f7a4d', color: '#00ff88' },
          }}
          aria-label="Close galaxy overview"
        >
          <CloseIcon />
        </IconButton>
        <Box
          sx={{
            position: 'absolute',
            top: 12,
            left: 16,
            color: '#9aa0b4',
            fontFamily: 'monospace',
            fontSize: 12,
            letterSpacing: 2,
            textTransform: 'uppercase',
            pointerEvents: 'none',
          }}
        >
          Galaxy · tap a neighbour to warp
        </Box>
      </Box>
    );
  }

  // mode === 'spawn'
  return (
    <Box
      data-testid="galaxy-map-screen"
      sx={{
        position: 'fixed',
        inset: 0,
        pt: 'var(--app-bar-h, 48px)',
        bgcolor: '#05070f',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Phase 3 multi-ship: the legacy "Resume in {Sector}" pill is gone.
       *  The roster panel surfaces lingering / stored ships per-card; the
       *  galaxy map now treats every sector as equally selectable. The
       *  testid stub is preserved at zero height so existing E2E specs
       *  that probe `data-limbo-sector-key` still resolve to a stable
       *  DOM node. */}
      <Box
        data-testid="limbo-resume-banner"
        data-limbo-sector-key={limboSector?.key ?? ''}
        sx={{ display: 'none' }}
      />

      {/* Phase 3: canvas is full-width; roster panel floats over it as a
       *  small transparent overlay so the galaxy map breathes underneath.
       *  Position differs by orientation (right edge on landscape, bottom
       *  strip on portrait phone). */}
      <Box
        ref={mountRef}
        sx={{
          flex: 1,
          minHeight: 0,
          mx: 'auto',
          width: 'min(1280px, 98vw)',
          position: 'relative',
          touchAction: 'none',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            pointerEvents: 'none',
            // Portrait phone: anchor to the TOP edge so the panel doesn't
            // fight for space with the bottom-right Engineering /
            // Single-Player Diagnostic buttons. Landscape / desktop: keep
            // it on the right edge as a slim column.
            ...(isCompact
              ? { left: 8, right: 8, top: 8, height: 60 }
              : { right: 8, top: 8, bottom: 8, width: 156 }),
          }}
        >
          <ShipRosterPanel
            playerId={storedPlayerId}
            compact={isCompact}
            onSpawn={(shipId, sectorKey) => {
              onSpawnExistingShip?.(shipId, sectorKey);
            }}
          />
        </Box>
      </Box>

      <Box sx={{ minHeight: 24, px: 3, pb: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="caption" sx={{ color: '#555', textAlign: 'center', fontSize: 10 }}>
          {limboSector
            ? 'Other sectors are locked while your ship is in flight.'
            : 'Tap a sector to spawn a new ship · tap a card to resume an existing one.'}
        </Typography>
      </Box>

      <Stack
        direction="row"
        spacing={2}
        sx={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          alignItems: 'center',
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

      {/* Phase 3 — sector-click confirmation. Picker opens when the user
       *  taps a galaxy sector hex; picking a kind fires onSpawnNewShip
       *  with the captured sector and clears the pending state. */}
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
