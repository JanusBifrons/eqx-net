import { useUIStore, useIsLoadingActive } from '../state/store';

/**
 * Hidden, plain-DOM mirror of the always-required HUD `data-testid`s.
 *
 * The real diagnostics live inside the AdvancedDrawer's Dev tab. Even though
 * `keepMounted` is now ON (2026-05-13, commit `2aa7d4f` — see
 * `AdvancedDrawer.tsx`), Dev-tab content only renders when `drawerTab === 'debug' && isDrawerOpen`
 * to avoid the 17 Hz snapshot-rate cost while invisible. So the diagnostics
 * are NOT queryable from arbitrary E2E specs. Several existing specs
 * (`feel-test-lockstep`, `swarm-tidi`, `tidi-overlay`, etc.) read these
 * values via `textContent` and assume they're always queryable — this
 * component provides that always-mounted contract surface.
 *
 * This component renders the bare minimum — plain `<div>`s, no MUI, no
 * emotion CSS-in-JS, `display: none` so nothing paints. Each value is a
 * separate Zustand selector subscription so React only re-renders the
 * affected leaf when its slice changes.
 */
export function HudTestAttributes(): JSX.Element {
  // Plan: crispy-kazoo, Commit 5 — positive-signal pause-boundary
  // surface for E2E specs. Stays mounted (contract), exposes the
  // current `useIsLoadingActive` value as `data-loading-active="0|1"`.
  // Specs can `waitForSelector('[data-loading-active="0"]')` to know
  // the curtain has dropped without polling for the WarpScreen
  // disappearance.
  const isLoadingActive = useIsLoadingActive();
  return (
    <div
      data-testid="hud-test-attributes"
      data-loading-active={isLoadingActive ? '1' : '0'}
      style={{ display: 'none' }}
      aria-hidden
    >
      <ShipCount />
      <SwarmCount />
      <ClockRate />
      <ServerTickHz />
      <ShieldPct />
      <HullPct />
    </div>
  );
}

function ShipCount(): JSX.Element {
  const n = useUIStore((s) => s.shipCount);
  return <div data-testid="ship-count">Ships: {n}</div>;
}

function SwarmCount(): JSX.Element {
  const n = useUIStore((s) => s.swarmCount);
  return <div data-testid="swarm-count">Swarm: {n}</div>;
}

function ClockRate(): JSX.Element {
  const r = useUIStore((s) => s.clockRate);
  return <div data-testid="clock-rate">{r.toFixed(2)}×</div>;
}

function ServerTickHz(): JSX.Element {
  const hz = useUIStore((s) => s.serverTickHz);
  return <div data-testid="server-tick-hz">{hz.toFixed(0)}</div>;
}

function ShieldPct(): JSX.Element {
  const p = useUIStore((s) => s.shieldPct);
  return <div data-testid="shield-pct">{Math.round(p)}</div>;
}

function HullPct(): JSX.Element {
  const p = useUIStore((s) => s.hullPct);
  return <div data-testid="hull-pct">{Math.round(p)}</div>;
}
