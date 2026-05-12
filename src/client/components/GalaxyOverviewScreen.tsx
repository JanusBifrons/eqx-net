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
import { ShipRosterPanel } from './ShipRosterPanel';
import { useUIStore } from '../state/store';
import { useIsCompact } from '../layout/useIsCompact';

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
  onSelectLocal,
  onPickNeighbour,
  onClose,
  activeLimboSectorKey,
}: GalaxyOverviewScreenProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GalaxyOverviewRenderer | null>(null);

  const currentSectorKey = useUIStore((s) => s.currentSectorKey);
  const isCompact = useIsCompact();
  const storedPlayerId = loadStoredPlayerId() ?? '';

  const [engineeringOpen, setEngineeringOpen] = useState(false);
  // Phase 3 note: the legacy bottom-right ship-kind picker trigger is gone.
  // Fresh-sector spawns still use Zustand `selectedShipKind`; a future phase
  // can re-introduce `ShipPickerModal` as the sector-click confirmation
  // step. For now the user picks from their roster panel for resumes; new
  // spawns use whatever kind was last selected in their store.

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
  //     prop-driven mode behaviour. Captured in a ref so we can hand a
  //     stable reference to the Pixi renderer constructor. ---
  const onSelectRoomRef = useRef(onSelectRoom);
  const onPickNeighbourRef = useRef(onPickNeighbour);
  useEffect(() => { onSelectRoomRef.current = onSelectRoom; }, [onSelectRoom]);
  useEffect(() => { onPickNeighbourRef.current = onPickNeighbour; }, [onPickNeighbour]);

  // --- Mount the Pixi renderer once. Mode is captured at mount time and
  //     propagated via setMode() / setLimbo() / setCurrentSector() on prop
  //     changes so we never tear the renderer down mid-session. ---
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    let disposed = false;

    const renderer = new GalaxyOverviewRenderer({
      onPick: (key) => {
        if (mode === 'spawn') {
          onSelectRoomRef.current?.(`galaxy-${key}`);
        } else {
          onPickNeighbourRef.current?.(key);
        }
      },
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
        limbo: effectiveLimboSectorKey ? { sectorKey: effectiveLimboSectorKey } : null,
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

  // Reflect prop / store changes onto the live renderer.
  useEffect(() => {
    rendererRef.current?.setMode(mode);
  }, [mode]);
  useEffect(() => {
    rendererRef.current?.setCurrentSector(currentSectorKey);
  }, [currentSectorKey]);
  useEffect(() => {
    rendererRef.current?.setLimbo(
      effectiveLimboSectorKey ? { sectorKey: effectiveLimboSectorKey } : null,
    );
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
      {/* The slot is ALWAYS rendered (just empty when no limbo) so adding
       *  the pill doesn't shift sibling positions in the column flex.
       *  Without this, React's reconciler reused the Box DOM node for the
       *  new content and the Pixi canvas appended into the old `mountRef`
       *  Box (which was at the same index) got swapped out — visible as
       *  the entire map vanishing the moment the pill rendered. */}
      <Box
        data-testid="limbo-resume-banner"
        data-limbo-sector-key={limboSector?.key ?? ''}
        sx={{
          display: 'flex',
          justifyContent: 'center',
          minHeight: limboSector ? undefined : 0,
          my: limboSector ? 0.75 : 0,
        }}
      >
        {limboSector && (
          <Button
            variant="contained"
            onClick={() => onSelectRoom?.(`galaxy-${limboSector.key}`)}
            sx={{
              bgcolor: '#00ff88',
              color: '#000',
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 1,
              textTransform: 'uppercase',
              px: 2,
              py: 0.5,
              borderRadius: 999,
              whiteSpace: 'nowrap',
              '&:hover': { bgcolor: '#00cc6a' },
            }}
            data-testid="limbo-resume-button"
          >
            Resume in {limboSector.name}
          </Button>
        )}
      </Box>

      {/* Phase 3 responsive split: canvas + roster panel.
       *  - Landscape / desktop (>=600 px): row — canvas grows, panel on the right.
       *  - Portrait phone (<600 px): column — canvas on top, panel below.
       *  The roster panel is hidden for engineering rooms (no playerId =>
       *  the panel renders null anyway). */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          mx: 'auto',
          width: 'min(1280px, 98vw)',
          display: 'flex',
          flexDirection: isCompact ? 'column' : 'row',
          gap: 1,
        }}
      >
        <Box
          ref={mountRef}
          sx={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            touchAction: 'none',
          }}
        />
        <Box
          sx={{
            flexShrink: 0,
            ...(isCompact
              ? { width: '100%', height: 160 }
              : { width: 'min(320px, 30vw)', height: '100%' }),
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

      <Box sx={{ minHeight: 36, px: 3, pb: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="caption" sx={{ color: '#555', textAlign: 'center' }}>
          {limboSector
            ? 'Other sectors are locked while your ship is in flight. Pick a ship from your roster to spawn elsewhere.'
            : 'Pick a sector on the map to spawn a new ship, or pick one from your roster on the right.'}
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
