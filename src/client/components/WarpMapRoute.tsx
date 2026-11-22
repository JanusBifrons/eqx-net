/**
 * The picked warp's route on the system map (`WarpPicker` map view), drawn
 * from the same `WarpDestination` record the Go button sends (`targetX/Y`):
 *  - clear: a dashed line from the ship to the drop point, a ring there;
 *  - near side: a SOLID amber line from the ship to the landing point (the
 *    near side of the field or structure in the way), a landing ring there,
 *    and the rest of the line on to the pocket's drop point dashed and dimmed
 *    (blocked: the warp never flies it).
 * A blocked (too close) pocket is never picked, so it never draws here.
 * Redrawn only when the picker's 4 Hz pose poll re-renders (not per frame).
 */
import type { WarpDestination } from './warpDestinations';

/** Theme colours the picker shares (the list's sub-labels use the same). */
export const NEAR_COLOUR = '#f0b44c', BLOCKED_COLOUR = '#ff7b7b';
const CLEAR_COLOUR = '#5ad7ff';

/** Map units: `h` is the map's half extent (`SOLAR_HALF_EXTENT`). */
export function WarpMapRoute({ sel, shipX, shipY, h }: {
  sel: WarpDestination; shipX: number; shipY: number; h: number;
}): JSX.Element {
  const w = h / 150, dash = `${h / 40} ${h / 60}`;
  if (sel.state !== 'near') {
    return (
      <g data-testid="warp-map-line" data-warp-state={sel.state} style={{ pointerEvents: 'none' }}>
        <line x1={shipX} y1={-shipY} x2={sel.targetX} y2={-sel.targetY} stroke={sel.state === 'clear' ? CLEAR_COLOUR : BLOCKED_COLOUR}
          strokeWidth={w} strokeDasharray={dash} />
        <circle cx={sel.targetX} cy={-sel.targetY} r={h / 40} fill="none" stroke="#ffffff" strokeWidth={w} />
      </g>
    );
  }
  return (
    <g data-testid="warp-map-line" data-warp-state={sel.state} style={{ pointerEvents: 'none' }}>
      <line x1={sel.targetX} y1={-sel.targetY} x2={sel.dropX} y2={-sel.dropY} stroke={NEAR_COLOUR} strokeWidth={w}
        strokeDasharray={dash} opacity={0.35} data-testid="warp-map-blocked" />
      <line x1={shipX} y1={-shipY} x2={sel.targetX} y2={-sel.targetY} stroke={NEAR_COLOUR} strokeWidth={w} data-testid="warp-map-solid" />
      <g data-testid="warp-map-landing" data-x={sel.targetX} data-y={sel.targetY}>
        <circle cx={sel.targetX} cy={-sel.targetY} r={h / 36} fill="none" stroke={NEAR_COLOUR} strokeWidth={w * 1.2} />
        <circle cx={sel.targetX} cy={-sel.targetY} r={h / 120} fill={NEAR_COLOUR} />
      </g>
    </g>
  );
}
