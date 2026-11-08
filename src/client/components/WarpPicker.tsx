/**
 * Warp destination picker (wrap-up plan W1a, Phase 4 solar-system sectors).
 * Two prototypes behind `?warpui=list|map` (default list); the user picks one
 * and the other goes:
 *  - **list**: EVE-style, destinations by name with distances, near ones
 *    listed one by one and far ones grouped under "Far";
 *  - **map**: a small map of the system (±200 km) with its pockets and the
 *    ship; tap a pocket, then Warp.
 * Picking asks the server to warp to the pocket's rim (`requestWarp`). While a
 * warp is held, a small chip shows where to with a Cancel.
 *
 * The ship's position is read from the render mirror a few times a second
 * while the picker or chip is up (the sanctioned low-cadence mirror read, not
 * Zustand: invariant #2). Only the open flag lives in the store.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import { Box, Button, Paper, Portal, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { formatKm, warpDestinations, type WarpDestination } from './warpDestinations';
import { SOLAR_HALF_EXTENT } from '../../core/galaxy/sectorSites';

type WarpUi = 'list' | 'map';
export function readWarpUi(search: string): WarpUi {
  return /[?&]warpui=map\b/.test(search) ? 'map' : 'list';
}

const PANEL_SX = {
  position: 'fixed' as const, right: 'max(12px, env(safe-area-inset-right, 0px))', bottom: 96, zIndex: 1400,
  width: 260, maxHeight: '60dvh', overflowY: 'auto' as const, p: 0.75, bgcolor: 'rgba(12,16,26,0.94)', color: '#e6ecf5',
  border: '1px solid #2c3a52',
};
const ROW_SX = { justifyContent: 'space-between', textTransform: 'none' as const, fontSize: 11, py: 0.25, px: 0.75, width: '100%' };
const HEAD_SX = { fontSize: 9, letterSpacing: '0.08em', color: '#8fa0b8', mt: 0.5, mb: 0.25, display: 'block' };
const CHIP_SX = {
  display: 'flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.25, borderRadius: '4px', fontSize: 11, fontWeight: 700,
  color: '#e8f4ff', backgroundColor: 'rgba(20,60,120,0.9)', border: '1px solid #5aa8ff',
};

/** The local ship's position from the render mirror, or null. */
function shipPos(): { x: number; y: number } | null {
  const c = getGameClient();
  const id = c?.mirror.localPlayerId;
  const s = id ? c?.mirror.ships.get(id) : undefined;
  return s ? { x: s.x, y: s.y } : null;
}

/** Poll the ship position (and warp state) at 4 Hz while `on`. */
function usePolledShip(on: boolean): { pos: { x: number; y: number } | null; warping: boolean } {
  const [state, setState] = useState(() => ({ pos: shipPos(), warping: getGameClient()?.hasWarpRequest() ?? false }));
  useEffect(() => {
    if (!on) return undefined;
    const tick = (): void => setState({ pos: shipPos(), warping: getGameClient()?.hasWarpRequest() ?? false });
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [on]);
  return state;
}

export const WarpPicker = memo(function WarpPicker(): JSX.Element | null {
  const open = useUIStore((s) => s.warpPickerOpen);
  const setOpen = useUIStore((s) => s.setWarpPickerOpen);
  const sectorKey = useUIStore((s) => s.currentSectorKey);
  const ui = useMemo(() => readWarpUi(typeof location !== 'undefined' ? location.search : ''), []);
  const [target, setTarget] = useState<string | null>(null);
  const [heldTo, setHeldTo] = useState<string | null>(null);
  const { pos, warping } = usePolledShip(open || heldTo !== null);
  // The chip stays until the warp is seen to start and then end (arrival or
  // cancel): the first poll after asking may not show it yet.
  const [sawWarp, setSawWarp] = useState(false);
  useEffect(() => {
    if (warping && heldTo !== null && !sawWarp) setSawWarp(true);
    if (!warping && sawWarp) { setSawWarp(false); setHeldTo(null); }
  }, [warping, heldTo, sawWarp]);

  const dests = useMemo(() => (sectorKey && pos ? warpDestinations(sectorKey, pos.x, pos.y) : []), [sectorKey, pos]);

  const warpTo = (d: WarpDestination): void => {
    getGameClient()?.requestWarp(d.dropX, d.dropY);
    setHeldTo(d.label);
    setOpen(false);
    setTarget(null);
  };
  const cancel = (): void => { getGameClient()?.cancelWarp(); setHeldTo(null); };

  const chip = heldTo !== null ? (
    <Portal>
      <Box sx={{ position: 'fixed', top: 72, left: '50%', transform: 'translateX(-50%)', zIndex: 1400 }}>
        <Box sx={CHIP_SX} data-testid="warp-status">
          <span>{`Warping to ${heldTo}`}</span>
          <Button size="small" variant="outlined" sx={{ fontSize: 10, py: 0, minWidth: 0 }} onClick={cancel} data-testid="warp-cancel">Cancel</Button>
        </Box>
      </Box>
    </Portal>
  ) : null;

  if (!open || !sectorKey) return chip;

  const near = dests.filter((d) => !d.far), far = dests.filter((d) => d.far);
  const row = (d: WarpDestination): JSX.Element => (
    <Button key={d.id} sx={ROW_SX} disabled={d.here} onClick={() => warpTo(d)} data-testid={`warp-dest-${d.id}`} data-km={Math.round(d.distKm)}>
      <span>{d.label}</span>
      <span style={{ color: '#8fa0b8' }}>{d.here ? 'here' : formatKm(d.distKm)}</span>
    </Button>
  );

  return (
    <>
      {chip}
      <Portal>
        <Paper sx={PANEL_SX} data-testid="warp-picker" data-ui={ui}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography sx={{ fontSize: 12, fontWeight: 700 }}>Warp to</Typography>
            <Button size="small" sx={{ fontSize: 10, minWidth: 0 }} onClick={() => setOpen(false)} data-testid="warp-picker-close">Close</Button>
          </Box>
          {ui === 'list' ? (
            <>
              {near.length > 0 && <Typography sx={HEAD_SX}>NEARBY</Typography>}
              {near.map(row)}
              {far.length > 0 && <Typography sx={HEAD_SX}>FAR</Typography>}
              {far.map(row)}
            </>
          ) : (
            <SystemMap dests={dests} pos={pos} target={target} onPick={setTarget} onWarp={warpTo} />
          )}
        </Paper>
      </Portal>
    </>
  );
});

const KIND_COLOUR: Record<WarpDestination['kind'], string> = { home: '#5ae08a', gate: '#b78cff', belt: '#c9a86a', base: '#6ab4ff', combat: '#ff6a6a' };

/** The system as a small map: pockets as circles (sized up so they show), the ship as a dot. */
function SystemMap({ dests, pos, target, onPick, onWarp }: {
  dests: WarpDestination[]; pos: { x: number; y: number } | null; target: string | null;
  onPick: (id: string) => void; onWarp: (d: WarpDestination) => void;
}): JSX.Element {
  const H = SOLAR_HALF_EXTENT;
  const sel = dests.find((d) => d.id === target) ?? null;
  return (
    <Box>
      <svg viewBox={`${-H} ${-H} ${2 * H} ${2 * H}`} width="100%" style={{ display: 'block', background: '#070b14', borderRadius: 4 }} data-testid="warp-map">
        <circle cx={0} cy={0} r={H * 0.98} fill="none" stroke="#1d2a40" strokeWidth={H / 120} />
        {dests.map((d) => (
          <g key={d.id} onClick={() => !d.here && onPick(d.id)} style={{ cursor: d.here ? 'default' : 'pointer' }} data-testid={`warp-map-${d.id}`}>
            <circle cx={d.x} cy={-d.y} r={Math.max(d.r, H / 22)} fill={KIND_COLOUR[d.kind]} fillOpacity={d.id === target ? 0.9 : 0.45}
              stroke={d.id === target ? '#ffffff' : 'none'} strokeWidth={H / 90} />
            <text x={d.x} y={-d.y + H / 9} fontSize={H / 13} fill="#c8d4e6" textAnchor="middle">{d.label}</text>
          </g>
        ))}
        {pos && <circle cx={pos.x} cy={-pos.y} r={H / 40} fill="#ffffff" data-testid="warp-map-ship" />}
      </svg>
      <Button fullWidth size="small" variant="contained" disabled={!sel} sx={{ mt: 0.5, fontSize: 11 }}
        onClick={() => sel && onWarp(sel)} data-testid="warp-map-go">
        {sel ? `Warp to ${sel.label} (${formatKm(sel.distKm)})` : 'Pick a destination'}
      </Button>
    </Box>
  );
}
