import { memo, useCallback } from 'react';
import { Box, Button, ToggleButton } from '@mui/material';
import { WINGMAN_MODES, WINGMAN_STANCES, type WingmanMode, type WingmanStance } from '@core/ai/wingman/types';
import { MODE_LABELS, STANCE_LABELS } from '../fleet/fleetView.js';
import type { FleetCommands } from '../fleet/fleetCommands.js';
import { useIsCompact } from '../layout/useIsCompact.js';
import { useUIStore } from '../state/store.js';
import { modeNeedsPick } from '../fleet/fleetPickView.js';
import { FleetPickBar } from './FleetPickBar.js';
import { resolveFleetCommands, useFleetSelectionView, type FleetShipView } from '../fleet/useFleetSelectionView.js';

/**
 * RTS command layer slice 14 — the DESKTOP fleet panel. While own ships are
 * selected in command view it takes the bottom-centre slot from the build bar
 * (`BottomControlPanel` stays MOUNTED and hides itself, see its comment on the
 * death-flip hitch). Mode / stance groups show the selection's shared value
 * (none pressed + "mixed" when they differ), action buttons, and a compact
 * per-ship list. Commands go through `fleet/fleetCommands.ts` (no-op until the
 * network slice plugs in), overridable per instance via `commands`.
 * Names only, never ids, in visible text.
 */

/** Ship rows shown before the "+N more" line. */
export const FLEET_PANEL_MAX_ROWS = 8;

const PANEL_SX = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0.5,
  boxSizing: 'border-box',
  width: 'max-content',
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: '40vh',
  overflowY: 'auto',
  px: 1,
  py: 0.75,
  bgcolor: 'rgba(6,9,18,0.78)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 1.5,
  backdropFilter: 'blur(3px)',
  color: '#dfe8f5',
  fontSize: 11,
} as const;

const HEADER_SX = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4 } as const;
const ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' } as const;
const LABEL_SX = { fontSize: 9, color: 'rgba(223,232,245,0.55)', width: 44, textTransform: 'uppercase', letterSpacing: 0.4 } as const;
const MIXED_SX = { fontSize: 9, color: '#ffb74d', fontStyle: 'italic' } as const;
const TOGGLE_SX = { py: 0.1, px: 0.75, fontSize: 10, lineHeight: 1.4, textTransform: 'none', color: '#cfe' } as const;
const BTN_SX = { py: 0.1, px: 0.75, minWidth: 0, fontSize: 10, lineHeight: 1.4, textTransform: 'none' } as const;
const LIST_SX = { display: 'flex', flexDirection: 'column', gap: '1px', mt: 0.25 } as const;
const SHIP_SX = { display: 'flex', gap: 1, fontSize: 10, lineHeight: 1.35 } as const;
const SHIP_NAME_SX = { minWidth: 70, fontWeight: 600 } as const;
const SHIP_HULL_SX = { minWidth: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'rgba(223,232,245,0.75)' } as const;
const SHIP_ACT_SX = { color: 'rgba(223,232,245,0.75)' } as const;
const MORE_SX = { fontSize: 9, color: 'rgba(223,232,245,0.55)' } as const;

interface Props {
  /** Override some commands (tests, hosts); the rest come from `fleetCommands()`. */
  commands?: Partial<FleetCommands>;
}

export function FleetPanel({ commands }: Props): JSX.Element | null {
  const view = useFleetSelectionView();
  const compact = useIsCompact();
  const { ids } = view;

  const picking = useUIStore((s) => s.fleetPick !== null);
  const setPick = useUIStore((s) => s.setFleetPick);
  // Patrol / escort / retreat need a target on the map first (slice 14b).
  const onMode = useCallback((m: WingmanMode) => {
    if (modeNeedsPick(m)) setPick(m);
    else resolveFleetCommands(commands).setMode(ids, m);
  }, [commands, ids, setPick]);
  const onStance = useCallback((s: WingmanStance) => resolveFleetCommands(commands).setStance(ids, s), [commands, ids]);
  const onStop = useCallback(() => resolveFleetCommands(commands).stop(ids), [commands, ids]);
  const onForm = useCallback(() => resolveFleetCommands(commands).formSquad(ids), [commands, ids]);
  const squad = view.squadId;
  const onDisband = useCallback(() => {
    if (squad !== null && squad !== 'mixed') resolveFleetCommands(commands).disbandSquad(squad);
  }, [commands, squad]);
  const onTake = useCallback(() => {
    if (ids.length === 1) resolveFleetCommands(commands).takeControls(ids[0]!);
  }, [commands, ids]);

  if (!view.active || compact) return null;
  const n = ids.length;
  const shown = view.ships.slice(0, FLEET_PANEL_MAX_ROWS);
  const more = n - shown.length;

  return (
    <Box sx={PANEL_SX} data-testid="fleet-panel" data-fleet-count={n} data-hud-exclusion="">
      <Box sx={HEADER_SX}>{n === 1 ? '1 ship selected' : `${n} ships selected`}</Box>

      {picking ? <FleetPickBar ids={ids} {...(commands !== undefined ? { commands } : {})} /> : (<>
      <Box sx={ROW_SX}>
        <Box component="span" sx={LABEL_SX}>Mode</Box>
        {WINGMAN_MODES.map((m) => (
          <ChoiceButton key={m} value={m} label={MODE_LABELS[m]} testId={`fleet-mode-${m}`} selected={view.mode === m} onPick={onMode} />
        ))}
        {view.mode === 'mixed' && <Box component="span" sx={MIXED_SX} data-testid="fleet-mode-mixed">mixed</Box>}
      </Box>

      <Box sx={ROW_SX}>
        <Box component="span" sx={LABEL_SX}>Stance</Box>
        {WINGMAN_STANCES.map((s) => (
          <ChoiceButton key={s} value={s} label={STANCE_LABELS[s]} testId={`fleet-stance-${s}`} selected={view.stance === s} onPick={onStance} />
        ))}
        {view.stance === 'mixed' && <Box component="span" sx={MIXED_SX} data-testid="fleet-stance-mixed">mixed</Box>}
      </Box>

      <Box sx={ROW_SX}>
        <Button size="small" variant="outlined" color="warning" sx={BTN_SX} data-testid="fleet-stop" onClick={onStop}>Stop</Button>
        <Button size="small" variant="outlined" sx={BTN_SX} data-testid="fleet-form-squad" disabled={n < 2} onClick={onForm}>Form squad</Button>
        {squad !== null && (
          <Button size="small" variant="outlined" sx={BTN_SX} data-testid="fleet-disband-squad" disabled={squad === 'mixed'} onClick={onDisband}>
            Disband squad
          </Button>
        )}
        <Button size="small" variant="outlined" color="success" sx={BTN_SX} data-testid="fleet-take-controls" disabled={n !== 1} onClick={onTake}>
          Take controls
        </Button>
      </Box>
      </>)}

      <Box sx={LIST_SX} data-testid="fleet-ship-list">
        {shown.map((s) => <ShipRow key={s.id} ship={s} />)}
        {more > 0 && <Box sx={MORE_SX} data-testid="fleet-more">+{more} more</Box>}
      </Box>
    </Box>
  );
}

interface ChoiceProps<T extends string> {
  value: T;
  label: string;
  testId: string;
  selected: boolean;
  onPick: (v: T) => void;
}

function ChoiceButtonInner<T extends string>({ value, label, testId, selected, onPick }: ChoiceProps<T>): JSX.Element {
  const onClick = useCallback(() => onPick(value), [onPick, value]);
  return (
    <ToggleButton value={value} size="small" selected={selected} sx={TOGGLE_SX} data-testid={testId} onClick={onClick}>
      {label}
    </ToggleButton>
  );
}
const ChoiceButton = memo(ChoiceButtonInner) as typeof ChoiceButtonInner;

const ShipRow = memo(function ShipRow({ ship }: { ship: FleetShipView }): JSX.Element {
  return (
    <Box sx={SHIP_SX} data-testid="fleet-ship-row" data-ship-id={ship.id}>
      <Box component="span" sx={SHIP_NAME_SX}>{ship.name}</Box>
      <Box component="span" sx={SHIP_HULL_SX}>{ship.hullPct === null ? '--' : `${ship.hullPct}%`}</Box>
      <Box component="span" sx={SHIP_ACT_SX}>{ship.activity}</Box>
    </Box>
  );
});
