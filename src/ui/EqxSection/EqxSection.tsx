/**
 * EqxSection: a small section heading in a scrolling panel (mock `.sec`),
 * with the section's rows under it. Faint uppercase label; the section is a
 * `<section>` named by its heading. Does not position itself.
 */
import { useId, type ReactNode } from 'react';
import { Box } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';

export interface EqxSectionProps {
  /** The heading ("Offers", "Nearby"). Also the section's accessible name. */
  title: string;
  /** The section's rows. */
  children?: ReactNode;
  'data-testid'?: string;
}

const L = HUD.list;

const SECTION_SX = { display: 'flex', flexDirection: 'column', gap: `${HUD.panel.bodyGap}px`, minWidth: 0 } as const;
const HEAD_SX = {
  m: 0,
  mt: `${L.secTop}px`,
  fontFamily: HUD.font.label,
  fontSize: L.secFont,
  fontWeight: 400,
  letterSpacing: L.secTracking,
  textTransform: 'uppercase',
  color: HUD.color.inkFaint,
} as const;

export function EqxSection({ title, children, 'data-testid': testId }: EqxSectionProps) {
  const headId = useId();
  return (
    <Box component="section" sx={SECTION_SX} aria-labelledby={headId} data-testid={testId}>
      <Box component="h3" id={headId} sx={HEAD_SX}>{title}</Box>
      {children}
    </Box>
  );
}
