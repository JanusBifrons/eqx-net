import { useCallback } from 'react';
import { Box, Button } from '@mui/material';
import { useUIStore } from '../state/store.js';
import { isTouchDevice } from '../input/TouchInput.js';
import type { FleetCommands } from '../fleet/fleetCommands.js';
import { resolveFleetCommands } from '../fleet/useFleetSelectionView.js';
import { canFinishFleetPick, fleetPickHint } from '../fleet/fleetPickView.js';

/**
 * RTS slice 14b — shown by the fleet panel and strip (and on its own,
 * `FleetPickHost`, in the HUD) while a mode waits for
 * a target on the map (Zustand `fleetPick`): a plain hint plus
 *  - Patrol: Done (needs 2+ points; also Enter / right-click) and Cancel;
 *  - Escort: Cancel (the next tap on another own ship sends it);
 *  - Retreat: "Back to post" (retreat with no point: the ships' own post)
 *    and Cancel (a tap on the map sends it to that point).
 * Escape cancels too (App keydown).
 */

const BAR_SX = { display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' } as const;
const HINT_SX = { fontSize: 10, color: '#9fd8ff' } as const;
const BTN_SX = { py: 0.1, px: 0.75, minWidth: 0, fontSize: 10, lineHeight: 1.4, textTransform: 'none' } as const;

interface Props {
  ids: readonly string[];
  commands?: Partial<FleetCommands>;
}

export function FleetPickBar({ ids, commands }: Props): JSX.Element | null {
  const pick = useUIStore((s) => s.fleetPick);
  const setPick = useUIStore((s) => s.setFleetPick);
  const requestDone = useUIStore((s) => s.requestFleetPickDone);
  const onCancel = useCallback(() => setPick(null), [setPick]);
  const onBackToPost = useCallback(() => {
    resolveFleetCommands(commands).setMode(ids, 'retreat');
    setPick(null);
  }, [commands, ids, setPick]);

  if (pick === null) return null;
  return (
    <Box sx={BAR_SX} data-testid="fleet-pick" data-fleet-pick={pick.kind} data-fleet-pick-points={pick.points}>
      <Box component="span" sx={HINT_SX} data-testid="fleet-pick-hint">
        {fleetPickHint(pick.kind, pick.points, isTouchDevice())}
      </Box>
      {pick.kind === 'patrol' && (
        <Button size="small" variant="contained" sx={BTN_SX} data-testid="fleet-pick-done" disabled={!canFinishFleetPick(pick)} onClick={requestDone}>
          Done
        </Button>
      )}
      {pick.kind === 'retreat' && (
        <Button size="small" variant="outlined" sx={BTN_SX} data-testid="fleet-pick-post" onClick={onBackToPost}>
          Back to post
        </Button>
      )}
      <Button size="small" variant="outlined" color="inherit" sx={BTN_SX} data-testid="fleet-pick-cancel" onClick={onCancel}>
        Cancel
      </Button>
    </Box>
  );
}

const HOST_SX = {
  boxSizing: 'border-box',
  maxWidth: 'calc(100vw - 32px)',
  px: 1,
  py: 0.5,
  bgcolor: 'rgba(6,9,18,0.78)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 1.5,
  color: '#dfe8f5',
} as const;

/**
 * The pick bar on its own in the HUD's bottom-centre slot (UI plan U3-3 until
 * the route strip lands): fleet orders moved to the left strip, whose Patrol /
 * Escort / Retreat fly-out picks start a map pick that still needs Done /
 * Back to post / Cancel. Renders only while a pick is under way, for the
 * current selection.
 */
export function FleetPickHost(): JSX.Element | null {
  const picking = useUIStore((s) => s.fleetPick !== null);
  const ids = useUIStore((s) => s.selection.ids);
  if (!picking) return null;
  return (
    <Box sx={HOST_SX} data-hud-exclusion="">
      <FleetPickBar ids={ids} />
    </Box>
  );
}
