/**
 * EqxStrip: the left strip, one icon column (UI language plan A5).
 * - Children: EqxIconButton, EqxStripIdentity, EqxStatusFlyout and EqxStrip.Separator only;
 *   anything else warns in dev. No text at all except count badges.
 * - Width is exactly one button (`HUD.size.iconButton`) plus the theme gap
 *   (`theme.spacing(1)`, the same 8 px as the layout STACK_GAP); every button centred.
 * - `open` (optional) slides it in from the left (MUI `Slide`), fully out of view
 *   when closed; duration / easing from `HUD.motion`; instant under
 *   prefers-reduced-motion. Omit `open` for an always-shown strip.
 * - `orientation` (default vertical): `horizontal` lays the same buttons out as one
 *   row, one button plus the gap tall (EqxStatusFlyout shows its options in one).
 * - Does not position itself: a layout Slot mounts it.
 */
import { Box, Divider, Slide, useMediaQuery, useTheme } from '@mui/material';
import { Children, isValidElement, type ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { EqxStatusFlyout } from '../EqxStatusFlyout/EqxStatusFlyout.js';
import { EqxStripIdentity } from '../EqxStripIdentity/EqxStripIdentity.js';

export type EqxStripOrientation = 'vertical' | 'horizontal';

export interface EqxStripProps {
  /** EqxIconButton / EqxStripIdentity / EqxStatusFlyout / EqxStrip.Separator only. */
  children: ReactNode;
  /** Slide in (true) / fully out of view (false). Omit: always shown, no slide. */
  open?: boolean;
  /** One column (default) or one row; every button the same box either way. */
  orientation?: EqxStripOrientation;
  /** Accessible name of the toolbar (never shown). */
  'aria-label'?: string;
  'data-testid'?: string;
}

export interface EqxStripSeparatorProps {
  'data-testid'?: string;
}

/** A thin rule between strip groups. No text. */
function EqxStripSeparator({ 'data-testid': testId }: EqxStripSeparatorProps) {
  return (
    <Divider
      flexItem
      data-testid={testId}
      sx={{ alignSelf: 'center', width: HUD.size.iconButton / 2, borderColor: HUD.color.panelEdge }}
    />
  );
}

/** Built on first use: EqxStatusFlyout imports EqxStrip back (it lays its options out in one). */
let allowed: ReadonlySet<unknown> | undefined;

function warnOnForeignChildren(children: ReactNode): void {
  if (!import.meta.env.DEV) return;
  allowed ??= new Set<unknown>([EqxIconButton, EqxStripIdentity, EqxStatusFlyout, EqxStripSeparator]);
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child) || !allowed.has(child.type)) {
      // eslint-disable-next-line no-console -- dev-only contract warning (left strip: icons only)
      console.warn(
        '[EqxStrip] children must be EqxIconButton, EqxStripIdentity, EqxStatusFlyout or EqxStrip.Separator (icons only, no labels).',
        child,
      );
    }
  }
}

export function EqxStrip({
  children,
  open,
  orientation = 'vertical',
  'aria-label': ariaLabel,
  'data-testid': testId,
}: EqxStripProps) {
  warnOnForeignChildren(children);
  const theme = useTheme();
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const gap = Number.parseFloat(theme.spacing(1));
  const thickness = HUD.size.iconButton + gap;
  const vertical = orientation === 'vertical';
  const column = (
    <Box
      role="toolbar"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      data-testid={testId}
      data-open={open === undefined ? undefined : String(open)}
      sx={{
        boxSizing: 'border-box',
        ...(vertical ? { width: thickness } : { height: thickness }),
        padding: `${gap / 2}px`,
        display: 'flex',
        flexDirection: vertical ? 'column' : 'row',
        alignItems: 'center',
        gap: `${gap / 2}px`,
        bgcolor: HUD.color.panel,
        borderRadius: `${thickness / 2}px`,
        pointerEvents: 'auto',
      }}
    >
      {children}
    </Box>
  );
  if (open === undefined) return column;
  return (
    <Slide
      direction="right"
      in={open}
      easing={HUD.motion.slideEasing}
      timeout={reduceMotion ? 0 : { enter: HUD.motion.slideInMs, exit: HUD.motion.slideOutMs }}
    >
      {column}
    </Slide>
  );
}

EqxStrip.Separator = EqxStripSeparator;
