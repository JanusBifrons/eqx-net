/**
 * EqxStrip: the left strip, one icon column (UI language plan A5).
 * - Children: EqxIconButton, EqxStripIdentity, EqxStatusFlyout and EqxStrip.Separator only;
 *   anything else warns in dev. No text at all except count badges.
 * - Look = the mock .lbar: docked to the left edge (no left border, square left
 *   corners), `HUD.strip` paper / edge / padding / gap. Width is exactly one strip
 *   tile (`HUD.strip.tile`) plus padding and the right border; every tile centred.
 *   Children use EqxIconButton `variant="strip"`.
 * - `open` (optional) slides it in from the left (MUI `Slide`), fully out of view
 *   when closed; duration / easing from `HUD.motion`; instant under
 *   prefers-reduced-motion. Omit `open` for an always-shown strip.
 * - `orientation` (default vertical): `horizontal` is the fly-out box (mock .flyo):
 *   one row of the same tiles, cyan edge all round, `HUD.strip.flyRadius` corners,
 *   `flyGap` between tiles, a short slide-in (none under prefers-reduced-motion).
 * - Does not position itself: a layout Slot mounts it.
 */
import { Box, Divider, Slide, keyframes, useMediaQuery } from '@mui/material';
import { Children, isValidElement, type ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { EqxStatusFlyout } from '../EqxStatusFlyout/EqxStatusFlyout.js';
import { EqxStripIdentity } from '../EqxStripIdentity/EqxStripIdentity.js';

const S = HUD.strip;
/** Strip thickness: one tile + padding both sides + the one (right) border. */
export const STRIP_WIDTH = S.tile + 2 * S.pad + 1;
/** Fly-out row thickness: one tile + padding + top and bottom border. */
export const FLYOUT_HEIGHT = S.tile + 2 * S.pad + 2;

const flyIn = keyframes({
  from: { opacity: 0, transform: `translateX(-${S.flyInPx}px)` },
  to: { opacity: 1, transform: 'none' },
});

export type EqxStripOrientation = 'vertical' | 'horizontal';

export interface EqxStripProps {
  /** EqxIconButton / EqxStripIdentity / EqxStatusFlyout / EqxStrip.Separator only. */
  children: ReactNode;
  /** Slide in (true) / fully out of view (false). Omit: always shown, no slide. */
  open?: boolean;
  /** One column (default) or the fly-out row; every tile the same box either way. */
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
      sx={{
        alignSelf: 'center',
        width: S.tile - 2 * S.sepInset,
        my: `${S.sepMargin}px`,
        borderColor: S.edge,
      }}
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
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const vertical = orientation === 'vertical';
  const look = vertical
    ? {
        // The strip sits flush on the left edge; on a phone with a camera band the
        // background fills the band and the buttons step clear of it.
        width: `calc(${STRIP_WIDTH}px + env(safe-area-inset-left, 0px))`,
        paddingLeft: `calc(${S.pad}px + env(safe-area-inset-left, 0px))`,
        flexDirection: 'column' as const,
        gap: `${S.gap}px`,
        border: `1px solid ${S.edge}`,
        borderLeft: 0,
        borderRadius: `0 ${S.radius}px ${S.radius}px 0`,
      }
    : {
        height: FLYOUT_HEIGHT,
        flexDirection: 'row' as const,
        gap: `${S.flyGap}px`,
        border: `1px solid ${HUD.color.auto}`,
        borderRadius: `${S.flyRadius}px`,
        ...(reduceMotion ? {} : { animation: `${flyIn} ${S.flyInMs}ms ease` }),
      };
  const column = (
    <Box
      role="toolbar"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      data-testid={testId}
      data-open={open === undefined ? undefined : String(open)}
      sx={{
        boxSizing: 'border-box',
        padding: `${S.pad}px`,
        display: 'flex',
        alignItems: 'center',
        bgcolor: S.bg,
        ...look,
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
