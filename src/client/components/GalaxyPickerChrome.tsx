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
} from '@mui/material';
import { getSector } from '../../core/galaxy/galaxy';
import { loadStoredPlayerId } from '../identity/token';
import { ShipPickerModal } from './ShipPickerModal';
import { ShipRosterPanel } from './ShipRosterPanel';
import { useUIStore } from '../state/store';
import { useIsCompact } from '../layout/useIsCompact';
import type { ShipKindId } from '../../shared-types/shipKinds';
import { logEvent } from '../debug/ClientLogger';
import { useMountLog } from '../debug/useMountLog';
import type { MutableRefObject } from 'react';

interface EngineeringRoom {
  roomName: string;
  label: string;
  description: string;
}

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
}: GalaxyPickerChromeProps): JSX.Element {
  useMountLog('GalaxyPickerChrome', {});
  const selectedShipKindId = useUIStore((s) => s.selectedShipKind);
  const setSelectedShipKind = useUIStore((s) => s.setSelectedShipKind);
  const isCompact = useIsCompact();
  const storedPlayerId = loadStoredPlayerId() ?? '';

  const [engineeringOpen, setEngineeringOpen] = useState(false);
  const [pendingSpawnSector, setPendingSpawnSector] = useState<string | null>(null);

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
        setPendingSpawnSector(key);
      },
    };
    return () => { if (apiRef) apiRef.current = null; };
  }, [apiRef]);

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

      {/* Roster panel floats over the canvas. pointerEvents:none on the
       *  wrapper keeps drag/tap on the canvas working; the inner panel
       *  sets its own pointerEvents:auto to capture card taps. */}
      <Box
        sx={{
          position: 'absolute',
          zIndex: 2,
          pointerEvents: 'none',
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

      <Box sx={{ flex: 1, minHeight: 0 }} />

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
          pointerEvents: 'auto',
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
