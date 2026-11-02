/**
 * NPC transit hubs (plan soft-leaping-truffle v4, phase H): the galaxy's
 * teleporter network. Pure and deterministic, so every room agrees on it.
 *
 * Each region has one hub, a `transit` base in one of its chokepoint sectors
 * (the core's hub sits in its first chokepoint by key). A hub's teleporters
 * are pre-paired with teleporters at other bases:
 *  - the region heart's main base (unless the hub IS in the heart),
 *  - up to two trade bases in the region, nearest first,
 *  - the backbone: every frontier hub links to the core hub.
 * Each link names its two ends (sector + base id). Both ends' bases grow a
 * teleporter tagged with the link id, and the two find each other at run time
 * by that id (the server's `findLinkTwin`).
 *
 * Built from the per-sector plans (`sectorBasePlan`) WITHOUT the links, so
 * there is no loop: the network depends on which bases trade, then each
 * sector's final plan adds its hub and its links.
 */
import { GALAXY_SECTORS, getSector } from '../galaxy/galaxy.js';
import { regionHeart } from '../galaxy/control.js';
import type { GalaxyBasePlan } from './galaxyBases.js';

/** The base id of a sector's transit hub. */
export const TRANSIT_HUB_BASE_ID = 'hub';
/** How many trade bases a hub links to (nearest first). */
export const HUB_TRADE_LINKS = 2;

export interface LinkEnd {
  sector: string;
  baseId: string;
}

export interface TransitLink {
  /** Stable id, the same at both ends. */
  id: string;
  a: LinkEnd;
  b: LinkEnd;
}

export interface TransitNetwork {
  /** Hub sector per region id. */
  hubs: ReadonlyMap<string, string>;
  links: readonly TransitLink[];
}

/** A sector one of whose neighbours is in another region. */
function isChokepoint(key: string): boolean {
  const s = getSector(key);
  return s !== undefined && s.neighbours.some((n) => getSector(n)?.region !== s.region);
}

/** Hops between two sectors inside one region (Infinity if not connected). */
function regionHops(from: string, to: string): number {
  const region = getSector(from)?.region;
  if (region === undefined) return Infinity;
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length > 0) {
    const k = queue.shift()!;
    if (k === to) return dist.get(k)!;
    for (const n of getSector(k)!.neighbours) {
      if (getSector(n)?.region !== region || dist.has(n)) continue;
      dist.set(n, dist.get(k)! + 1);
      queue.push(n);
    }
  }
  return Infinity;
}

export function linkId(a: LinkEnd, b: LinkEnd): string {
  const ka = `${a.sector}/${a.baseId}`;
  const kb = `${b.sector}/${b.baseId}`;
  return ka < kb ? `${ka}~${kb}` : `${kb}~${ka}`;
}

/** The far end of a link, seen from `here` (null if `here` isn't an end). */
export function otherEnd(link: TransitLink, here: LinkEnd): LinkEnd | null {
  if (link.a.sector === here.sector && link.a.baseId === here.baseId) return link.b;
  if (link.b.sector === here.sector && link.b.baseId === here.baseId) return link.a;
  return null;
}

/** Parse a link id back into its two ends. */
export function linkEnds(id: string): [LinkEnd, LinkEnd] | null {
  const parts = id.split('~');
  if (parts.length !== 2) return null;
  const ends = parts.map((p) => {
    const i = p.lastIndexOf('/');
    return { sector: p.slice(0, i), baseId: p.slice(i + 1) };
  });
  return [ends[0]!, ends[1]!];
}

/**
 * Build the network from each sector's plan (without links). `plans` is the
 * per-sector base plan function, injected so this module stays free of a
 * circular import.
 */
export function buildTransitNetwork(plans: (sectorKey: string) => GalaxyBasePlan[]): TransitNetwork {
  const regions = new Map<string, string[]>();
  for (const s of GALAXY_SECTORS) {
    const list = regions.get(s.region) ?? [];
    list.push(s.key);
    regions.set(s.region, list);
  }
  const hubs = new Map<string, string>();
  for (const [region, keys] of [...regions].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const choke = keys.filter(isChokepoint).sort();
    hubs.set(region, choke[0] ?? [...keys].sort()[0]!);
  }
  const core = GALAXY_SECTORS.find((s) => s.region === 'core')?.region ?? null;
  const links: TransitLink[] = [];
  const add = (a: LinkEnd, b: LinkEnd): void => {
    if (a.sector === b.sector) return;
    const id = linkId(a, b);
    if (!links.some((l) => l.id === id)) links.push({ id, a, b });
  };
  for (const [region, hubSector] of [...hubs].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const hub: LinkEnd = { sector: hubSector, baseId: TRANSIT_HUB_BASE_ID };
    // The region heart's main base.
    add(hub, { sector: regionHeart(region), baseId: 'b0' });
    // Trade bases in the region, nearest first.
    const trades: Array<{ end: LinkEnd; hops: number }> = [];
    for (const key of regions.get(region) ?? []) {
      for (const p of plans(key)) {
        if (p.profile.role === 'trade') trades.push({ end: { sector: key, baseId: p.baseId }, hops: regionHops(hubSector, key) });
      }
    }
    trades.sort((x, y) => x.hops - y.hops || (x.end.sector < y.end.sector ? -1 : 1));
    for (const t of trades.slice(0, HUB_TRADE_LINKS)) add(hub, t.end);
    // The backbone.
    if (core !== null && region !== core) add(hub, { sector: hubs.get(core)!, baseId: TRANSIT_HUB_BASE_ID });
  }
  return { hubs, links };
}
