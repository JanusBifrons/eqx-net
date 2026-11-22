/**
 * EqxSegmented: pick one of 2-5 views or values. Wraps MUI `ToggleButtonGroup`
 * (exclusive). Each option is text (`label`) or an icon with a required
 * `tooltip` (also its aria-label). `onChange` fires once per pick, never on a
 * re-click of the current option. Fewer than 2 or more than 5 options throws
 * in dev. Panel look (mock `.seg`): full width, equal segments, selected =
 * cyan wash; with `appliedValue` set and differing from `value`, the selected
 * option shows the amber "changed" wash (not yet applied). Colours and font from `hud/tokens.ts`; no sx / style / className.
 */
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxTooltip } from '../EqxTooltip/EqxTooltip.js';

export type EqxSegmentedOption =
  | { id: string; label: string }
  | { id: string; icon: ReactNode; tooltip: string };

export interface EqxSegmentedProps {
  /** 2 to 5 options. */
  options: readonly EqxSegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the group. */
  label: string;
  /** The value in force now; when `value` differs, the selected option shows amber (changed). */
  appliedValue?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export const SEGMENTED_MIN = 2;
export const SEGMENTED_MAX = 5;

const SEG = HUD.segmented;

export function EqxSegmented({
  options,
  value,
  onChange,
  label,
  appliedValue,
  disabled = false,
  'data-testid': testId,
}: EqxSegmentedProps) {
  if (import.meta.env.DEV && (options.length < SEGMENTED_MIN || options.length > SEGMENTED_MAX)) {
    throw new Error(
      `EqxSegmented takes ${SEGMENTED_MIN}-${SEGMENTED_MAX} options, got ${options.length}; use EqxDropdown for more.`,
    );
  }
  const changed = appliedValue !== undefined && appliedValue !== value;
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
      data-changed={changed ? 'true' : undefined}
      sx={{
        display: 'flex',
        width: '100%',
        border: 1,
        borderColor: HUD.color.edge2,
        borderRadius: `${SEG.radius}px`,
        overflow: 'hidden',
        // Grouped selectors match MUI's own specificity so these win (sx comes last).
        '& .MuiToggleButtonGroup-grouped, & .MuiToggleButtonGroup-grouped:not(:first-of-type)': {
          flex: 1,
          fontFamily: HUD.font.label,
          fontWeight: 500,
          fontSize: SEG.font,
          textTransform: 'none',
          color: HUD.color.inkDim,
          border: 0,
          borderRadius: 0,
          borderLeft: 1,
          borderLeftColor: HUD.color.panelEdge,
          py: `${SEG.padY}px`,
          px: `${SEG.padX}px`,
          minHeight: SEG.minHeight,
          ml: 0,
        },
        '& .MuiToggleButtonGroup-grouped:first-of-type': { borderLeft: 0 },
        '& .MuiToggleButtonGroup-grouped.Mui-selected, & .MuiToggleButtonGroup-grouped.Mui-selected:hover': changed
          ? { color: HUD.color.manual, bgcolor: SEG.changedBg }
          : { color: HUD.color.auto, bgcolor: SEG.selectedBg },
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
