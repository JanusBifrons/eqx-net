import { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Button, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Stack, Alert, Tooltip } from '@mui/material';
// Alert is retained for the Engineering Rooms warning dialog below; the Limbo
// banner moved to a richer Box-based card.
import { HexGalaxyMap } from './HexGalaxyMap';
import { GALAXY_SECTORS, getSector } from '../../core/galaxy/galaxy';
import { loadStoredPlayerId } from '../identity/token';
import { ShipPickerModal } from './ShipPickerModal';
import { ShipSilhouette } from '../render/shipShapeSvg';
import { useUIStore } from '../state/store';
import { getShipKind } from '../../shared-types/shipKinds';

interface GalaxyMapScreenProps {
  /** Optional pre-resolved active Limbo entry. When omitted, the screen
   *  fetches `/dev/limbo?playerId=...` itself. */
  activeLimboSectorKey?: string | null;
  /** Called with the selected room name (e.g. 'galaxy-sol-prime' or 'test-sector'). */
  onSelectRoom: (roomName: string) => void;
  /** Called when the user picks the local-only single-player diagnostic. */
  onSelectLocal: () => void;
}

/** Subset of the /dev/limbo response that drives the saved-ship card. */
interface LimboSummary {
  sectorKey: string;
  expiresAt: number;
  createdAt: number;
  x: number;
  y: number;
  health: number;
}

/** Format an absolute ms timestamp as "5m 12s ago" / "just now". */
function formatRelative(then: number, now: number): string {
  const dt = Math.max(0, now - then);
  if (dt < 5_000) return 'just now';
  const totalSec = Math.floor(dt / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m ago` : `${min}m ${sec}s ago`;
}

/** Format the remaining time before a Limbo entry expires. */
function formatRemaining(expiresAt: number, now: number): string {
  const dt = Math.max(0, expiresAt - now);
  if (dt < 1000) return 'expires now';
  const totalSec = Math.floor(dt / 1000);
  if (totalSec < 60) return `${totalSec}s left`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m left` : `${min}m ${sec}s left`;
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

export function GalaxyMapScreen({
  activeLimboSectorKey,
  onSelectRoom,
  onSelectLocal,
}: GalaxyMapScreenProps): JSX.Element {
  const [engineeringOpen, setEngineeringOpen] = useState(false);
  const [shipPickerOpen, setShipPickerOpen] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const selectedShipKindId = useUIStore((s) => s.selectedShipKind);
  const setSelectedShipKind = useUIStore((s) => s.setSelectedShipKind);
  const shipCount = useUIStore((s) => s.shipCount);
  // The picker trigger is disabled while the local player has a ship in the
  // world. `shipCount` is updated from the Colyseus mirror after the welcome
  // message resolves the local id (see `setShipCount` in ColyseusClient).
  const pickerLocked = shipCount > 0;
  const selectedShipKind = getShipKind(selectedShipKindId);

  // Phase 8 sub-phase B — fetch the full Limbo summary so we can render the
  // "your ship is held here" card alongside the disabled-elsewhere map. The
  // landing screen is the **single global gate** for entry: when an active
  // Limbo entry exists, the player MUST resume into that ship (no fresh
  // spawns elsewhere) until the entry expires or is consumed. We treat a
  // 404 / fetch failure as "no Limbo entry" — UX is identical to no-Limbo.
  const [limboSummary, setLimboSummary] = useState<LimboSummary | null>(null);
  useEffect(() => {
    if (activeLimboSectorKey !== undefined) return; // parent overrode; skip fetch
    let cancelled = false;
    const playerId = loadStoredPlayerId();
    if (!playerId) return;
    (async () => {
      try {
        const res = await fetch(`/dev/limbo?playerId=${encodeURIComponent(playerId)}`);
        if (!res.ok) return;
        const body = await res.json() as Partial<LimboSummary> & { exists: boolean };
        if (
          !cancelled
          && body.exists
          && typeof body.sectorKey === 'string'
          && typeof body.expiresAt === 'number'
          && typeof body.createdAt === 'number'
          && typeof body.x === 'number'
          && typeof body.y === 'number'
          && typeof body.health === 'number'
        ) {
          setLimboSummary({
            sectorKey: body.sectorKey,
            expiresAt: body.expiresAt,
            createdAt: body.createdAt,
            x: body.x,
            y: body.y,
            health: body.health,
          });
        }
      } catch {
        // Treat as no Limbo — silent fall-through.
      }
    })();
    return () => { cancelled = true; };
  }, [activeLimboSectorKey]);

  // Live tick so the "saved Xs ago" + "Ys left" labels stay current without
  // re-fetching. 1 Hz is plenty for the second-resolution display.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!limboSummary) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [limboSummary]);

  const effectiveLimboSectorKey = activeLimboSectorKey ?? limboSummary?.sectorKey ?? null;

  // If the player has an active Limbo entry, ONLY their held sector is
  // selectable — every other tile is dimmed and non-clickable. This is the
  // global galaxy-page gate the player asked for: you can't fresh-spawn
  // elsewhere until the held ship is consumed (resume) or expires.
  const selectableKeys: readonly string[] = useMemo(() => {
    if (effectiveLimboSectorKey) return [effectiveLimboSectorKey];
    return GALAXY_SECTORS.map((s) => s.key);
  }, [effectiveLimboSectorKey]);

  const handleSelect = useCallback(
    (key: string) => {
      onSelectRoom(`galaxy-${key}`);
    },
    [onSelectRoom],
  );

  const limboSector = effectiveLimboSectorKey ? getSector(effectiveLimboSectorKey) : null;
  const hovered = hoveredKey ? getSector(hoveredKey) : null;

  return (
    <Box
      data-testid="galaxy-map-screen"
      sx={{
        position: 'fixed',
        inset: 0,
        pt: '48px', // AppHeader spacer
        bgcolor: '#05070f',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 2, pb: 1, gap: 0.5 }}>
        <Typography variant="h3" sx={{ color: '#00ff88', fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase' }}>
          EQX Peri
        </Typography>
        <Typography variant="caption" sx={{ color: '#888', letterSpacing: 2, textTransform: 'uppercase' }}>
          Galaxy Map · Select a sector to enter
        </Typography>
      </Box>

      {limboSector && (
        <Box
          data-testid="limbo-resume-banner"
          data-limbo-sector-key={limboSector.key}
          sx={{
            mx: 'auto',
            mt: 1,
            mb: 1,
            px: 3,
            py: 1.5,
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'stretch', sm: 'center' },
            gap: 2,
            bgcolor: 'rgba(0,255,136,0.06)',
            border: '1px solid #1f7a4d',
            borderRadius: 2,
            maxWidth: 720,
            width: 'min(95vw, 720px)',
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="overline" sx={{ color: '#00ff88', letterSpacing: 2, lineHeight: 1.1 }}>
              Ship in flight · {limboSector.name}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#9aa0b4', mt: 0.5 }}>
              Resume to continue. You can&rsquo;t drop into another sector until this ship is consumed or its window expires.
            </Typography>
            {limboSummary && (
              <Box
                sx={{
                  mt: 1,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                  gap: 0.5,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: '#ccc',
                }}
                data-testid="limbo-stats"
              >
                <Box>
                  <Typography variant="caption" sx={{ color: '#666', display: 'block' }}>SECTOR</Typography>
                  <span data-testid="limbo-stat-sector">{limboSector.name}</span>
                </Box>
                <Box>
                  <Typography variant="caption" sx={{ color: '#666', display: 'block' }}>POSITION</Typography>
                  <span data-testid="limbo-stat-position">
                    ({limboSummary.x.toFixed(0)}, {limboSummary.y.toFixed(0)})
                  </span>
                </Box>
                <Box>
                  <Typography variant="caption" sx={{ color: '#666', display: 'block' }}>HULL</Typography>
                  <span data-testid="limbo-stat-health">{limboSummary.health.toFixed(0)}</span>
                </Box>
                <Box>
                  <Typography variant="caption" sx={{ color: '#666', display: 'block' }}>SAVED</Typography>
                  <span data-testid="limbo-stat-saved">{formatRelative(limboSummary.createdAt, now)}</span>
                </Box>
                <Box>
                  <Typography variant="caption" sx={{ color: '#666', display: 'block' }}>WINDOW</Typography>
                  <span data-testid="limbo-stat-remaining">{formatRemaining(limboSummary.expiresAt, now)}</span>
                </Box>
              </Box>
            )}
          </Box>
          <Button
            variant="contained"
            onClick={() => onSelectRoom(`galaxy-${limboSector.key}`)}
            sx={{
              bgcolor: '#00ff88',
              color: '#000',
              fontWeight: 700,
              alignSelf: { xs: 'stretch', sm: 'center' },
              whiteSpace: 'nowrap',
              '&:hover': { bgcolor: '#00cc6a' },
            }}
            data-testid="limbo-resume-button"
          >
            Resume ship
          </Button>
        </Box>
      )}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 2,
        }}
        onMouseMove={(e) => {
          // Hover detection delegated to the SVG layer's data-sector-key attrs.
          const t = e.target as Element | null;
          if (!t) return;
          const node = (t.closest?.('[data-sector-key]') ?? null) as HTMLElement | null;
          setHoveredKey(node?.dataset['sectorKey'] ?? null);
        }}
        onMouseLeave={() => setHoveredKey(null)}
      >
        <Box sx={{ width: 'min(900px, 95vw)', height: 'min(700px, 70vh)' }}>
          <HexGalaxyMap
            selectableKeys={selectableKeys}
            highlightKey={activeLimboSectorKey ?? null}
            onSelect={handleSelect}
          />
        </Box>
      </Box>

      <Box
        sx={{
          minHeight: 60,
          px: 3,
          pb: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {hovered ? (
          <Typography variant="body2" sx={{ color: '#9aa0b4', maxWidth: 600, textAlign: 'center' }}>
            <strong style={{ color: '#00ff88' }}>{hovered.name}</strong> — {hovered.description}
          </Typography>
        ) : (
          <Typography variant="caption" sx={{ color: '#555' }}>
            Hover a sector for details.{' '}
            {limboSector
              ? 'Other sectors are locked while your ship is in flight.'
              : 'Click any sector to drop in.'}
          </Typography>
        )}
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
        <Tooltip
          title={pickerLocked ? 'Currently flying — return to galaxy to switch ships' : ''}
          disableHoverListener={!pickerLocked}
        >
          {/* Span wrapper lets the Tooltip work on a disabled Button. */}
          <span>
            <Button
              variant="outlined"
              size="small"
              onClick={() => setShipPickerOpen(true)}
              disabled={pickerLocked}
              data-testid="ship-picker-trigger"
              aria-disabled={pickerLocked}
              sx={{
                color: '#cde',
                borderColor: '#2a2f40',
                pl: 1,
                pr: 1.25,
                gap: 1,
                textTransform: 'none',
                '&:hover': { borderColor: '#1f7a4d', bgcolor: 'rgba(0,255,136,0.04)' },
                '&.Mui-disabled': { color: '#556', borderColor: '#1a1d2a', opacity: 0.6 },
              }}
            >
              <ShipSilhouette shape={selectedShipKind.shape} size={28} />
              <Typography variant="caption" sx={{ color: 'inherit' }}>
                Ship: {selectedShipKind.displayName}
              </Typography>
            </Button>
          </span>
        </Tooltip>
        <Button
          variant="text"
          size="small"
          onClick={onSelectLocal}
          sx={{ color: '#ff8800', '&:hover': { bgcolor: 'rgba(255,136,0,0.08)' } }}
          data-testid="single-player-button"
        >
          Single-Player Diagnostic
        </Button>
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

      <ShipPickerModal
        open={shipPickerOpen}
        onClose={() => setShipPickerOpen(false)}
        selectedKind={selectedShipKindId}
        onSelect={setSelectedShipKind}
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
                onClick={() => onSelectRoom(r.roomName)}
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
