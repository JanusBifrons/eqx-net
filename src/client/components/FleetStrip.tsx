import { useCallback, type ChangeEvent } from 'react';
import { Box, Button, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { FLEET_STATUS_MODES, FLEET_STATUS_STANCES, type FleetMode, type FleetStance } from '@shared-types/messages/fleetStatusMessages';
import { useUIStore } from '../state/store.js';
import { useIsCompact } from '../layout/useIsCompact.js';
import { MODE_LABELS, STANCE_LABELS } from '../fleet/fleetView.js';
import type { FleetCommands } from '../fleet/fleetCommands.js';
import { resolveFleetCommands, useFleetSelectionView } from '../fleet/useFleetSelectionView.js';
import { modeNeedsPick } from '../fleet/fleetPickView.js';
import { FleetPickBar } from './FleetPickBar.js';

/**
 * RTS command layer slice 14 — the COMPACT (phone, `useIsCompact`) fleet
 * strip: one slim row in the bottom-centre slot while own ships are selected
 * in command view. Count, mode + stance as native selects (a "Mixed" entry
 * when the selection differs), Stop, and the Move / Attack order-mode toggle
 * (Zustand `fleetOrderMode`, a discrete UI choice).
 *
 * Placement: the touch sticks (left/right 44 % from 28 % down) are only
 * mounted while FLYING (GameHud `touch && flying`); command view is spectator,
 * so the bottom edge is free while this shows. Width is capped to the viewport.
 */

const STRIP_SX = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  justifyContent: 'center',
  gap: 0.5,
  boxSizing: 'border-box',
  maxWidth: 'calc(100vw - 32px)',
  px: 0.75,
  py: 0.5,
  bgcolor: 'rgba(6,9,18,0.78)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 1.5,
  color: '#dfe8f5',
  fontSize: 10,
} as const;

const COUNT_SX = { fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' } as const;
const SELECT_STYLE = {
  fontSize: 10,
  padding: '2px 2px',
  background: 'rgba(255,255,255,0.06)',
  color: '#dfe8f5',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 4,
} as const;
const BTN_SX = { py: 0.1, px: 0.75, minWidth: 0, fontSize: 10, lineHeight: 1.4, textTransform: 'none' } as const;
const TOGGLE_SX = { py: 0.1, px: 0.75, fontSize: 10, lineHeight: 1.4, textTransform: 'none', color: '#cfe' } as const;

/** The select value when no single value applies. */
const NONE = '';

interface Props {
  commands?: Partial<FleetCommands>;
}

export function FleetStrip({ commands }: Props): JSX.Element | null {
  const view = useFleetSelectionView();
  const compact = useIsCompact();
  const orderMode = useUIStore((s) => s.fleetOrderMode);
  const setOrderMode = useUIStore((s) => s.setFleetOrderMode);
  const { ids } = view;

  const picking = useUIStore((s) => s.fleetPick !== null);
  const setPick = useUIStore((s) => s.setFleetPick);
  // Patrol / escort / retreat need a target on the map first (slice 14b).
  const onMode = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value as FleetMode | '';
    if (v === NONE) return;
    if (modeNeedsPick(v)) setPick(v);
    else resolveFleetCommands(commands).setMode(ids, v);
  }, [commands, ids, setPick]);
  const onStance = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value as FleetStance | '';
    if (v !== NONE) resolveFleetCommands(commands).setStance(ids, v);
  }, [commands, ids]);
  const onStop = useCallback(() => resolveFleetCommands(commands).stop(ids), [commands, ids]);
  const onOrder = useCallback((_e: unknown, v: 'move' | 'attack' | null) => {
    if (v !== null) setOrderMode(v);
  }, [setOrderMode]);

  if (!view.active || !compact) return null;
  const n = ids.length;
  const modeValue = view.mode === null || view.mode === 'mixed' ? NONE : view.mode;
  const stanceValue = view.stance === null || view.stance === 'mixed' ? NONE : view.stance;

  return (
    <Box sx={STRIP_SX} data-testid="fleet-strip" data-fleet-count={n} data-hud-exclusion="">
      <Box component="span" sx={COUNT_SX}>{n === 1 ? '1 ship' : `${n} ships`}</Box>
      {picking ? <FleetPickBar ids={ids} {...(commands !== undefined ? { commands } : {})} /> : (<>
      <select aria-label="Mode" data-testid="fleet-strip-mode" style={SELECT_STYLE} value={modeValue} onChange={onMode}>
        <option value={NONE} disabled>{view.mode === 'mixed' ? 'Mixed' : 'Mode'}</option>
        {FLEET_STATUS_MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
      </select>
      <select aria-label="Stance" data-testid="fleet-strip-stance" style={SELECT_STYLE} value={stanceValue} onChange={onStance}>
        <option value={NONE} disabled>{view.stance === 'mixed' ? 'Mixed' : 'Stance'}</option>
        {FLEET_STATUS_STANCES.map((s) => <option key={s} value={s}>{STANCE_LABELS[s]}</option>)}
      </select>
      <Button size="small" variant="outlined" color="warning" sx={BTN_SX} data-testid="fleet-stop" onClick={onStop}>Stop</Button>
      <ToggleButtonGroup size="small" exclusive value={orderMode} onChange={onOrder} aria-label="Tap order">
        <ToggleButton value="move" sx={TOGGLE_SX} data-testid="fleet-order-move">Move</ToggleButton>
        <ToggleButton value="attack" sx={TOGGLE_SX} data-testid="fleet-order-attack">Attack</ToggleButton>
      </ToggleButtonGroup>
      </>)}
    </Box>
  );
}
