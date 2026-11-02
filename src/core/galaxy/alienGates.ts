/**
 * Alien gates (plan soft-leaping-truffle v4, phase A): where the Ancients'
 * border gates sit. Pure and deterministic, so every room (and every test)
 * agrees on the sites without sharing state.
 *
 * Each sector has one gate on every edge that faces a neighbour, set back
 * `ALIEN_GATE_EDGE_RADIUS` from the centre along the bearing to that
 * neighbour on the galaxy map. Its twin sits in the neighbour, on the edge
 * facing back, so flying through the pair carries you across the border.
 */
import { axialToPixel, getNeighbours, getSector } from './galaxy.js';

/** Distance from the sector centre to a gate's centre (world units): as far
 *  out as the 1600-wide gate fits inside the 5000-unit playable half-extent,
 *  so the sector's middle stays clear for bases. */
export const ALIEN_GATE_EDGE_RADIUS = 4100;

/** Owner string for every alien gate (the Ancients faction). */
export const ALIEN_GATE_OWNER = 'npc:ancients:gates';

export interface AlienGateSite {
  /** The sector across the border this gate leads to. */
  neighbour: string;
  /** Gate centre, game space (Y up). */
  x: number;
  y: number;
}

/** Bearing (radians, game space) from one sector to another on the galaxy
 *  map. The map projection is screen-space (Y down), so Y is flipped. */
function bearingBetween(fromKey: string, toKey: string): number | null {
  const a = getSector(fromKey);
  const b = getSector(toKey);
  if (!a || !b) return null;
  const pa = axialToPixel(a.hex, 1);
  const pb = axialToPixel(b.hex, 1);
  return Math.atan2(-(pb.y - pa.y), pb.x - pa.x);
}

/** The gate in `sectorKey` that leads to `neighbourKey` (null when either
 *  sector is unknown). */
export function alienGateSite(sectorKey: string, neighbourKey: string): AlienGateSite | null {
  const bearing = bearingBetween(sectorKey, neighbourKey);
  if (bearing === null) return null;
  return {
    neighbour: neighbourKey,
    x: Math.round(Math.cos(bearing) * ALIEN_GATE_EDGE_RADIUS),
    y: Math.round(Math.sin(bearing) * ALIEN_GATE_EDGE_RADIUS),
  };
}

/** Every alien gate in a sector, one per neighbour (empty for an unknown key). */
export function alienGateSites(sectorKey: string): AlienGateSite[] {
  const out: AlienGateSite[] = [];
  for (const n of getNeighbours(sectorKey)) {
    const site = alienGateSite(sectorKey, n.key);
    if (site) out.push(site);
  }
  return out;
}

/**
 * Where to try putting a gate, best first: every spot on a 250-unit grid that
 * keeps the whole gate inside the playable area, nearest its ideal site first
 * (ties by x, then y, so it is deterministic). A sector's NPC bases pick
 * their site first, so a gate takes the nearest free spot; a big base can
 * cover its whole edge, so the search may reach further in.
 */
export function alienGateCandidates(site: AlienGateSite, gateHalf: number, halfExtent: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number; d: number }> = [];
  const lim = Math.floor((halfExtent - gateHalf) / 250) * 250;
  for (let x = -lim; x <= lim; x += 250) {
    for (let y = -lim; y <= lim; y += 250) out.push({ x, y, d: Math.hypot(x - site.x, y - site.y) });
  }
  out.push({ x: site.x, y: site.y, d: -1 }); // the ideal site itself, first
  out.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
  return out.map(({ x, y }) => ({ x, y }));
}
