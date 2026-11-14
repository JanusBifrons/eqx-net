/**
 * Pure view helpers for the fleet panel / strip (RTS command layer, slice 14):
 * plain-language activity lines, the shared-or-mixed value of a selection,
 * and names for ships and targets read from the render mirror (no ids shown).
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { WingmanMode, WingmanStance } from '@core/ai/wingman/types';
import { getShipKind } from '@shared-types/shipKinds';
import type { FleetStatusRow } from './fleetStatus.js';

export const MODE_LABELS: Record<WingmanMode, string> = {
  patrol: 'Patrol',
  defend: 'Defend',
  hunt: 'Hunt',
  escort: 'Escort',
  retreat: 'Retreat',
};

export const STANCE_LABELS: Record<WingmanStance, string> = {
  aggressive: 'Aggressive',
  defensive: 'Defensive',
  holdFire: 'Hold fire',
};

/** What a ship is doing, in plain words ("Chasing Drone", "Retreating – hull 20%"). */
export function describeActivity(row: FleetStatusRow | undefined, targetName?: string): string {
  if (!row) return 'No report yet';
  const t = targetName ? ` ${targetName}` : '';
  switch (row.activity) {
    case 'idle':
      return 'Idle';
    case 'moving':
      return 'Moving';
    case 'patrolling':
      return 'Patrolling';
    case 'chasing':
      return `Chasing${t}`;
    case 'attacking':
      return `Attacking${t}`;
    case 'retreating':
      return `Retreating – hull ${Math.round(row.hullPct)}%`;
    case 'formingUp':
      return 'Forming up';
    case 'guarding':
      return `Guarding${t}`;
  }
}

/** The one value every item shares; `'mixed'` when they differ; null when none known. */
export function sharedValue<T>(values: readonly (T | undefined)[]): T | 'mixed' | null {
  let seen: T | undefined;
  let any = false;
  for (const v of values) {
    if (v === undefined) continue;
    if (!any) {
      seen = v;
      any = true;
    } else if (v !== seen) {
      return 'mixed';
    }
  }
  return any ? (seen as T) : null;
}

function kindName(kind: string | undefined): string | undefined {
  return kind ? getShipKind(kind)?.displayName : undefined;
}

/** A player-facing name for one of your own ships: its kind ("Fighter"). */
export function fleetShipName(mirror: RenderMirror | null | undefined, id: string): string {
  if (!mirror) return 'Ship';
  const s = mirror.ships.get(id) ?? mirror.lingeringShips?.get(id);
  return kindName(s?.kind) ?? 'Ship';
}

/**
 * A player-facing name for a target id: a ship's kind, a drone's kind (or
 * "Drone"), "Structure", "Asteroid". Undefined when it can't be resolved.
 * Accepts a playerId / shipInstanceId, a numeric entity id or `swarm-<id>`.
 */
export function fleetTargetName(mirror: RenderMirror | null | undefined, id: string | null): string | undefined {
  if (!mirror || !id) return undefined;
  const s = mirror.ships.get(id) ?? mirror.lingeringShips?.get(id);
  if (s) return kindName(s.kind) ?? 'Ship';
  const n = Number(id.startsWith('swarm-') ? id.slice(6) : id);
  if (!Number.isInteger(n)) return undefined;
  const e = mirror.swarm?.get(n);
  if (!e) return undefined;
  switch (e.kind) {
    case 0:
      return 'Asteroid';
    case 2:
      return 'Structure';
    default:
      return kindName(e.shipKind) ?? 'Drone';
  }
}
