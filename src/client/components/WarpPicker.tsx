/**
 * Warp destination picker (wrap-up plan W1a, Phase 4 solar-system sectors).
 * Both views stay (user, 2026-11-08): the list on touch devices, the map on
 * desktop; `?warpui=list|map` overrides.
 *  - **list**: EVE-style, destinations by name with distances, near ones
 *    listed one by one and far ones grouped under "Far";
 *  - **map**: a small map of the system (±200 km) with its pockets and the
 *    ship; tap a pocket, then Warp.
 * Picking asks the server to warp to the pocket's rim (`requestWarp`).
 * `WarpStatusChip` (top-centre slot, under the energy bar) shows where a held
 * warp goes, with a Cancel.
 *
 * The ship's pose is read from the render mirror a few times a second while
 * the picker or chip is up (the sanctioned low-cadence mirror read, not
 * Zustand: invariant #2). Only discrete flags live in the store.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import { Box, Button, Paper, Portal, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { formatKm, warpDestinations, type WarpDestination } from './warpDestinations';
import { SOLAR_HALF_EXTENT } from '../../core/galaxy/sectorSites';
import { isTouchDevice } from '../input/TouchInput';

type WarpUi = 'list' | 'map';
/** `?warpui=` wins; else the list on touch (big rows, readable on a phone)
 *  and the map on desktop. */
export function readWarpUi(search: string, touch: boolean): WarpUi {
  if (/[?&]warpui=map\b/.test(search)) return 'map';
  if (/[?&]warpui=list\b/.test(search)) return 'list';
  return touch ? 'list' : 'map';
}

const PANEL_SX = {
  position: 'fixed' as const, right: 'max(12px, env(safe-area-inset-right, 0px))', bottom: 96, zIndex: 1400,
  width: 280, maxHeight: '60dvh', overflowY: 'auto' as const, p: 0.75, bgcolor: 'rgba(12,16,26,0.94)', color: '#e6ecf5',
  border: '1px solid #2c3a52',
};
const MAP_PANEL_SX = { ...PANEL_SX, width: 360 };
const ROW_SX = {
  justifyContent: 'space-between', textTransform: 'none' as const, fontSize: 12, py: 0.25, px: 0.75, width: '100%', color: '#e6ecf5',
  '&:hover': { backgroundColor: 'rgba(90,168,255,0.14)' }, '&.Mui-focusVisible': { backgroundColor: 'transparent' },
};
const HEAD_SX = { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: '#a9b8cc', mt: 0.5, mb: 0.25, display: 'block' };
const CHIP_SX = {
  display: 'flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.25, borderRadius: '4px', fontSize: 11, fontWeight: 700,
  color: '#e8f4ff', backgroundColor: 'rgba(20,60,120,0.9)', border: '1px solid #5aa8ff', pointerEvents: 'auto' as const,
};

interface ShipPose { x: number; y: number; angle: number }

/** The local ship's pose from the render mirror, or null. */
function shipPose(): ShipPose | null {
  const c = getGameClient();
  const id = c?.mirror.localPlayerId;
  const s = id ? (c?.mirror.ships.get(id) as { x: number; y: number; angle?: number } | undefined) : undefined;
  return s ? { x: s.x, y: s.y, angle: s.angle ?? 0 } : null;
}

/** Poll the ship pose and warp state at 4 Hz while `on`. */
function usePolledShip(on: boolean): { pose: ShipPose | null; warping: boolean } {
  const [state, setState] = useState(() => ({ pose: shipPose(), warping: getGameClient()?.hasWarpRequest() ?? false }));
  useEffect(() => {
    if (!on) return undefined;
    const tick = (): void => setState({ pose: shipPose(), warping: getGameClient()?.hasWarpRequest() ?? false });
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [on]);
  return state;
}

export const WarpPicker = memo(function WarpPicker(): JSX.Element | null {
  const open = useUIStore((s) => s.warpPickerOpen);
  const setOpen = useUIStore((s) => s.setWarpPickerOpen);
  const setHeldTo = useUIStore((s) => s.setWarpHeldTo);
  const sectorKey = useUIStore((s) => s.currentSectorKey);
  const ui = useMemo(() => readWarpUi(typeof location !== 'undefined' ? location.search : '', isTouchDevice()), []);
  const [target, setTarget] = useState<string | null>(null);
  const { pose } = usePolledShip(open);

  const dests = useMemo(() => (sectorKey && pose ? warpDestinations(sectorKey, pose.x, pose.y) : []), [sectorKey, pose]);

  if (!open || !sectorKey) return null;

  const warpTo = (d: WarpDestination): void => {
    getGameClient()?.requestWarp(d.dropX, d.dropY);
    setHeldTo(d.label);
    setOpen(false);
    setTarget(null);
  };

  const near = dests.filter((d) => !d.far), far = dests.filter((d) => d.far);
  const row = (d: WarpDestination): JSX.Element => (
    <Button key={d.id} sx={ROW_SX} disabled={d.here} disableRipple onClick={() => warpTo(d)} data-testid={`warp-dest-${d.id}`} data-km={Math.round(d.distKm)}>
      <span>{d.label}{d.padTo && <span style={{ color: '#5ad7ff', fontSize: 11 }} data-testid={`warp-pad-${d.id}`}>{` · pad to ${d.padTo} (instant)`}</span>}</span>
      <span style={{ color: '#8fa0b8' }}>{d.here ? 'here' : formatKm(d.distKm)}</span>
    </Button>
  );

  return (
    <Portal>
      <Paper sx={ui === 'map' ? MAP_PANEL_SX : PANEL_SX} data-testid="warp-picker" data-ui={ui}>
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
          <SystemMap dests={dests} pose={pose} target={target} onPick={setTarget} onWarp={warpTo} />
        )}
      </Paper>
    </Portal>
  );
});

/**
 * Where a held warp goes, with a Cancel (top-centre slot, under the energy
 * bar). Stays until the warp is seen to start and then end (arrival or
 * cancel): the first poll after asking may not show it yet.
 */
export const WarpStatusChip = memo(function WarpStatusChip(): JSX.Element | null {
  const heldTo = useUIStore((s) => s.warpHeldTo);
  const setHeldTo = useUIStore((s) => s.setWarpHeldTo);
  const { warping } = usePolledShip(heldTo !== null);
  const [sawWarp, setSawWarp] = useState(false);
  useEffect(() => {
    if (warping && heldTo !== null && !sawWarp) setSawWarp(true);
    if (!warping && sawWarp) { setSawWarp(false); setHeldTo(null); }
  }, [warping, heldTo, sawWarp, setHeldTo]);
  if (heldTo === null) return null;
  const cancel = (): void => { getGameClient()?.cancelWarp(); setHeldTo(null); setSawWarp(false); };
  return (
    <Box sx={CHIP_SX} data-testid="warp-status">
      <span>{`Warping to ${heldTo}`}</span>
      <Button size="small" variant="outlined" sx={{ fontSize: 10, py: 0, minWidth: 0 }} onClick={cancel} data-testid="warp-cancel">Cancel</Button>
    </Box>
  );
});

const KIND_COLOUR: Record<WarpDestination['kind'], string> = { home: '#5ae08a', gate: '#b78cff', belt: '#c9a86a', base: '#6ab4ff', combat: '#ff6a6a' };

/**
 * The system as a small map: pockets as dots (sized up so they show), labels
 * kept inside the map and nudged apart, the ship as an arrow on its heading.
 */
function SystemMap({ dests, pose, target, onPick, onWarp }: {
  dests: WarpDestination[]; pose: ShipPose | null; target: string | null;
  onPick: (id: string) => void; onWarp: (d: WarpDestination) => void;
}): JSX.Element {
  const H = SOLAR_HALF_EXTENT;
  const sel = dests.find((d) => d.id === target) ?? null;
  const font = H / 7, edge = H * 0.97, dotR = H / 22;
  // Each label sits just under its own dot (above it when there's no room
  // below, or when a label already sits there), anchored inward at the edges.
  const placed: Array<{ x: number; y: number; w: number }> = [];
  const clash = (x: number, y: number, w: number): boolean =>
    placed.some((p) => Math.abs(p.y - y) < font * 1.05 && Math.abs(p.x - x) < (p.w + w) / 2);
  const labels = dests.map((d) => {
    const sx = d.x, sy = -d.y, w = d.label.length * font * 0.55;
    const anchor: 'start' | 'middle' | 'end' = sx > H * 0.55 ? 'end' : sx < -H * 0.55 ? 'start' : 'middle';
    const cx = anchor === 'end' ? sx - w / 2 : anchor === 'start' ? sx + w / 2 : sx;
    let ly = sy + dotR + font;
    if (ly > edge || clash(cx, ly, w)) ly = sy - dotR - font * 0.35;
    placed.push({ x: cx, y: ly, w });
    const lx = anchor === 'end' ? Math.min(sx + dotR, edge) : anchor === 'start' ? Math.max(sx - dotR, -edge) : sx;
    return { d, lx, ly, anchor };
  });
  return (
    <Box>
      <svg viewBox={`${-H} ${-H} ${2 * H} ${2 * H}`} width="100%" style={{ display: 'block', background: '#070b14', borderRadius: 4 }} data-testid="warp-map">
        <circle cx={0} cy={0} r={H * 0.98} fill="none" stroke="#1d2a40" strokeWidth={H / 120} />
        {dests.filter((d) => d.kind === 'home' && d.padTo).map((d) => {
          const o = dests.find((x) => x.label === d.padTo);
          return o ? <line key={`pad-${d.id}`} x1={d.x} y1={-d.y} x2={o.x} y2={-o.y} stroke="#5ad7ff" strokeWidth={H / 150}
            strokeDasharray={`${H / 40} ${H / 60}`} opacity={0.7} data-testid="warp-map-pad" /> : null;
        })}
        {dests.map((d) => (
          <g key={d.id} onClick={() => !d.here && onPick(d.id)} style={{ cursor: d.here ? 'default' : 'pointer' }} data-testid={`warp-map-${d.id}`}>
            <circle cx={d.x} cy={-d.y} r={H / 9} fill="transparent" />
            <circle cx={d.x} cy={-d.y} r={Math.max(d.r, dotR)} fill={KIND_COLOUR[d.kind]} fillOpacity={d.id === target ? 0.95 : 0.5}
              stroke={d.id === target ? '#ffffff' : 'none'} strokeWidth={H / 90} />
          </g>
        ))}
        {labels.map(({ d, lx, ly, anchor }) => (
          <text key={`l-${d.id}`} x={lx} y={ly} fontSize={font} fill={d.id === target ? '#ffffff' : '#c8d4e6'} textAnchor={anchor}
            fontWeight={d.id === target ? 700 : 400} style={{ pointerEvents: 'none' }}>{d.label}</text>
        ))}
        {pose && (
          <g transform={`translate(${pose.x} ${-pose.y}) rotate(${(-pose.angle * 180) / Math.PI})`} data-testid="warp-map-ship">
            <polygon points={`0,${-H / 20} ${H / 32},${H / 26} ${-H / 32},${H / 26}`} fill="#ffffff" stroke="#070b14" strokeWidth={H / 200} />
          </g>
        )}
      </svg>
      <Button fullWidth size="small" variant="contained" disabled={!sel} sx={{ mt: 0.5, fontSize: 12, fontWeight: 700, color: '#04130a', textTransform: 'none' }}
        onClick={() => sel && onWarp(sel)} data-testid="warp-map-go">
        {sel ? `Warp: ${sel.label} (${formatKm(sel.distKm)})` : 'Pick a destination'}
      </Button>
    </Box>
  );
}
