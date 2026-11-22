/**
 * EqxSwitch: the one on/off control. Wraps MUI `Switch` in a
 * `FormControlLabel`, so `label` is both the visible text and the accessible name.
 * Colours from `hud/tokens.ts`; no sx / style / className pass-through.
 */
import { FormControlLabel, Switch } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';

export interface EqxSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export function EqxSwitch({ checked, onChange, label, disabled = false, 'data-testid': testId }: EqxSwitchProps) {
  return (
    <FormControlLabel
      label={label}
      disabled={disabled}
      data-testid={testId}
      sx={{ color: HUD.color.ink, '& .MuiFormControlLabel-label': { fontFamily: HUD.font.label } }}
      control={
        <Switch
          checked={checked}
          onChange={(_e, next) => onChange(next)}
          size="small"
          sx={{
            '& .MuiSwitch-switchBase.Mui-checked': { color: HUD.color.brand },
            '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: HUD.color.brand },
          }}
        />
      }
    />
  );
}
