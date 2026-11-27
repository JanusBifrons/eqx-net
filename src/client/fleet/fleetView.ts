/**
 * Pure view helpers for the fleet panel / strip (RTS command layer, slice 14):
 * plain-language activity lines, the shared-or-mixed value of a selection,
 * and names for ships and targets read from the render mirror (no ids shown).
 */
import type { RenderMirror, SwarmRenderState } from '@core/contracts/IRenderer';
import type { FleetMode, FleetStance } from '@shared-types/messages/fleetStatusMessages';
import { getShipKind } from '@shared-types/shipKinds';
import { SIZE_CLASSES, sizeClassOf } from '@shared-types/shipScale/tuning';
import type { IFleetView } from '@core/contracts/render/IFleetView';
import { shipHullPct } from '../net/shipSchemaHealth.js';
import { wreckSourceKindOf } from '../net/wreckRootSource';
import { SWARM_KIND_ASTEROID, SWARM_KIND_SCRAP, SWARM_KIND_STRUCTURE, SWARM_KIND_WRECK, isLootPod } from '@shared-types/swarmWireFormat';
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

/** What a ship is doing, in plain words ("Chasing Drone", "Retreating – hull 20%").
 *  A hull on a salvage order reads "Salvaging" while it travels to and works
 *  the piece; a retreat still says why it is pulling out. */
export function describeActivity(row: FleetStatusRow | undefined, targetName?: string, hullPct: number | null = null): string {
  if (!row) return 'No report yet';
  if (row.orderKind === 'salvage' && row.activity !== 'retreating') return 'Salvaging';
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
 * "Drone"), or a non-ship piece by `swarmEntityName`. Undefined when it can't be resolved.
 * Accepts a playerId / shipInstanceId, a numeric entity id or `swarm-<id>`.
 */
export function fleetTargetName(mirror: RenderMirror | null | undefined, id: string | null): string | undefined {
  if (!mirror || !id) return undefined;
  const s = mirror.ships.get(id);
  if (s) return kindName(s.kind) ?? 'Ship';
  const n = Number(id.startsWith('swarm-') ? id.slice(6) : id);
  if (!Number.isInteger(n)) return undefined;
  const e = mirror.swarm?.get(n);
  return e ? swarmEntityName(mirror, e) : undefined;
}

/** A wreck piece's name by its source (`wreckSourceKindOf` of its
 *  descriptor's parent kind): a rock's piece is 'Rock'; a ship's or a
 *  structure's (or an unknown one) 'Wreck'. */
export function wreckPieceName(parentKind: string | undefined): string {
  return parentKind !== undefined && wreckSourceKindOf(parentKind) === 'rock' ? 'Rock' : 'Wreck';
}

/**
 * A player-facing name for a swarm entity, by its swarm kind first: only a
 * drone is named after its ship kind. A scrap or wreck piece's `shipKind` is
 * its PARENT (junk for a rock cut), never what the piece is.
 */
export function swarmEntityName(mirror: RenderMirror, e: SwarmRenderState, droneFallback = 'Drone'): string {
  switch (e.kind) {
    case SWARM_KIND_ASTEROID:
      return 'Asteroid';
    case SWARM_KIND_STRUCTURE:
      return 'Structure';
    case SWARM_KIND_SCRAP:
      return isLootPod(e) ? 'Cargo pod' : 'Scrap';
    case SWARM_KIND_WRECK:
      return wreckPieceName(e.wreckId !== undefined ? mirror.wrecks?.get(e.wreckId)?.parentKind : undefined);
    default:
      return kindName(e.shipKind) ?? droneFallback;
  }
}

/** One ship type in the selection (selection HUD S5a): the left side shows
 *  one hex per group with its count ("Battleship ×2"). */
export interface KindGroup {
  /** Ship kind id; `''` for ships whose kind the mirror does not know yet. */
  kind: string;
  displayName: string;
  icon?: string;
  ids: string[];
  count: number;
  /** Mean hull 0..1 over the ships whose hull is known; null when none is. */
  avgHullFrac: number | null;
}

/** Biggest size class first (capital → fighter); unknown kinds last. */
function classRank(kind: string): number {
  if (!kind) return SIZE_CLASSES.length;
  return SIZE_CLASSES.length - 1 - SIZE_CLASSES.indexOf(sizeClassOf(getShipKind(kind)));
}

/**
 * Group selected ids by ship kind. Order: largest size class first, then
 * count (desc), then name; ids keep their selection order inside a group.
 * `kindOf` / `hullFracOf` read the ship (see {@link groupMirrorSelection}).
 */
export function groupSelectionByKind(
  ids: readonly string[],
  kindOf: (id: string) => string | undefined,
  hullFracOf: (id: string) => number | null = () => null,
): KindGroup[] {
  const byKind = new Map<string, { ids: string[]; hullSum: number; hullN: number }>();
  for (const id of ids) {
    const kind = kindOf(id) ?? '';
    let g = byKind.get(kind);
    if (!g) {
      g = { ids: [], hullSum: 0, hullN: 0 };
      byKind.set(kind, g);
    }
    g.ids.push(id);
    const h = hullFracOf(id);
    if (h !== null) {
      g.hullSum += h;
      g.hullN++;
    }
  }
  const groups: KindGroup[] = [];
  for (const [kind, g] of byKind) {
    groups.push({
      kind,
      displayName: kindName(kind) ?? 'Ship',
      ids: g.ids,
      count: g.ids.length,
      avgHullFrac: g.hullN > 0 ? g.hullSum / g.hullN : null,
    });
  }
  return groups.sort(
    (a, b) =>
      classRank(a.kind) - classRank(b.kind) ||
      b.count - a.count ||
      a.displayName.localeCompare(b.displayName) ||
      a.kind.localeCompare(b.kind),
  );
}

/** {@link groupSelectionByKind} reading kind and hull from the render mirror
 *  (low cadence only, like every `getGameClient()` mirror read). */
export function groupMirrorSelection(mirror: RenderMirror | null | undefined, ids: readonly string[]): KindGroup[] {
  return groupSelectionByKind(
    ids,
    (id) => mirror?.ships.get(id)?.kind,
    (id) => {
      const pct = shipHullPct(mirror?.ships.get(id));
      return pct === null ? null : pct / 100;
    },
  );
}

/** Fit the groups into `max` slots: with more than `max` groups the last slot
 *  becomes a "?" overflow holding every remaining kind and its ship count. */
export function capKindGroups(
  groups: readonly KindGroup[],
  max = 5,
): { shown: KindGroup[]; overflowKinds: KindGroup[]; overflowCount: number } {
  if (groups.length <= max) return { shown: groups.slice(), overflowKinds: [], overflowCount: 0 };
  const keep = Math.max(0, max - 1);
  const overflowKinds = groups.slice(keep);
  return { shown: groups.slice(0, keep), overflowKinds, overflowCount: overflowKinds.reduce((n, g) => n + g.count, 0) };
}

/** Tap on a type hex: keep only that type's ships selected, through the one
 *  selection the renderer owns (`IFleetView.selectFleetShips`). */
export function keepOnlyKind(view: Pick<IFleetView, 'selectFleetShips'>, group: Pick<KindGroup, 'ids'>): void {
  view.selectFleetShips(group.ids);
}
