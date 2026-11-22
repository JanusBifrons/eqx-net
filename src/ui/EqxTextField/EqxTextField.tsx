/**
 * EqxTextField: the one text input. Wraps MUI `TextField` (filled, no
 * underline) drawn as the compact panel field (mock `.field`, `./fieldSx.ts`).
 * `label` is the visible label and the accessible name; `error` is a message:
 * when set, the field turns to the danger state and shows it underneath.
 * Colours and font from `hud/tokens.ts`; no sx / style / className pass-through.
 */
import { TextField } from '@mui/material';
import { FIELD_SX } from './fieldSx.js';

export interface EqxTextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Error message; non-empty turns on the error state and shows the text. */
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Called when the field loses focus (commit a typed value there). */
  onBlur?: () => void;
  /** The on-screen keyboard to show (`decimal` for coordinates). */
  inputMode?: 'text' | 'decimal' | 'numeric';
  'data-testid'?: string;
}

export function EqxTextField({
  label,
  value,
  onChange,
  error,
  placeholder,
  disabled = false,
  onBlur,
  inputMode,
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
      {...(onBlur === undefined ? {} : { onBlur })}
      variant="filled"
      slotProps={{
        input: { disableUnderline: true },
        ...(inputMode === undefined ? {} : { htmlInput: { inputMode } }),
      }}
      size="small"
      fullWidth
      data-testid={testId}
      data-error={hasError ? 'true' : 'false'}
      sx={FIELD_SX}
    />
  );
}
