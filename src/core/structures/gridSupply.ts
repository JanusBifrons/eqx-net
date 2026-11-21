/**
 * Supply / demand bookkeeping for a grid component (solid-doors plan, slice 5).
 * `Grid` keeps one tally per connected component: `rebuild` adds every built
 * member's output + consumption, `adjustDraw` (active power) moves demand and
 * the net together, so the two never disagree.
 *
 * `supplyFraction` is the share of the component's demand its generation
 * covers: 1 at or above break-even (with a Capital), supply/demand in deficit,
 * 0 with no Capital (an island is unpowered). `netPower` / `powered` are
 * unchanged by this; the fraction is an extra read for consumers that scale
 * with power (gate doors) instead of switching off.
 */

/** One component's power tally (`Grid`'s per-component info extends this). */
export interface PowerTally {
  /** Output minus consumption — the existing balance `powered` reads. */
  netPower: number;
  /** Total generation of the built members. */
  supply: number;
  /** Total current draw of the built members (active-power aware). */
  demand: number;
  hasCapital: boolean;
}

/** Add one built member's output and consumption to a tally (`rebuild`). */
export function addNodePower(t: PowerTally, output: number, consumption: number): void {
  t.supply += output;
  t.demand += consumption;
  t.netPower += output - consumption;
}

/** A member's draw changed by `delta` (positive = more draw): demand rises and
 *  the net falls by the same amount (`adjustDraw`). */
export function addDraw(t: PowerTally, delta: number): void {
  t.demand += delta;
  t.netPower -= delta;
}

/** The share of demand the component's generation covers, 0..1. */
export function supplyFraction(t: PowerTally): number {
  if (!t.hasCapital) return 0;
  if (t.netPower >= 0 || t.demand <= 0) return 1;
  return Math.min(1, Math.max(0, t.supply / t.demand));
}
