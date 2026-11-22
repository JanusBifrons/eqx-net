/**
 * EqxIconButton: the one icon button (right rail, left strip, fly-outs).
 * Wraps MUI `IconButton` (+ `Badge`) inside an EqxTooltip.
 * - One fixed box: `HUD.size.iconButton` square, icon centred, whatever the icon.
 * - `tooltip` is required and is also the accessible name (aria-label).
 * - No label prop: icon-only by design (left-strip rule).
 */
import { Badge, Box, IconButton } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { TONE_COLOR, type EqxTone } from '../EqxButton/EqxButton.js';
import { EqxTooltip } from '../EqxTooltip/EqxTooltip.js';

export interface EqxIconButtonProps {
  /** The icon element (e.g. an `@mui/icons-material` icon or a game SVG). */
  icon: ReactNode;
  /** Required: shown on hover / long-press and used as aria-label. */
  tooltip: string;
  onClick?: () => void;
  /** Default `secondary`. */
  tone?: EqxTone;
  /** Selected / open state: tone-coloured edge and well. */
  active?: boolean;
  /** Count badge; 0 or undefined shows none. */
  badge?: number;
  /** Touch hold before the tooltip shows (passes to EqxTooltip). */
  holdMs?: number;
  disabled?: boolean;
  'data-testid'?: string;
}

export function EqxIconButton({
  icon,
  tooltip,
  onClick,
  tone = 'secondary',
  active = false,
  badge,
  holdMs,
  disabled = false,
  'data-testid': testId,
}: EqxIconButtonProps) {
  const color = TONE_COLOR[tone];
  const box = HUD.size.iconButton;
  return (
    <EqxTooltip title={tooltip} {...(holdMs === undefined ? {} : { holdMs })}>
      {/* A wrapper so the tooltip still works when the button is disabled. */}
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <IconButton
          aria-label={tooltip}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          data-testid={testId}
          data-tone={tone}
          data-active={active ? 'true' : 'false'}
          sx={{
            width: box,
            height: box,
            minWidth: box,
            minHeight: box,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            color,
            bgcolor: active ? HUD.color.cell : 'transparent',
            border: `1px solid ${active ? color : HUD.color.panelEdge}`,
            borderRadius: '50%',
            '&:hover': { bgcolor: HUD.color.panel },
          }}
        >
          <Badge
            badgeContent={badge}
            invisible={!badge}
            data-testid={testId ? `${testId}-badge` : undefined}
            slotProps={{ badge: { sx: { fontFamily: HUD.font.num, color: HUD.color.appBg, bgcolor: color } } }}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {icon}
          </Badge>
        </IconButton>
      </Box>
    </EqxTooltip>
  );
}
