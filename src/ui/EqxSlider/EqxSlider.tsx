/**
 * EqxSlider: the one range control. Wraps MUI `Slider` (single value).
 * `label` is the accessible name (aria-label); the value label shows while
 * dragging. Colours and font from `hud/tokens.ts`; no sx / style / className.
 */
import { Slider } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';

/** A tick on the track, optionally labelled. */
export interface EqxSliderMark {
  value: number;
  label?: string;
}

export interface EqxSliderProps {
  min: number;
  max: number;
  /** Default 1. */
  step?: number;
  /** `true` = a tick at every step; an array = ticks (and labels) at those values. */
  marks?: boolean | readonly EqxSliderMark[];
  value: number;
  onChange: (value: number) => void;
  /** Accessible name. */
  label: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export function EqxSlider({
  min,
  max,
  step = 1,
  marks = false,
  value,
  onChange,
  label,
  disabled = false,
  'data-testid': testId,
}: EqxSliderProps) {
  return (
    <Slider
      min={min}
      max={max}
      step={step}
      marks={typeof marks === 'boolean' ? marks : [...marks]}
      value={value}
      onChange={(_e, next) => {
        const v = Array.isArray(next) ? next[0] : next;
        if (!disabled && v !== undefined && v !== value) onChange(v);
      }}
      aria-label={label}
      valueLabelDisplay="auto"
      disabled={disabled}
      size="small"
      data-testid={testId}
      sx={{
        color: HUD.color.brand,
        '& .MuiSlider-markLabel': { fontFamily: HUD.font.num, color: HUD.color.inkDim },
        '& .MuiSlider-valueLabel': { fontFamily: HUD.font.num, bgcolor: HUD.color.cell, color: HUD.color.ink },
      }}
    />
  );
}
