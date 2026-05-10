import { useUIStore } from '../state/store';

/**
 * Hidden, plain-DOM mirror of the always-required HUD `data-testid`s.
 *
 * The real diagnostics now live inside the AdvancedDrawer's Dev tab, which
 * unmounts when the drawer is closed (keepMounted is intentionally OFF for
 * mobile-perf reasons — see `AdvancedDrawer.tsx`). But several existing E2E
 * specs (`feel-test-lockstep`, `swarm-tidi`, `tidi-overlay`, etc.) read
 * these values via `textContent` and assume they're always queryable.
 *
 * This component renders the bare minimum — plain `<div>`s, no MUI, no
 * emotion CSS-in-JS, `display: none` so nothing paints. Each value is a
 * separate Zustand selector subscription so React only re-renders the
 * affected leaf when its slice changes.
 */
export function HudTestAttributes(): JSX.Element {
  return (
    <div data-testid="hud-test-attributes" style={{ display: 'none' }} aria-hidden>
      <ShipCount />
      <SwarmCount />
      <ClockRate />
      <ServerTickHz />
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
