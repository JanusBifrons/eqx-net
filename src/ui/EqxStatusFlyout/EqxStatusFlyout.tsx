/**
 * EqxStatusFlyout: a left-strip status icon whose options fly out beside it
 * (UI language plan A5 "Quick change").
 * Composes EqxIconButton (trigger + every option, so all share the one strip
 * box `HUD.size.iconButton`) inside an MUI `Popper` placed to the right.
 * - The trigger shows the current option's icon and tone; `tooltip` is its name.
 * - Options are icon-only, tooltips on hover / hold; the current one is `active`.
 * - A pick calls `onChange(id)` once and closes. An outside tap or Esc closes
 *   without calling it. Esc is taken in the capture phase while open, so the
 *   fly-out closes before anything else Esc would close (plan B4 Esc order).
 * - The fly-out renders in place (no portal), so it takes the z-order of the
 *   Slot the strip is mounted in. It never positions the strip itself.
 */
import { Box, ClickAwayListener, Popper, useTheme } from '@mui/material';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import type { EqxTone } from '../EqxButton/EqxButton.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';

export interface EqxStatusOption<Id extends string = string> {
  id: Id;
  /** The option's icon (from the icon registry once it lands). */
  icon: ReactNode;
  /** Required: shown on hover / long-press and used as aria-label. */
  tooltip: string;
  /** Default `secondary`. */
  tone?: EqxTone;
}

export interface EqxStatusFlyoutProps<Id extends string = string> {
  /** The current option's id. */
  value: Id;
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
  options,
  onChange,
  tooltip,
  holdMs,
  disabled = false,
  'data-testid': testId,
}: EqxStatusFlyoutProps<Id>) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const theme = useTheme();
  const gap = Number.parseFloat(theme.spacing(1));
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
          icon={current?.icon}
          tooltip={tooltip}
          tone={current?.tone ?? 'secondary'}
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
          modifiers={[{ name: 'offset', options: { offset: [0, gap] } }]}
        >
          <Box
            role="toolbar"
            aria-orientation="horizontal"
            aria-label={tooltip}
            data-testid={testId ? `${testId}-options` : undefined}
            sx={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: `${gap / 2}px`,
              padding: `${gap / 2}px`,
              bgcolor: HUD.color.panel,
              border: `1px solid ${HUD.color.panelEdge}`,
              borderRadius: `${(HUD.size.iconButton + gap) / 2}px`,
              pointerEvents: 'auto',
            }}
          >
            {options.map((o) => (
              <EqxIconButton
                key={o.id}
                icon={o.icon}
                tooltip={o.tooltip}
                tone={o.tone ?? 'secondary'}
                active={o.id === value}
                onClick={() => pick(o.id)}
                {...hold}
                {...(testId === undefined ? {} : { 'data-testid': `${testId}-option-${o.id}` })}
              />
            ))}
          </Box>
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}
