/**
 * EqxSegmented: pick one of 2-4 views or values. Wraps MUI `ToggleButtonGroup`
 * (exclusive). Each option is text (`label`, optionally with a leading `icon`)
 * or an icon with a required `tooltip` (also its aria-label). `onChange` fires
 * once per pick, never on a re-click of the current option; an option's
 * `onPress` fires on EVERY press (re-clicks too) with the button element, for
 * a menu anchored to it. The group carries `data-value` (the current id).
 * Fewer than 2 or more than 4 options throws in dev. `hud` is the variant that
 * floats over the game: compact, on the HUD panel backing. Colours and font
 * from `hud/tokens.ts`; no sx / style / className.
 */
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { MouseEvent, ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxTooltip } from '../EqxTooltip/EqxTooltip.js';

interface EqxSegmentedOptionBase {
  id: string;
  /** This option's button test id; default `<data-testid>-<id>`. */
  testId?: string;
  /** Fires on every press of this option (re-clicks too), before `onChange`. */
  onPress?: (button: HTMLElement) => void;
}

export type EqxSegmentedOption = EqxSegmentedOptionBase &
  ({ label: string; icon?: ReactNode } | { icon: ReactNode; tooltip: string });

export interface EqxSegmentedProps {
  /** 2 to 4 options. */
  options: readonly EqxSegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
  /** Floats over the game: compact, HUD panel backing, no touch-min height. */
  hud?: boolean;
  'data-testid'?: string;
}

export const SEGMENTED_MIN = 2;
export const SEGMENTED_MAX = 4;

const BASE_SX = {
  '& .MuiToggleButton-root': {
    fontFamily: HUD.font.label,
    color: HUD.color.inkDim,
    borderColor: HUD.color.edge2,
    minHeight: HUD.touchMin,
  },
  '& .MuiToggleButton-root.Mui-selected': { color: HUD.color.brand, bgcolor: HUD.color.cell },
} as const;

const HUD_SX = {
  bgcolor: HUD.color.panel,
  '& .MuiToggleButton-root': {
    typography: 'caption',
    ...BASE_SX['& .MuiToggleButton-root'],
    minHeight: 0,
    px: { xs: 0.75, sm: 1.25 },
    py: { xs: 0.25, sm: 0.5 },
    lineHeight: 1.1,
    textTransform: 'none' as const,
    gap: 0.5,
  },
  '& .MuiToggleButton-root.Mui-selected': BASE_SX['& .MuiToggleButton-root.Mui-selected'],
  '& .MuiSvgIcon-root': { fontSize: '1.25em' },
} as const;

export function EqxSegmented({
  options,
  value,
  onChange,
  label,
  disabled = false,
  hud = false,
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
      data-value={value}
      sx={hud ? HUD_SX : BASE_SX}
    >
      {options.map((o) => {
        const common = {
          value: o.id,
          'data-testid': o.testId ?? (testId ? `${testId}-${o.id}` : undefined),
          onClick: o.onPress ? (e: MouseEvent<HTMLElement>) => o.onPress?.(e.currentTarget) : undefined,
        };
        return 'label' in o ? (
          <ToggleButton key={o.id} {...common}>
            {o.icon}
            {o.label}
          </ToggleButton>
        ) : (
          <ToggleButton key={o.id} {...common} aria-label={o.tooltip}>
            <EqxTooltip title={o.tooltip}>
              <span>{o.icon}</span>
            </EqxTooltip>
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}
