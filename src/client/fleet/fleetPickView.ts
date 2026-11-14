/**
 * What the fleet panel / strip show while a mode waits for a target on the
 * map (RTS slice 14b). Pure, from the discrete Zustand `fleetPick` only.
 */
import { WINGMAN_ROUTE_MAX, WINGMAN_ROUTE_MIN } from '@core/ai/wingman/types';

export type FleetPickKind = 'patrol' | 'escort' | 'retreat';

/** The modes whose button starts a map pick instead of sending at once. */
export function modeNeedsPick(mode: string): mode is FleetPickKind {
  return mode === 'patrol' || mode === 'escort' || mode === 'retreat';
}

/** Done is allowed: a patrol route with at least 2 points. */
export function canFinishFleetPick(pick: { kind: FleetPickKind; points: number } | null): boolean {
  return pick !== null && pick.kind === 'patrol' && pick.points >= WINGMAN_ROUTE_MIN;
}

/** The plain hint (mouse or touch wording). */
export function fleetPickHint(kind: FleetPickKind, points: number, touch: boolean): string {
  const click = touch ? 'Tap' : 'Click';
  switch (kind) {
    case 'patrol':
      if (points >= WINGMAN_ROUTE_MAX) return `That's the most points (${WINGMAN_ROUTE_MAX}). Press Done.`;
      if (points < WINGMAN_ROUTE_MIN) return `${click} points for the patrol route, then Done`;
      return `${points} points. ${click} to add more, or press Done`;
    case 'escort':
      return `${click} one of your other ships to escort`;
    case 'retreat':
      return `${click} where to retreat to`;
  }
}
