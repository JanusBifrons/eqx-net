/**
 * The building settings window's Power tab extras: the grid bar and the
 * "held" explainer for every kind (structureSettingsPowerBar.tsx), then the
 * owner's controls, all sent on `set_structure_power`: an On/Off switch, and
 * Throttle presets (0 / 20 / 50 / 80 / 100%) over a fine slider (0..100% in
 * 10% steps; the wire carries tenths, so a quarter step is not sendable),
 * with this building's working draw at the chosen throttle. Shown only for a
 * kind the server lets its owner switch (`hasPowerSwitch`); the throttle
 * only where it changes something (`hasPowerThrottle`: a turret has On/Off
 * only). The current values come from the structure slice (`switchedOff`,
 * `throttle` decoded from the flags), read by the Power tab's 4 Hz poll, so
 * the window follows the server.
 */
import { useEffect, useState } from 'react';
import { Box, Slider, Switch } from '@mui/material';
import { HUD } from '../hud/tokens';
import { WINDOW_BTN_SECONDARY_SX } from './GameWindow';
import { hasPowerSwitch, hasPowerThrottle, signed, type PowerSummary } from './structureSettingsPower';
import { GridBar, HeldNote } from './structureSettingsPowerBar';
import { sendSetStructurePower } from '../structures/structureActionsClient';
import { getStructureKind } from '@shared-types/structureKinds';
import { STRUCTURE_THROTTLE_FULL, structureDraw } from '@shared-types/structurePower';

/** Throttle presets in tenths (the wire's unit). */
export const THROTTLE_PRESETS: readonly number[] = [0, 2, 5, 8, 10];

/** This building's draw while working at `tenths` (full draw scaled). */
export function workingDrawAt(kindId: string, tenths: number): number {
  return Math.round(structureDraw(getStructureKind(kindId).powerConsumption, true, false, tenths));
}

export interface PowerControlsProps {
  entityId: number;
  kindId: string;
  p: PowerSummary;
  /** Shared label cell style from the Power tab grid. */
  labelSx: object;
}

export function PowerControls({ entityId, kindId, p, labelSx }: PowerControlsProps): JSX.Element {
  const { on, throttle } = p;
  // The throttle shows the picked value until the server's state catches up.
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => setDrag(null), [throttle]);
  const switchable = kindId !== '' && hasPowerSwitch(kindId);
  const throttleable = switchable && hasPowerThrottle(kindId);
  const shown = drag ?? throttle;
  const pick = (t: number): void => {
    setDrag(t);
    if (t !== throttle) sendSetStructurePower(entityId, on, t);
  };
  return (
    <>
      <GridBar p={p} />
      <HeldNote p={p} throttleable={throttleable} />
      {switchable && (
        <>
          <Box sx={labelSx}>Switch</Box>
          <Box sx={SWITCH_SX} data-testid="settings-power-switch" data-on={on ? '1' : '0'}>
            <Box component="span" sx={{ color: on ? C.auto : C.inkDim }}>{on ? 'On' : 'Off'}</Box>
            <Switch size="small" checked={on} sx={TOGGLE_SX}
              onChange={(_e, checked) => { if (checked !== on) sendSetStructurePower(entityId, checked); }}
              slotProps={{ input: { 'aria-label': 'Power on', 'data-testid': 'settings-power-toggle' } as object }} />
          </Box>
        </>
      )}
      {throttleable && (
        <>
          <Box sx={labelSx}>Throttle</Box>
          <Box sx={VALUE_ROW_SX}>
            <Box sx={PCT_SX} data-testid="settings-power-throttle-value">{shown * 10}%</Box>
            <Box sx={DRAW_SX} data-testid="settings-power-throttle-draw">draws {signed(-workingDrawAt(kindId, shown))} working</Box>
          </Box>
          <Box sx={PRESETS_SX} role="group" aria-label="Throttle presets" data-testid="settings-power-presets">
            {THROTTLE_PRESETS.map((t) => (
              <Box key={t} component="button" sx={t === shown ? PICKED_SX : CHOICE_SX} aria-pressed={t === shown}
                data-testid={`power-preset-${t * 10}`} onClick={() => pick(t)}>{t * 10}</Box>
            ))}
          </Box>
          <Box sx={THROTTLE_SX} data-testid="settings-power-throttle" data-throttle={throttle}>
            <Slider
              size="small" min={0} max={STRUCTURE_THROTTLE_FULL} step={1} marks
              value={shown} sx={SLIDER_SX}
              slotProps={{ input: { 'aria-label': 'Throttle', 'data-testid': 'settings-power-throttle-input' } as object }}
              onChange={(_e, v) => setDrag(v as number)}
              onChangeCommitted={(_e, v) => { if (v !== throttle) sendSetStructurePower(entityId, on, v as number); }}
            />
          </Box>
        </>
      )}
    </>
  );
}

const C = HUD.color;
const SWITCH_SX = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5, fontSize: 12, fontWeight: 600 } as const;
const TOGGLE_SX = {
  '& .MuiSwitch-switchBase.Mui-checked': { color: C.auto },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { backgroundColor: C.auto },
  '& .MuiSwitch-track': { backgroundColor: C.inkFaint },
} as const;
const VALUE_ROW_SX = { display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 1 } as const;
const NUM = { fontFamily: HUD.font.num, fontVariantNumeric: 'tabular-nums' } as const;
const PCT_SX = { ...NUM, color: C.ink } as const;
const DRAW_SX = { ...NUM, color: C.inkDim, fontSize: 11 } as const;
// A segmented row: one shared edge, square inner corners.
const PRESETS_SX = {
  gridColumn: '1 / -1', display: 'flex',
  '& > button': { flex: 1, minWidth: 0, borderRadius: 0, px: 0.5 },
  '& > button:not(:first-of-type)': { ml: '-1px' },
  '& > button:first-of-type': { borderRadius: '3px 0 0 3px' },
  '& > button:last-of-type': { borderRadius: '0 3px 3px 0' },
} as const;
const CHOICE_SX = { ...WINDOW_BTN_SECONDARY_SX, ...NUM } as const;
const PICKED_SX = { ...CHOICE_SX, borderColor: C.auto, color: C.auto } as const;
const THROTTLE_SX = { gridColumn: '1 / -1', px: 1 } as const;
const SLIDER_SX = {
  color: C.auto, py: 1,
  '& .MuiSlider-mark': { backgroundColor: C.inkDim },
} as const;
