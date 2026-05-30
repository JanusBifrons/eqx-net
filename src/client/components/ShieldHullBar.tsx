import { Box } from '@mui/material';
import { useUIStore } from '../state/store';

/**
 * Tiny top-left shield + hull readout (Phase 8, plan: clever-wombat).
 *
 * "Small but obvious for now; expand later" (user brief): two thin stacked
 * bars — SHLD (cyan) over HULL (green→amber→red). Pure overlay, no
 * background (the Pixi canvas provides contrast), mounted via
 * `<Slot anchor="top-left" order={2}>` between SectorInfoPanel (order 1)
 * and the Hud alert (order 10).
 *
 * The fill width has a CSS `transition`, which IS the locked "client
 * tweens the shield bar" — Halo regen is delivered as discrete anchors
 * (DamageEvent / ShieldEventMessage → Zustand shieldPct), and the bar
 * eases between them with zero JS animation loop and zero continuous
 * shield wire traffic. Separate Zustand selectors so a hull-only change
 * never re-renders the shield leaf.
 *
 * `data-shield-pct` / `data-hull-pct` on the root are the E2E hook; the
 * always-mounted hidden mirror lives in `HudTestAttributes`.
 */
const TRACK_W = 64;
const BAR_H = 4;
const SHIELD_COLOR = '#36c8ff';

// Module-level sx (plan: melodic-engelbart Step 4) — reduces MUI styled-
// component diff machinery work on every render. The component
// re-renders when shieldPct OR hullPct change (1 Hz under combat per
// the 2026-05-25 HUD-dispatch cadence); without hoist each render
// produced 6 fresh sx literals.
const ROOT_SX = {
  display: 'grid',
  gridTemplateColumns: 'auto auto',
  alignItems: 'center',
  columnGap: 0.75,
  rowGap: '3px',
  pointerEvents: 'none' as const,
  userSelect: 'none' as const,
  fontFamily: 'system-ui, sans-serif',
};
const BAR_TRACK_SX = {
  width: TRACK_W,
  height: BAR_H,
  borderRadius: '2px',
  backgroundColor: 'rgba(255,255,255,0.12)',
  overflow: 'hidden' as const,
};
const CAP_SX = {
  fontSize: 8,
  letterSpacing: 0.5,
  color: 'rgba(255,255,255,0.45)',
  textTransform: 'uppercase' as const,
};

export function hullColor(pct: number): string {
  if (pct > 50) return '#44dd55';
  if (pct > 25) return '#ffbb33';
  return '#ff4444';
}

function Bar({ pct, color }: { pct: number; color: string }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, pct));
  // The inner fill is the one sx that cannot be hoisted — width +
  // backgroundColor change every render. Width comes through as a
  // string; transition + height stay constant.
  // 2026-05-25 step 10: 220 ms → 1000 ms to match the 1 Hz HUD
  // dispatch cadence — eliminates per-hit Zustand churn under combat.
  return (
    <Box sx={BAR_TRACK_SX}>
      <Box
        sx={{
          width: `${clamped}%`,
          height: '100%',
          backgroundColor: color,
          transition: 'width 1000ms linear, background-color 1000ms linear',
        }}
      />
    </Box>
  );
}

export function ShieldHullBar(): JSX.Element {
  const shieldPct = useUIStore((s) => s.shieldPct);
  const hullPct = useUIStore((s) => s.hullPct);
  return (
    <Box
      data-testid="shield-hull-bar"
      data-shield-pct={Math.round(shieldPct)}
      data-hull-pct={Math.round(hullPct)}
      sx={ROOT_SX}
    >
      <Cap>SHLD</Cap>
      <Bar pct={shieldPct} color={SHIELD_COLOR} />
      <Cap>HULL</Cap>
      <Bar pct={hullPct} color={hullColor(hullPct)} />
    </Box>
  );
}

function Cap({ children }: { children: string }): JSX.Element {
  return (
    <Box component="span" sx={CAP_SX}>
      {children}
    </Box>
  );
}
