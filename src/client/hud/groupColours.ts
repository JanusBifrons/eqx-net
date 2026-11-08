/**
 * Weapon-group colours (exp/fire-control). One palette shared by the HUD
 * weapon strip and the in-world lock brackets / firing lines, so a group's
 * chip and the target it is shooting are visibly the same colour. Indexed by
 * the slot's `colour` (or its order). No React — the worker renderer imports it.
 */
export const GROUP_COLOURS_HEX: readonly string[] = [
  '#34d8ff', // cyan
  '#ff8c3a', // orange
  '#c08bff', // violet
  '#7dffb2', // mint
  '#ffd76a', // gold
  '#ff5a8a', // pink
  '#5ab0ff', // blue
  '#e6ecf5', // white
];

export const GROUP_COLOURS: readonly number[] = GROUP_COLOURS_HEX.map((h) => parseInt(h.slice(1), 16));

export function groupColourHex(i: number): string {
  return GROUP_COLOURS_HEX[((i % GROUP_COLOURS_HEX.length) + GROUP_COLOURS_HEX.length) % GROUP_COLOURS_HEX.length]!;
}

export function groupColour(i: number): number {
  return GROUP_COLOURS[((i % GROUP_COLOURS.length) + GROUP_COLOURS.length) % GROUP_COLOURS.length]!;
}

/** Failsafe ring (non-hostile target, before the hostile act). */
export const FAILSAFE_COLOUR = 0xffd23d;
/** Acquiring ring (hostile, locking). */
export const ACQUIRE_COLOUR = 0xff4d5a;
