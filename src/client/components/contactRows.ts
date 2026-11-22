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
 * that aren't yours (swarm kind 2) and other players' ships, whether a pilot or
 * an AI pilot flies them (never one of your own).
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { factionDisplayName, type FactionId } from '@shared-types/factions';
import { parseOwner } from '@shared-types/relations';
import { allegianceOfKind, getShipKind } from '@shared-types/shipKinds';
import { getStructureKind } from '@shared-types/structureKinds';
import type { EntityKind } from '../render/entityVisuals';
import { farIconRelation } from '../render/relationToLocal';
import { acquiringPct } from '../hud/lockPct';
import { isOwnedByMe } from '../render/shipOwnership';
import { structureOwnerLabel } from './ownerLabel';

/** Coarse object type (the Type column / filter). */
export type ContactType = 'ship' | 'structure';
/** Stance to you (the Stance column / filter and the row text colour). */
export type ContactStance = 'hostile' | 'neutral' | 'friendly';

export const CONTACT_TYPE_LABEL: Readonly<Record<ContactType, string>> = { ship: 'Ship', structure: 'Structure' };
export const CONTACT_STANCE_LABEL: Readonly<Record<ContactStance, string>> = {
  hostile: 'Hostile', neutral: 'Neutral', friendly: 'Friendly',
};
/** Ascending stance order: hostiles first. */
export const CONTACT_STANCE_ORDER: readonly ContactStance[] = ['hostile', 'neutral', 'friendly'];

const UNKNOWN = 'Unknown';

/** A weapon group's fire reach (the server's `groupGeometry().reach`). */
export interface GroupReach {
  id: string;
  /** Weapon (fire) reach in u. Locks reach the ship's longest gun (`shipLockRange`); this marks only what the group can shoot. */
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
  /** Lock key (`s:<entityId>` / `p:<ship mirror key>`). Never shown. */
  key: string;
  /** Icon + colour family (`render/entityVisuals.ts`). */
  icon: EntityKind;
  name: string;
  type: ContactType;
  /** Whose it is: an NPC faction's name, a pilot's name, "you"-free (yours
   *  are never contacts), or "Unknown". Never an id. */
  faction: string;
  stance: ContactStance;
  /** Centre-to-centre, game units. */
  dist: number;
  /** Hostile to you (NPC aggro, a turret aiming at you, or locking you). */
  hostile: boolean;
  /** Inside the ACTIVE group's fire reach (centre distance). */
  inActiveReach: boolean;
  /** Inside any group's fire reach. */
  inAnyReach: boolean;
  /** The active group's lock on it, else the first other group's; null = none. */
  lock: ContactLock | null;
  /** The active group's own lock on it (what a tap cancels). */
  activeLock: ContactLock | null;
  /** It is locking you: 0 no, 1 acquiring, 2 locked. */
  lockingYou: 0 | 1 | 2;
}

/** Rows per page in the panel's table. */
export const CONTACTS_PAGE_SIZE = 8;

/**
 * Stance from the ONE relationship rule the radar and far-zoom icons use
 * (`farIconRelation`): anything hostile to you (aggro, aiming at you or
 * locking you) is hostile first, so a pilot locking you never reads as
 * friendly; other pilots and their buildings are friendly; the rest neutral
 * (a trade hauler included).
 */
export function contactStance(hostile: boolean, isPlayerSide: boolean, shipKind: string | undefined): ContactStance {
  const rel = farIconRelation(false, isPlayerSide, hostile, shipKind);
  if (hostile || rel === 'hostile') return 'hostile';
  return rel === 'friendly' || rel === 'self' ? 'friendly' : 'neutral';
}

function factionName(id: string | undefined): string | undefined {
  return id === undefined ? undefined : factionDisplayName(id as FactionId);
}

/** A structure's owner for the Faction column (`parseOwner` decides who). */
function structureFaction(owner: string | undefined, ownerName: string | undefined, localId: string): { faction: string; player: boolean } {
  if (owner === undefined) return { faction: UNKNOWN, player: false };
  const ref = parseOwner(owner);
  if (ref.kind === 'npc') return { faction: factionName(ref.faction) ?? ownerName ?? UNKNOWN, player: false };
  if (ref.kind === 'none') return { faction: ownerName ?? UNKNOWN, player: false };
  return { faction: structureOwnerLabel(owner, ownerName, localId), player: true };
}

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
  let activeReach = 0;
  let anyReach = 0;
  for (const g of reaches) {
    const r = g.reach;
    if (g.id === activeGroupId) activeReach = r;
    if (r > anyReach) anyReach = r;
  }

  const lockedBy = new Map<string, number>();
  for (const l of mirror.localLockedBy ?? []) {
    if (l.s > (lockedBy.get(l.t) ?? 0)) lockedBy.set(l.t, l.s);
  }

  const rows: ContactRow[] = [];
  const add = (
    key: string, icon: EntityKind, name: string, type: ContactType, faction: string,
    playerSide: boolean, shipKind: string | undefined, x: number, y: number, hostileHint: boolean,
  ): void => {
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
    const hostile = hostileHint || lockingYou > 0;
    rows.push({
      key, icon, name, type, faction, stance: contactStance(hostile, playerSide, shipKind), dist,
      hostile,
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
      // A patrol flies for its faction, else its kind's allegiance (as its livery reads).
      const faction = factionName(e.faction ?? allegianceOfKind(e.shipKind)) ?? UNKNOWN;
      add(`s:${id}`, hostile ? 'hostile' : 'neutral', name, 'ship', faction, false, e.shipKind, e.x, e.y, hostile);
    } else if (e.kind === 2) {
      const st = mirror.structures?.get(id);
      if (st?.owner !== undefined && st.owner === localId) return; // your own: not lockable
      const name = e.shipKind ? getStructureKind(e.shipKind).displayName : 'Structure';
      const who = structureFaction(st?.owner, st?.ownerName, localId);
      add(`s:${id}`, 'structure', name, 'structure', who.faction, who.player, undefined, e.x, e.y,
        st?.turretTargetPlayerId === localId);
    }
  });
  mirror.ships.forEach((s, key) => {
    // Every other player's ship, pilot- or AI-flown (the mirror key is the
    // lock key the server resolves); never the ship you fly or your fleet.
    // Named by its hull; the pilot (`displayName`, the server's owner label) is its faction.
    if (isOwnedByMe(mirror, key, s)) return;
    const name = s.kind ? getShipKind(s.kind).displayName : 'Ship';
    add(`p:${key}`, 'ship', name, 'ship', s.displayName || UNKNOWN, true, s.kind, s.x, s.y, false);
  });
  return rows;
}

/** A sortable column. */
export type ContactSortKey = 'name' | 'lock' | 'type' | 'faction' | 'stance' | 'dist';
export type ContactSortDir = 'asc' | 'desc';
/** Primary key first, then the secondary (the previously tapped column). */
export type ContactSort = ReadonlyArray<{ readonly key: ContactSortKey; readonly dir: ContactSortDir }>;

export const DEFAULT_CONTACT_SORT: ContactSort = [{ key: 'dist', dir: 'asc' }];

/** A header tap: the primary column flips direction; any other column becomes
 *  the primary (ascending) and the old primary its secondary, so you can
 *  cross-sort (tap Distance, then Stance = by stance, nearest first). */
export function tapContactSort(sort: ContactSort, key: ContactSortKey): ContactSort {
  const primary = sort[0];
  if (primary === undefined) return [{ key, dir: 'asc' }];
  if (primary.key === key) return [{ key, dir: primary.dir === 'asc' ? 'desc' : 'asc' }, ...sort.slice(1)];
  return [{ key, dir: 'asc' }, primary];
}

/** Lock column rank: your lock (locked over acquiring) first, then how hard it is locking you. */
function lockRank(r: ContactRow): number {
  return (r.lock === null ? 0 : r.lock.stage === 2 ? 2 : 1) * 3 + r.lockingYou;
}

function compareBy(key: ContactSortKey, a: ContactRow, b: ContactRow): number {
  switch (key) {
    case 'dist': return a.dist - b.dist;
    case 'stance': return CONTACT_STANCE_ORDER.indexOf(a.stance) - CONTACT_STANCE_ORDER.indexOf(b.stance);
    case 'type': return CONTACT_TYPE_LABEL[a.type].localeCompare(CONTACT_TYPE_LABEL[b.type]);
    case 'faction': return a.faction.localeCompare(b.faction);
    case 'name': return a.name.localeCompare(b.name);
    case 'lock': return lockRank(b) - lockRank(a);
  }
}

/** Pure: sort in place by the sort keys in order, ties by distance then the
 *  lock key, so the order never jitters between polls. No cap: the panel pages. */
export function sortContacts(rows: ContactRow[], sort: ContactSort): ContactRow[] {
  rows.sort((a, b) => {
    for (const s of sort) {
      const c = compareBy(s.key, a, b);
      if (c !== 0) return s.dir === 'asc' ? c : -c;
    }
    const d = a.dist - b.dist;
    if (d !== 0) return d;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return rows;
}

/** The table's filters; null = all. */
export interface ContactFilter {
  readonly type: ContactType | null;
  readonly faction: string | null;
  readonly stance: ContactStance | null;
}

export const NO_CONTACT_FILTER: ContactFilter = { type: null, faction: null, stance: null };

/** Pure: the rows passing every set filter (a new array). */
export function filterContacts(rows: ReadonlyArray<ContactRow>, f: ContactFilter): ContactRow[] {
  return rows.filter((r) => (f.type === null || r.type === f.type)
    && (f.faction === null || r.faction === f.faction)
    && (f.stance === null || r.stance === f.stance));
}

/** The distinct factions present, sorted (the Faction filter's options). */
export function contactFactions(rows: ReadonlyArray<ContactRow>): string[] {
  return [...new Set(rows.map((r) => r.faction))].sort((a, b) => a.localeCompare(b));
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
    s += `${r.key}|${r.name}|${r.type}|${r.faction}|${r.stance}|${formatContactKm(r.dist)}|${r.hostile ? 1 : 0}${r.inActiveReach ? 1 : 0}${r.inAnyReach ? 1 : 0}|`
      + `${r.lock ? `${r.lock.groupId}:${r.lock.stage}:${r.lock.pct}` : '-'}|${r.activeLock ? 1 : 0}|${r.lockingYou};`;
  }
  return s;
}
