/**
 * EqxTextField: the one text input. Wraps MUI `TextField` (outlined, small).
 * `label` is the visible label and the accessible name; `error` is a message:
 * when set, the field turns to the danger state and shows it underneath.
 * Colours and font from `hud/tokens.ts`; no sx / style / className pass-through.
 */
import { TextField } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';

export interface EqxTextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Error message; non-empty turns on the error state and shows the text. */
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export function EqxTextField({
  label,
  value,
  onChange,
  error,
  placeholder,
  disabled = false,
  'data-testid': testId,
}: EqxTextFieldProps) {
  const hasError = error !== undefined && error !== '';
  return (
    <TextField
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={hasError}
      helperText={hasError ? error : undefined}
      {...(placeholder === undefined ? {} : { placeholder })}
      disabled={disabled}
      size="small"
      fullWidth
      data-testid={testId}
      data-error={hasError ? 'true' : 'false'}
      sx={{
        '& .MuiInputBase-root': { fontFamily: HUD.font.label, color: HUD.color.ink },
        '& .MuiInputLabel-root': { fontFamily: HUD.font.label, color: HUD.color.inkDim },
        '& .MuiOutlinedInput-notchedOutline': { borderColor: HUD.color.edge2 },
        '& .Mui-error .MuiOutlinedInput-notchedOutline': { borderColor: HUD.color.danger },
        '& .MuiFormHelperText-root.Mui-error': { color: HUD.color.danger, fontFamily: HUD.font.label },
      }}
    />
  );
}
