/**
 * EqxButton: the one text button. Wraps MUI `Button`.
 * Look comes only from named props (`tone`, `size`) and `hud/tokens.ts`;
 * there is no sx / style / className pass-through (plan C2).
 */
import { Button } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';

/** The three tones every Eqx control shares. */
export type EqxTone = 'primary' | 'secondary' | 'danger' | 'manual';

/** Tone -> token colour. One map, reused by EqxIconButton. */
export const TONE_COLOR: Readonly<Record<EqxTone, string>> = {
  primary: HUD.color.brand,
  secondary: HUD.color.ink,
  danger: HUD.color.danger,
  /** Amber: manual, or changed but not applied (plan B3). */
  manual: HUD.color.manual,
};

export type EqxButtonSize = 'small' | 'medium' | 'large';

export interface EqxButtonProps {
  children: ReactNode;
  onClick?: () => void;
  /** Default `secondary`. Primary is filled; secondary, danger and manual are outlined. */
  tone?: EqxTone;
  /** Default `small` (client rule: start tiny, grow on request). */
  size?: EqxButtonSize;
  disabled?: boolean;
  'data-testid'?: string;
}

export function EqxButton({
  children,
  onClick,
  tone = 'secondary',
  size = 'small',
  disabled = false,
  'data-testid': testId,
}: EqxButtonProps) {
  const color = TONE_COLOR[tone];
  const filled = tone === 'primary';
  return (
    <Button
      variant={filled ? 'contained' : 'outlined'}
      size={size}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      data-tone={tone}
      sx={{
        fontFamily: HUD.font.label,
        color: filled ? HUD.color.appBg : color,
        bgcolor: filled ? color : 'transparent',
        borderColor: color,
        '&:hover': { bgcolor: filled ? color : HUD.color.panel, borderColor: color },
      }}
    >
      {children}
    </Button>
  );
}
