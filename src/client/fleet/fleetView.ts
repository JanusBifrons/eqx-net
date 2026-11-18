/**
 * Pure view helpers for the fleet panel / strip (RTS command layer, slice 14):
 * plain-language activity lines, the shared-or-mixed value of a selection,
 * and names for ships and targets read from the render mirror (no ids shown).
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { FleetMode, FleetStance } from '@shared-types/messages/fleetStatusMessages';
import { getShipKind } from '@shared-types/shipKinds';
import type { FleetStatusRow } from './fleetStatus.js';

export const MODE_LABELS: Record<FleetMode, string> = {
  patrol: 'Patrol',
  defend: 'Defend',
  hunt: 'Hunt',
  escort: 'Escort',
  retreat: 'Retreat',
};

export const STANCE_LABELS: Record<FleetStance, string> = {
  aggressive: 'Aggressive',
  defensive: 'Defensive',
  holdFire: 'Hold fire',
};

/** What a ship is doing, in plain words ("Chasing Drone", "Retreating – hull 20%"). */
export function describeActivity(row: FleetStatusRow | undefined, targetName?: string, hullPct: number | null = null): string {
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
      return describeRetreat(row, hullPct);
    case 'formingUp':
      return 'Forming up';
    case 'guarding':
      return `Guarding${t}`;
    case 'searching':
      return 'Searching';
    case 'blocked':
      return "Can't get closer";
  }
}

/**
 * Why a ship is pulling out, in plain words: the hull it has lost, or
 * "shields down" while its hull is still whole. An ordered retreat just says
 * "Retreating". Hull comes from the mirror ship entry (RTS Part A: the
 * status stream no longer carries hull or morale); unknown ⇒ no reason given.
 */
function describeRetreat(row: FleetStatusRow, hullPct: number | null): string {
  if (row.mode === 'retreat' || hullPct === null) return 'Retreating';
  const hull = Math.round(hullPct);
  const why = hull >= 100 && row.shieldPct !== undefined && row.shieldPct <= 0
    ? 'shields down'
    : `hull ${hull}%`;
  return `Retreating – ${why}`;
}

/** Shield and hull in plain words: "Shield 40% · Hull 100%" ("Hull 100%"
 *  when the shield is not reported). */
export function describeShieldHull(shieldPct: number | null | undefined, hullPct: number | null | undefined): string {
  const hull = hullPct === null || hullPct === undefined ? '--' : `${Math.round(hullPct)}%`;
  if (shieldPct === null || shieldPct === undefined) return `Hull ${hull}`;
  return `Shield ${Math.round(shieldPct)}% · Hull ${hull}`;
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
  const s = mirror.ships.get(id);
  return kindName(s?.kind) ?? 'Ship';
}

/**
 * A player-facing name for a target id: a ship's kind, a drone's kind (or
 * "Drone"), "Structure", "Asteroid". Undefined when it can't be resolved.
 * Accepts a playerId / shipInstanceId, a numeric entity id or `swarm-<id>`.
 */
export function fleetTargetName(mirror: RenderMirror | null | undefined, id: string | null): string | undefined {
  if (!mirror || !id) return undefined;
  const s = mirror.ships.get(id);
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
