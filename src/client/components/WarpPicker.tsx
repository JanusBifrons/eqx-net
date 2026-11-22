/**
 * In-sector warp helpers (Phase 4 solar-system sectors). The destination list
 * itself lives on the Galaxy right panel (`panels/GalaxyPanel.tsx`, opened by
 * `rightPanel = 'galaxy'`); this file keeps what it reads:
 *  - `destinationsFrom`: the pockets from a pose, each with its warp TARGET
 *    (`requestWarp`): its rim point when the line is clear, else the near
 *    side of the asteroid field or structure in the way (warp route check, S3);
 *  - `usePolledShip`: the ship pose + warp state at 4 Hz while on;
 *  - `WarpStatusChip` (top-centre slot, under the energy bar): where a held
 *    warp goes, with a Cancel.
 *
 * The ship's pose is read from the render mirror a few times a second (the
 * sanctioned low-cadence mirror read, not Zustand: invariant #2). Only
 * discrete flags live in the store.
 */
import { memo, useEffect, useState } from 'react';
import { Box, Button } from '@mui/material';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { warpDestinations, type WarpDestination, type WarpRouteInputs } from './warpDestinations';
import { WarpRouteClient, type WarpRouteMirror } from './warpRoute';
import { warpStopMargin } from '../../core/galaxy/warpTarget';
import { getShipKind } from '../../shared-types/shipKinds';

const CHIP_SX = {
  display: 'flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.25, borderRadius: '4px', fontSize: 11, fontWeight: 700,
  color: '#e8f4ff', backgroundColor: 'rgba(20,60,120,0.9)', border: '1px solid #5aa8ff', pointerEvents: 'auto' as const,
};

export interface ShipPose { x: number; y: number; angle: number; kind?: string }

/** The local ship's pose from the render mirror, or null. */
function shipPose(): ShipPose | null {
  const c = getGameClient();
  const id = c?.mirror.localPlayerId;
  const s = id ? (c?.mirror.ships.get(id) as { x: number; y: number; angle?: number; kind?: string } | undefined) : undefined;
  return s ? { x: s.x, y: s.y, angle: s.angle ?? 0, kind: s.kind } : null;
}

/** The route check (shared: used synchronously per call) and a default reused destination list. */
const route = new WarpRouteClient();
const routeIn: WarpRouteInputs = { field: null, structures: null, margin: 0 };
const destList: WarpDestination[] = [];

/** The destinations from `pose`, each with its warp target (field + structures),
 *  written into `out` (each caller owns its list). */
export function destinationsFrom(sectorKey: string, pose: ShipPose, out: WarpDestination[] = destList): WarpDestination[] {
  const c = getGameClient();
  routeIn.field = route.fieldMap(c?.cutFieldOpts ?? null);
  routeIn.structures = route.gather(c?.mirror as WarpRouteMirror | undefined);
  routeIn.margin = warpStopMargin(getShipKind(pose.kind));
  return warpDestinations(sectorKey, pose.x, pose.y, routeIn, out);
}

/** Poll the ship pose and warp state at 4 Hz while `on` (the chip, the Galaxy panel). */
export function usePolledShip(on: boolean): { pose: ShipPose | null; warping: boolean } {
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
