/**
 * The owner's power controls on the building settings window's Power tab:
 * an On/Off switch and a Throttle slider (10%..100% in 10% steps), both sent
 * on `set_structure_power`. Shown only for a kind the server lets its owner
 * switch (`hasPowerSwitch`); the throttle only where it changes something
 * (`hasPowerThrottle`: a turret has On/Off only). The current values come
 * from the structure slice (`switchedOff`, `throttle` decoded from the flags),
 * read by the Power tab's 4 Hz poll, so the window follows the server.
 */
import { useEffect, useState } from 'react';
import { Box, Slider } from '@mui/material';
import { HUD } from '../hud/tokens';
import { WINDOW_BTN_SECONDARY_SX } from './GameWindow';
import { hasPowerSwitch, hasPowerThrottle } from './structureSettingsPower';
import { sendSetStructurePower } from '../structures/structureActionsClient';

const MIN_TENTHS = 1;
const MAX_TENTHS = 10;

export interface PowerControlsProps {
  entityId: number;
  kindId: string;
  /** The owner's switch now (false = Off). */
  on: boolean;
  /** The throttle now, in tenths (10 = 100%). */
  throttle: number;
  /** Shared label / value cell styles from the Power tab grid. */
  labelSx: object;
}

export function PowerControls({ entityId, kindId, on, throttle, labelSx }: PowerControlsProps): JSX.Element | null {
  // The slider shows the dragged value until the server's state catches up.
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => setDrag(null), [throttle]);
  if (!hasPowerSwitch(kindId)) return null;
  const shown = drag ?? throttle;
  return (
    <>
      <Box sx={labelSx}>Switch</Box>
      <Box sx={SWITCH_SX} data-testid="settings-power-switch" data-on={on ? '1' : '0'}>
        <Box component="button" sx={on ? PICKED_SX : CHOICE_SX} aria-pressed={on} data-testid="settings-power-on"
          onClick={() => { if (!on) sendSetStructurePower(entityId, true); }}>On</Box>
        <Box component="button" sx={on ? CHOICE_SX : PICKED_SX} aria-pressed={!on} data-testid="settings-power-off"
          onClick={() => { if (on) sendSetStructurePower(entityId, false); }}>Off</Box>
      </Box>
      {hasPowerThrottle(kindId) && (
        <>
          <Box sx={labelSx}>Throttle</Box>
          <Box sx={THROTTLE_SX} data-testid="settings-power-throttle" data-throttle={throttle}>
            <Slider
              size="small" min={MIN_TENTHS} max={MAX_TENTHS} step={1} marks
              value={Math.max(MIN_TENTHS, shown)} sx={SLIDER_SX}
              slotProps={{ input: { 'aria-label': 'Throttle', 'data-testid': 'settings-power-throttle-input' } as object }}
              onChange={(_e, v) => setDrag(v as number)}
              onChangeCommitted={(_e, v) => { if (v !== throttle) sendSetStructurePower(entityId, on, v as number); }}
            />
            <Box sx={PCT_SX} data-testid="settings-power-throttle-value">{shown * 10}%</Box>
          </Box>
        </>
      )}
    </>
  );
}

const C = HUD.color;
const SWITCH_SX = { display: 'flex', justifyContent: 'flex-end', gap: 1 } as const;
const CHOICE_SX = { ...WINDOW_BTN_SECONDARY_SX, minWidth: 48, px: 1.5 } as const;
const PICKED_SX = { ...CHOICE_SX, borderColor: C.auto, color: C.auto } as const;
const THROTTLE_SX = { display: 'flex', alignItems: 'center', gap: 1.5, pl: 1 } as const;
const SLIDER_SX = {
  flex: 1, minWidth: 120, color: C.auto,
  '& .MuiSlider-mark': { backgroundColor: C.inkDim },
} as const;
const PCT_SX = { color: C.ink, fontFamily: HUD.font.num, fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' as const } as const;
