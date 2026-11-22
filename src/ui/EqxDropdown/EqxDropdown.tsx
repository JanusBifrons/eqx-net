/**
 * EqxDropdown: the one pick-from-a-list control.
 * - `searchable` -> MUI `Autocomplete` (type to filter the options by label).
 * - plain        -> MUI `Select`.
 * One component, one prop. `multiple` makes `value` / `onChange` an array of ids.
 * `label` is the visible label and the accessible name. Colours and font from
 * `hud/tokens.ts`; no sx / style / className pass-through (plan C2).
 */
import { Autocomplete, FormControl, InputLabel, MenuItem, Select, TextField } from '@mui/material';
import { useId } from 'react';
import { HUD } from '../../client/hud/tokens.js';

/** One choice: a stable id (what `value` holds) and the text shown. */
export interface EqxDropdownOption {
  id: string;
  label: string;
}

interface EqxDropdownBase {
  options: readonly EqxDropdownOption[];
  /** Visible label and accessible name. */
  label: string;
  /** Type-to-filter (MUI Autocomplete underneath). Default false (MUI Select). */
  searchable?: boolean;
  /** Shown while nothing is picked. */
  placeholder?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export interface EqxDropdownSingleProps extends EqxDropdownBase {
  multiple?: false;
  /** The picked id, or null for none. */
  value: string | null;
  onChange: (value: string | null) => void;
}

export interface EqxDropdownMultipleProps extends EqxDropdownBase {
  multiple: true;
  /** The picked ids, in pick order. */
  value: readonly string[];
  onChange: (value: string[]) => void;
}

export type EqxDropdownProps = EqxDropdownSingleProps | EqxDropdownMultipleProps;

const FIELD_SX = {
  '& .MuiInputBase-root': { fontFamily: HUD.font.label, color: HUD.color.ink },
  '& .MuiInputLabel-root': { fontFamily: HUD.font.label, color: HUD.color.inkDim },
  '& .MuiOutlinedInput-notchedOutline': { borderColor: HUD.color.edge2 },
} as const;

export function EqxDropdown(props: EqxDropdownProps) {
  return props.searchable ? <SearchableDropdown {...props} /> : <PlainDropdown {...props} />;
}

function SearchableDropdown(props: EqxDropdownProps) {
  const { options, label, placeholder, disabled = false, 'data-testid': testId } = props;
  const byId = (id: string) => options.find((o) => o.id === id);
  const common = {
    options,
    disabled,
    size: 'small' as const,
    fullWidth: true,
    'data-testid': testId,
    sx: FIELD_SX,
    getOptionLabel: (o: EqxDropdownOption) => o.label,
    isOptionEqualToValue: (a: EqxDropdownOption, b: EqxDropdownOption) => a.id === b.id,
    renderInput: (params: object) => (
      <TextField {...params} label={label} {...(placeholder === undefined ? {} : { placeholder })} />
    ),
  };
  if (props.multiple) {
    const onChange = props.onChange;
    const value = props.value.map(byId).filter((o): o is EqxDropdownOption => o !== undefined);
    return (
      <Autocomplete<EqxDropdownOption, true>
        {...common}
        multiple
        value={value}
        onChange={(_e, next) => onChange(next.map((o) => o.id))}
      />
    );
  }
  const onChange = props.onChange;
  const value = props.value === null ? null : (byId(props.value) ?? null);
  return (
    <Autocomplete<EqxDropdownOption, false>
      {...common}
      value={value}
      onChange={(_e, next) => onChange(next === null ? null : next.id)}
    />
  );
}

function PlainDropdown(props: EqxDropdownProps) {
  const { options, label, placeholder, disabled = false, 'data-testid': testId } = props;
  const labelId = useId();
  const labelOf = (id: string) => options.find((o) => o.id === id)?.label ?? id;
  const items = options.map((o) => (
    <MenuItem key={o.id} value={o.id} sx={{ fontFamily: HUD.font.label }}>
      {o.label}
    </MenuItem>
  ));
  const shownEmpty = placeholder ?? '';
  let control;
  if (props.multiple) {
    const onChange = props.onChange;
    control = (
      <Select<string[]>
        labelId={labelId}
        label={label}
        multiple
        displayEmpty={placeholder !== undefined}
        value={[...props.value]}
        onChange={(e) => {
          const v = e.target.value;
          onChange(typeof v === 'string' ? v.split(',') : v);
        }}
        renderValue={(ids) => (ids.length === 0 ? shownEmpty : ids.map(labelOf).join(', '))}
      >
        {items}
      </Select>
    );
  } else {
    const onChange = props.onChange;
    control = (
      <Select<string>
        labelId={labelId}
        label={label}
        displayEmpty={placeholder !== undefined}
        value={props.value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? null : v);
        }}
        renderValue={(id) => (id === '' ? shownEmpty : labelOf(id))}
      >
        {items}
      </Select>
    );
  }
  return (
    <FormControl size="small" fullWidth disabled={disabled} data-testid={testId} sx={FIELD_SX}>
      <InputLabel id={labelId} {...(placeholder === undefined ? {} : { shrink: true })}>
        {label}
      </InputLabel>
      {control}
    </FormControl>
  );
}
