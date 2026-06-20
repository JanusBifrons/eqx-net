import { Box } from '@mui/material';

/**
 * Reusable PUBLIC ship-level badge (Phase 4 WS-B1, plan: effervescent-umbrella).
 *
 * Ship level is public (D13): a small `Lv N` chip rendered wherever a ship is
 * surfaced to the player — on the in-world ship (via the renderer) and on the
 * roster card (both compact + full variants). This single component is the one
 * place the badge's look lives, so a restyle touches one file.
 *
 * Renders NOTHING for level ≤ 1 (an un-levelled ship pays no visual noise),
 * mirroring the wire's "absent ⇒ level 1, zero bytes" discipline. The level is
 * a discrete scalar read from the render mirror / roster — never an id, so it's
 * safe to show as text (no-raw-ids rule).
 *
 * Sized tiny per the project sizing default (start small; grow on request).
 */
const BADGE_SX = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  px: 0.5,
  height: 13,
  borderRadius: 0.5,
  bgcolor: 'rgba(255, 196, 0, 0.16)',
  border: '1px solid rgba(255, 196, 0, 0.55)',
  color: '#ffc400',
  fontSize: 8,
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: 0.2,
  whiteSpace: 'nowrap',
} as const;

interface LevelBadgeProps {
  /** Ship level (≥ 1). Absent / ≤ 1 ⇒ nothing renders. */
  level: number | undefined;
}

export function LevelBadge({ level }: LevelBadgeProps): JSX.Element | null {
  if (level === undefined || level <= 1) return null;
  return (
    <Box component="span" data-testid="level-badge" data-level={level} sx={BADGE_SX}>
      Lv {level}
    </Box>
  );
}
