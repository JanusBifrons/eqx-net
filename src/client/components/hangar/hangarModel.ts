/**
 * Join flow stage 5 — the Hangar's pure model: which tabs, which tiles, and
 * what each tile's launch costs. The window (HangarWindow.tsx) only renders
 * this; every launch answer comes from the shared `launchVerdict`, the same
 * call the server's hull gate makes, so a tile never promises a launch the
 * server refuses.
 */
import { PLAYABLE_SHIP_KINDS_LIST, type ShipKind } from '../../../shared-types/shipKinds.js';
import { capitalClassAndFitOf, type CapitalFitName } from '../../../shared-types/shipKinds/capitals/index.js';
import { sizeClassOf, type SizeClass } from '../../../shared-types/shipScale/tuning.js';
import { launchVerdict, type LaunchVerdict } from '../../../shared-types/launch.js';

/** One Hangar tab: the size classes it shows. A new class tab (Fighters,
 *  Bombers, Transports) is one more row here. */
export interface HangarTab { id: string; label: string; classes: readonly SizeClass[] }

export const HANGAR_TABS: readonly HangarTab[] = [
  { id: 'subcap', label: 'Sub-capitals', classes: ['fighter', 'frigate', 'cruiser'] },
  { id: 'capital', label: 'Capitals', classes: ['capital'] },
];

/** One way to fly a tile's hull: the base kind or a fitted kind. */
export interface HangarFit { kind: string; fit: CapitalFitName }

/** One Hangar tile: a hull, with its fits folded in (first = base kind). */
export interface HangarTile { id: string; displayName: string; sizeClass: SizeClass; fits: readonly HangarFit[] }

/** Player-facing name of each fit (toggle labels). */
export const FIT_LABEL: Readonly<Record<CapitalFitName, string>> = {
  naval: 'Guns', rail: 'Railguns', lance: 'Lances', beam: 'Beams',
};

/** Every hull a pilot can fly: the playable list minus engineering-only test hulls. */
export function hangarKinds(): readonly ShipKind[] {
  return PLAYABLE_SHIP_KINDS_LIST.filter((k) => !k.engineeringOnly);
}

/** The tiles for one tab, in catalogue order, each capital class's fits
 *  folded into its base tile. */
export function hangarTiles(tab: HangarTab, kinds: readonly ShipKind[] = hangarKinds()): HangarTile[] {
  const tiles: HangarTile[] = [];
  const byClass = new Map<string, HangarTile>();
  for (const k of kinds) {
    const sc = sizeClassOf(k);
    if (!tab.classes.includes(sc)) continue;
    const cf = capitalClassAndFitOf(k.id);
    if (cf === null) {
      tiles.push({ id: k.id, displayName: k.displayName, sizeClass: sc, fits: [{ kind: k.id, fit: 'naval' }] });
      continue;
    }
    let tile = byClass.get(cf.classId);
    if (!tile) {
      const base = kinds.find((b) => b.id === cf.classId) ?? k;
      tile = { id: cf.classId, displayName: base.displayName, sizeClass: sc, fits: [] };
      byClass.set(cf.classId, tile);
      tiles.push(tile);
    }
    (tile.fits as HangarFit[]).push({ kind: k.id, fit: cf.fit });
  }
  for (const t of tiles) (t.fits as HangarFit[]).sort((a, b) => (a.kind === t.id ? -1 : b.kind === t.id ? 1 : 0));
  return tiles;
}

/** The pilot's purse and parked hulls, as the Hangar sees them. */
export interface HangarPurse {
  wallet: number;
  freeLaunches: number;
  /** Kinds the pilot owns parked in this sector (launch by resume). */
  ownedHere: ReadonlySet<string>;
  /** Defaults to LAUNCH_COSTS_ON; tests pass it. */
  costsOn?: boolean;
}

export function tileVerdict(kind: string, purse: HangarPurse): LaunchVerdict {
  return launchVerdict({
    kind, wallet: purse.wallet, freeLaunches: purse.freeLaunches,
    ownedHere: purse.ownedHere.has(kind),
    ...(purse.costsOn !== undefined ? { costsOn: purse.costsOn } : {}),
  });
}

/** "N ready" on a tab: tiles with at least one fit the pilot can launch now. */
export function tabReadyCount(tab: HangarTab, purse: HangarPurse, kinds?: readonly ShipKind[]): number {
  return hangarTiles(tab, kinds).filter((t) => t.fits.some((f) => tileVerdict(f.kind, purse).kind !== 'refuse')).length;
}

/** Footer line: what the launch costs and the balance after it. */
export function launchFooter(v: LaunchVerdict, wallet: number): { cost: string; after: number } {
  switch (v.kind) {
    case 'owned': return { cost: 'Your ship', after: wallet };
    case 'free': return { cost: 'Free', after: wallet };
    case 'token': return { cost: 'Free launch', after: wallet };
    case 'pay': case 'debt': return { cost: `${v.cost.toLocaleString('en-GB')} cr`, after: wallet - v.cost };
    case 'refuse': return { cost: v.reason === 'shipyard' ? 'Build at a Shipyard' : 'Can\'t afford', after: wallet };
  }
}
