/**
 * EqxButton: the one text button. Wraps MUI `Button`.
 * Look comes only from named props (`tone`, `size`, `fullWidth`) and
 * `hud/tokens.ts`; there is no sx / style / className pass-through (plan C2).
 * Matches the mock's `.btn`: sentence case (no MUI uppercase), Chakra Petch
 * 700, 5 px corners, no ripple; disabled keeps its colours at `.35` opacity.
 */
import { Button } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';

/**
 * The tones every Eqx control shares. The colour hints (selection-HUD hex buttons):
 * `good` green = move / confirm, `danger` red = attack / lock / cancel, `patrol` blue,
 * `warn` amber = salvage, `primary` cyan = boost / more, `neutral` grey.
 */
export type EqxTone = 'primary' | 'secondary' | 'danger' | 'good' | 'warn' | 'patrol' | 'neutral';

/** Tone -> token colour. One map, reused by EqxIconButton. */
export const TONE_COLOR: Readonly<Record<EqxTone, string>> = {
  /** Cyan (mock `.btn.pri`). */
  primary: HUD.color.auto,
  secondary: HUD.color.ink,
  danger: HUD.color.danger,
  good: HUD.color.hullOk,
  warn: HUD.color.manual,
  patrol: HUD.hex.patrol,
  neutral: HUD.color.inkDim,
};

/** Filled tones (dark text on the tone colour); the rest are outlined. */
export const FILLED_TONES: ReadonlySet<EqxTone> = new Set<EqxTone>(['primary']);

export type EqxButtonSize = 'small' | 'medium' | 'large';

export interface EqxButtonProps {
  children: ReactNode;
  onClick?: () => void;
  /** Default `secondary`. Primary (cyan) is filled; secondary and danger are outlined. */
  tone?: EqxTone;
  /** Default `small` (client rule: start tiny, grow on request). */
  size?: EqxButtonSize;
  /** Fill the row (mock footer buttons share it equally). */
  fullWidth?: boolean;
  disabled?: boolean;
  'data-testid'?: string;
}

export function EqxButton({
  children,
  onClick,
  tone = 'secondary',
  size = 'small',
  fullWidth = false,
  disabled = false,
  'data-testid': testId,
}: EqxButtonProps) {
  const color = TONE_COLOR[tone];
  const filled = FILLED_TONES.has(tone);
  // Secondary is ink on the mock's edge2 border; the others edge in their colour.
  const border = tone === 'secondary' ? HUD.color.edge2 : color;
  const look = {
    color: filled ? HUD.color.onAccent : color,
    bgcolor: filled ? color : 'transparent',
    borderColor: border,
  };
  return (
    <Button
      variant={filled ? 'contained' : 'outlined'}
      size={size}
      fullWidth={fullWidth}
      disabled={disabled}
      disableRipple
      disableElevation
      onClick={onClick}
      data-testid={testId}
      data-tone={tone}
      sx={{
        ...look,
        fontFamily: HUD.font.label,
        fontWeight: 700,
        textTransform: 'none',
        borderRadius: `${HUD.panel.radius}px`,
        border: `1px solid ${border}`,
        ...(size === 'small' && { fontSize: HUD.panel.btnFont, py: `${HUD.panel.btnPad}px` }),
        '&:hover': { ...look, bgcolor: filled ? color : HUD.color.panel },
        '&.Mui-disabled': { ...look, opacity: HUD.panel.offOpacity },
      }}
    >
      {children}
    </Button>
  );
}
