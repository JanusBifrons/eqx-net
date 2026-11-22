/**
 * EqxTooltip: the one tooltip. Wraps MUI `Tooltip`.
 * Shows on hover on desktop and on press-and-hold (`holdMs`) on touch.
 * Styled from `hud/tokens.ts`; no sx / style / className pass-through.
 */
import { Tooltip } from '@mui/material';
import type { ReactElement } from 'react';
import { HUD } from '../../client/hud/tokens.js';

export interface EqxTooltipProps {
  /** The tooltip text. */
  title: string;
  /** Touch: how long a press must be held before the tooltip shows. Omit for MUI's default. */
  holdMs?: number;
  /** One element that can hold a ref (MUI Tooltip contract). */
  children: ReactElement;
}

export function EqxTooltip({ title, holdMs, children }: EqxTooltipProps) {
  return (
    <Tooltip
      title={title}
      {...(holdMs === undefined ? {} : { enterTouchDelay: holdMs })}
      slotProps={{
        tooltip: {
          sx: {
            fontFamily: HUD.font.label,
            color: HUD.color.ink,
            bgcolor: HUD.color.panel,
            border: `1px solid ${HUD.color.panelEdge}`,
          },
        },
      }}
    >
      {children}
    </Tooltip>
  );
}
