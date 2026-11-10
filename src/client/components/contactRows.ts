/**
 * Contacts overview (EVE-style list for locking far targets): pure row
 * building from the render mirror. With real-scale gun ranges (a 16" reaches
 * 38.7 km) a fighter is ~1.6 px at the zoom needed to see it, so the honest
 * way to pick a far target is a list, like the warp picker's.
 *
 * Called a few times a second while the panel is open (4 Hz, the sanctioned
 * low-cadence mirror read; never per frame, never Zustand: invariant #2), so
 * allocation here is fine. Names come from the kind, callsign or owner
 * display name, never an id (ids stay in the lock KEY, which is not shown).
 *
 * Lockable = what the lock line considers (`ColyseusClient._lgVisitSwarm` /
 * `_lgVisitShip`): NPC ships (drones and capitals, swarm kind 1), structures
 * that aren't yours (swarm kind 2) and other pilots' ships.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { getStructureKind } from '@shared-types/structureKinds';
import { LOCK_TUNING } from '@shared-types/combat/lockProfile';
import type { EntityKind } from '../render/entityVisuals';
import { acquiringPct } from '../hud/lockPct';

/** A weapon group's lock reach basis (the server's `groupGeometry().reach`). */
export interface GroupReach {
  id: string;
  /** Weapon reach in u; the lock reaches `reach × LOCK_TUNING.reachSlack`. */
  reach: number;
}

export interface ContactLock {
  groupId: string;
  /** 0 failsafe, 1 acquiring, 2 locked (the wire stage). */
  stage: number;
  /** Shown percent: acquiring capped at 99 (`acquiringPct`), locked 100. */
  pct: number;
}

export interface ContactRow {
  /** Lock key (`s:<entityId>` / `p:<playerId>`). Never shown. */
  key: string;
  /** Icon + colour family (`render/entityVisuals.ts`). */
  icon: EntityKind;
  name: string;
  /** Centre-to-centre, game units. */
  dist: number;
  /** Hostile to you (NPC aggro, a turret aiming at you, or locking you). */
  hostile: boolean;
  /** Inside the ACTIVE group's lock reach. */
  inActiveReach: boolean;
  /** Inside any group's lock reach. */
  inAnyReach: boolean;
  /** The active group's lock on it, else the first other group's; null = none. */
  lock: ContactLock | null;
  /** The active group's own lock on it (what a tap cancels). */
  activeLock: ContactLock | null;
  /** It is locking you: 0 no, 1 acquiring, 2 locked. */
  lockingYou: 0 | 1 | 2;
}

/** Most rows the panel lists (nearest after sorting). */
export const CONTACTS_MAX_ROWS = 40;

/** "450 m", "3.2 km", "38 km" (1 km = 1,000 u). Below 10 km keeps a decimal:
 *  combat ranges are mostly a few km, and "<1 km" (the warp picker's
 *  `formatKm`) would hide every gun's reach. */
export function formatContactKm(dist: number): string {
  if (!(dist >= 0)) return '—';
  if (dist < 1000) return `${Math.round(dist / 10) * 10} m`;
  const km = dist / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function lockOf(groupId: string, l: { s: number; p: number }): ContactLock {
  return { groupId, stage: l.s, pct: l.s === 2 ? 100 : acquiringPct(l.p) };
}

/**
 * Pure: the lockable contacts around the local ship, unsorted. Empty when
 * there's no local ship in the mirror.
 */
export function buildContactRows(
  mirror: RenderMirror,
  activeGroupId: string | null,
  reaches: ReadonlyArray<GroupReach>,
): ContactRow[] {
  const localId = mirror.localPlayerId;
  const me = localId ? mirror.ships.get(localId) : undefined;
  if (!localId || !me) return [];
  const slack = LOCK_TUNING.reachSlack;
  let activeReach = 0;
  let anyReach = 0;
  for (const g of reaches) {
    const r = g.reach * slack;
    if (g.id === activeGroupId) activeReach = r;
    if (r > anyReach) anyReach = r;
  }

  const lockedBy = new Map<string, number>();
  for (const l of mirror.localLockedBy ?? []) {
    if (l.s > (lockedBy.get(l.t) ?? 0)) lockedBy.set(l.t, l.s);
  }

  const rows: ContactRow[] = [];
  const add = (key: string, icon: EntityKind, name: string, x: number, y: number, hostileHint: boolean): void => {
    const dist = Math.hypot(x - me.x, y - me.y);
    let lock: ContactLock | null = null;
    let activeLock: ContactLock | null = null;
    for (const g of mirror.localGroups ?? []) {
      for (const l of g.l) {
        if (l.t !== key) continue;
        const cl = lockOf(g.id, l);
        if (g.id === activeGroupId) activeLock = cl;
        else if (lock === null) lock = cl;
      }
    }
    const by = lockedBy.get(key) ?? 0;
    const lockingYou: 0 | 1 | 2 = by >= 2 ? 2 : by >= 1 ? 1 : 0;
    rows.push({
      key, icon, name, dist,
      hostile: hostileHint || lockingYou > 0,
      inActiveReach: activeReach > 0 && dist <= activeReach,
      inAnyReach: anyReach > 0 && dist <= anyReach,
      lock: activeLock ?? lock,
      activeLock,
      lockingYou,
    });
  };

  mirror.swarm?.forEach((e, id) => {
    if (e.kind === 1) {
      if (e.warp === 2) return; // mid warp run: out of the world
      const hostile = e.isHostileToLocal === true;
      const name = e.eliteName ?? (e.shipKind ? getShipKind(e.shipKind).displayName : 'Ship');
      add(`s:${id}`, hostile ? 'hostile' : 'neutral', name, e.x, e.y, hostile);
    } else if (e.kind === 2) {
      const st = mirror.structures?.get(id);
      if (st?.owner !== undefined && st.owner === localId) return; // your own: not lockable
      const kindName = e.shipKind ? getStructureKind(e.shipKind).displayName : 'Structure';
      const name = st?.ownerName ? `${kindName} · ${st.ownerName}` : kindName;
      add(`s:${id}`, 'structure', name, e.x, e.y, st?.turretTargetPlayerId === localId);
    }
  });
  mirror.ships.forEach((s, pid) => {
    if (pid === localId) return;
    const name = s.displayName ?? (s.kind ? getShipKind(s.kind).displayName : 'Pilot');
    add(`p:${pid}`, 'ship', name, s.x, s.y, false);
  });
  return rows;
}

/** Pure: sort by distance (nearest first); with `hostilesFirst`, every hostile
 *  row before every other, each part by distance. Sorts in place and returns
 *  the first `CONTACTS_MAX_ROWS`. */
export function sortContacts(rows: ContactRow[], hostilesFirst: boolean): ContactRow[] {
  rows.sort((a, b) => {
    if (hostilesFirst && a.hostile !== b.hostile) return a.hostile ? -1 : 1;
    return a.dist - b.dist;
  });
  return rows.length > CONTACTS_MAX_ROWS ? rows.slice(0, CONTACTS_MAX_ROWS) : rows;
}

/** What a tap on a row does: cancel the active group's lock on it (acquiring
 *  or locked, like the info box's CANCEL / UNLOCK), else request one. */
export function contactTapAction(row: ContactRow): 'lock' | 'cancel' {
  return row.activeLock !== null ? 'cancel' : 'lock';
}

/** A short signature of what the panel shows, so the 4 Hz poll re-renders only
 *  when something visible changed (distance at the shown precision). */
export function contactsSignature(rows: ReadonlyArray<ContactRow>): string {
  let s = '';
  for (const r of rows) {
    s += `${r.key}|${r.name}|${formatContactKm(r.dist)}|${r.hostile ? 1 : 0}${r.inActiveReach ? 1 : 0}${r.inAnyReach ? 1 : 0}|`
      + `${r.lock ? `${r.lock.groupId}:${r.lock.stage}:${r.lock.pct}` : '-'}|${r.activeLock ? 1 : 0}|${r.lockingYou};`;
  }
  return s;
}
