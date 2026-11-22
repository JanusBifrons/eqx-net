/**
 * EqxSegmented: pick one of 2-4 views or values. Wraps MUI `ToggleButtonGroup`
 * (exclusive). Each option is text (`label`) or an icon with a required
 * `tooltip` (also its aria-label). `onChange` fires once per pick, never on a
 * re-click of the current option. Fewer than 2 or more than 4 options throws
 * in dev. Colours and font from `hud/tokens.ts`; no sx / style / className.
 */
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxTooltip } from '../EqxTooltip/EqxTooltip.js';

export type EqxSegmentedOption =
  | { id: string; label: string }
  | { id: string; icon: ReactNode; tooltip: string };

export interface EqxSegmentedProps {
  /** 2 to 4 options. */
  options: readonly EqxSegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export const SEGMENTED_MIN = 2;
export const SEGMENTED_MAX = 4;

export function EqxSegmented({
  options,
  value,
  onChange,
  label,
  disabled = false,
  'data-testid': testId,
}: EqxSegmentedProps) {
  if (import.meta.env.DEV && (options.length < SEGMENTED_MIN || options.length > SEGMENTED_MAX)) {
    throw new Error(
      `EqxSegmented takes ${SEGMENTED_MIN}-${SEGMENTED_MAX} options, got ${options.length}; use EqxDropdown for more.`,
    );
  }
  return (
    <ToggleButtonGroup
      exclusive
      value={value}
      onChange={(_e, next: string | null) => {
        if (next !== null && next !== value) onChange(next);
      }}
      aria-label={label}
      disabled={disabled}
      size="small"
      data-testid={testId}
      sx={{
        '& .MuiToggleButton-root': {
          fontFamily: HUD.font.label,
          color: HUD.color.inkDim,
          borderColor: HUD.color.edge2,
          minHeight: HUD.touchMin,
        },
        '& .MuiToggleButton-root.Mui-selected': { color: HUD.color.brand, bgcolor: HUD.color.cell },
      }}
    >
      {options.map((o) =>
        'label' in o ? (
          <ToggleButton key={o.id} value={o.id} data-testid={testId ? `${testId}-${o.id}` : undefined}>
            {o.label}
          </ToggleButton>
        ) : (
          <ToggleButton
            key={o.id}
            value={o.id}
            aria-label={o.tooltip}
            data-testid={testId ? `${testId}-${o.id}` : undefined}
          >
            <EqxTooltip title={o.tooltip}>
              <span>{o.icon}</span>
            </EqxTooltip>
          </ToggleButton>
        ),
      )}
    </ToggleButtonGroup>
  );
}
