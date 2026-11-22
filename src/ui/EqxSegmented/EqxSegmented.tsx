/**
 * EqxSegmented: pick one of 2-5 views or values. Wraps MUI `ToggleButtonGroup`
 * (exclusive). Each option is text (`label`, optionally with a leading `icon`)
 * or an icon with a required `tooltip` (also its aria-label). `onChange` fires
 * once per pick, never on a re-click of the current option; an option's
 * `onPress` fires on EVERY press (re-clicks too) with the button element, for
 * a menu anchored to it. The group carries `data-value` (the current id).
 * Fewer than 2 or more than 5 options throws in dev. Default = panel look (mock
 * `.seg`): full width, equal segments, selected = cyan wash; with
 * `appliedValue` set and differing from `value`, the selected option shows the
 * amber "changed" wash (not yet applied). `hud` is the variant that floats
 * over the game: the frozen mode-switch look (`HUD.segmentedHud`). Colours and
 * font from `hud/tokens.ts`; no sx / style / className.
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
  (
    | {
        label: string;
        icon?: ReactNode;
        /** Accessible name when it differs from the label. */
        ariaLabel?: string;
      }
    | { icon: ReactNode; tooltip: string }
  );

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
  /** Floats over the game: the frozen mode-switch look (`HUD.segmentedHud`). */
  hud?: boolean;
  'data-testid'?: string;
}

export const SEGMENTED_MIN = 2;
export const SEGMENTED_MAX = 5;

const SEG = HUD.segmented;

const SH = HUD.segmentedHud;
/** `hud`: exactly the pre-catalogue mode-switch look (tokens `HUD.segmentedHud`). */
const HUD_SX = {
  bgcolor: SH.bg,
  borderRadius: SH.radius,
  '& .MuiToggleButton-root': {
    px: { xs: SH.padXPhone, sm: SH.padXDesktop },
    py: { xs: SH.padYPhone, sm: SH.padYDesktop },
    fontSize: { xs: SH.fontPhone, sm: SH.fontDesktop },
    lineHeight: SH.lineHeight,
    color: SH.ink,
    borderColor: SH.edge,
    textTransform: 'none' as const,
    gap: SH.gap,
  },
  '& .MuiToggleButton-root.Mui-selected': { color: HUD.color.brand, bgcolor: SH.selectedBg },
  '& .MuiToggleButton-root.Mui-selected:hover': { bgcolor: SH.selectedHoverBg },
  '& .MuiSvgIcon-root': { fontSize: { xs: SH.iconPhone, sm: SH.iconDesktop }, mr: SH.iconGap },
} as const;

export function EqxSegmented({
  options,
  value,
  onChange,
  label,
  appliedValue,
  disabled = false,
  hud = false,
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
      data-value={value}
      data-changed={changed ? 'true' : undefined}
      sx={hud ? HUD_SX : {
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
      {options.map((o) => {
        const common = {
          value: o.id,
          'data-testid': o.testId ?? (testId ? `${testId}-${o.id}` : undefined),
          onClick: o.onPress ? (e: MouseEvent<HTMLElement>) => o.onPress?.(e.currentTarget) : undefined,
        };
        return 'label' in o ? (
          <ToggleButton key={o.id} {...common} aria-label={o.ariaLabel}>
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
