/**
 * EqxStatusFlyout: a left-strip status icon whose options fly out beside it
 * (UI language plan A5 "Quick change").
 * Composes EqxIconButton `variant="strip"` (trigger + every option, so all share
 * the one strip tile `HUD.strip.tile`) inside an MUI `Popper` placed to the right,
 * `HUD.strip.flyOffset` away; the options sit in a horizontal EqxStrip (the cyan
 * fly-out box, mock .flyo), so the strip look lives in one place.
 * - The trigger is a cyan status tile showing the current option's icon (a
 *   `danger` option turns the icon red); open = cyan ring. `tooltip` is its name.
 *   With no current value (null) it shows `emptyIcon` and no option is active.
 * - Options are plain icon-only tiles, tooltips on hover / hold; the current one is
 *   `active` (cyan edge + icon).
 * - A pick calls `onChange(id)` once and closes. An outside tap or Esc closes
 *   without calling it. Esc is taken in the capture phase while open, so the
 *   fly-out closes before anything else Esc would close (plan B4 Esc order).
 * - The fly-out renders in place (no portal), so it takes the z-order of the
 *   Slot the strip is mounted in. It never positions the strip itself.
 */
import { Box, ClickAwayListener, Popper } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EqxTone } from '../EqxButton/EqxButton.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { EqxStrip } from '../EqxStrip/EqxStrip.js';

export interface EqxStatusOption<Id extends string = string> {
  id: Id;
  /** The option's icon (from the icon registry once it lands). */
  icon: ReactNode;
  /** Required: shown on hover / long-press and used as aria-label. */
  tooltip: string;
  /** Default `secondary`. `danger` (e.g. Aggressive) turns the trigger icon red while current. */
  tone?: EqxTone;
}

export interface EqxStatusFlyoutProps<Id extends string = string> {
  /** The current option's id; null when none applies (e.g. a mixed selection). */
  value: Id | null;
  /** The trigger icon while `value` is null (a neutral icon); no option is active then. */
  emptyIcon?: ReactNode;
  options: readonly EqxStatusOption<Id>[];
  /** Called once with the picked id; the fly-out then closes. */
  onChange: (id: Id) => void;
  /** Required: the trigger's tooltip and accessible name (e.g. "Stance"). */
  tooltip: string;
  /** Touch hold before tooltips show (passes to EqxIconButton). */
  holdMs?: number;
  disabled?: boolean;
  /** Trigger testid; the fly-out is `${testid}-options`, each option `${testid}-option-${id}`. */
  'data-testid'?: string;
}

export function EqxStatusFlyout<Id extends string = string>({
  value,
  emptyIcon,
  options,
  onChange,
  tooltip,
  holdMs,
  disabled = false,
  'data-testid': testId,
}: EqxStatusFlyoutProps<Id>) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const current = options.find((o) => o.id === value);
  const hold = holdMs === undefined ? {} : { holdMs };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const pick = (id: Id): void => {
    setOpen(false);
    onChange(id);
  };

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box component="span" ref={anchorRef} sx={{ display: 'inline-flex' }}>
        <EqxIconButton
          icon={current === undefined ? emptyIcon : current.icon}
          tooltip={tooltip}
          variant="strip"
          status={current?.tone === 'danger' ? 'alert' : 'calm'}
          active={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          {...hold}
          {...(testId === undefined ? {} : { 'data-testid': testId })}
        />
        <Popper
          open={open}
          anchorEl={anchorRef.current}
          placement="right"
          disablePortal
          modifiers={[{ name: 'offset', options: { offset: [0, HUD.strip.flyOffset] } }]}
        >
          <EqxStrip
            orientation="horizontal"
            aria-label={tooltip}
            {...(testId === undefined ? {} : { 'data-testid': `${testId}-options` })}
          >
            {options.map((o) => (
              <EqxIconButton
                key={o.id}
                icon={o.icon}
                tooltip={o.tooltip}
                variant="strip"
                active={o.id === value}
                onClick={() => pick(o.id)}
                {...hold}
                {...(testId === undefined ? {} : { 'data-testid': `${testId}-option-${o.id}` })}
              />
            ))}
          </EqxStrip>
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}
