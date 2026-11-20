/**
 * Convoy hauler docking geometry (moved out of ConvoyDirector.ts): where a
 * hauler docks at a base (its reachable crane bay or the edge of the base
 * box), whether a bay sits behind a fence, and where it enters and leaves a
 * sector (the classic edge point, or a solar sector's gate-pocket lane).
 * Pure functions.
 */
import { sectorSites } from '../../core/galaxy/sectorSites.js';
import { axialToPixel, getSector } from '../../core/galaxy/galaxy.js';
import type { ConvoyBay, NpcBaseTrade } from './convoyRoom.js';

/**
 * 3h — where a hauler docks at a base: its Freight Dock's bay centre when it
 * has a reachable one, else the nearest point of its box expanded by `m`.
 */
export function convoyDockTarget(end: { box: NpcBaseTrade['box']; bay?: ConvoyBay }, m: number, x: number, y: number): { x: number; y: number } {
  return end.bay ? { x: end.bay.x, y: end.bay.y } : dockPoint(end.box, m, x, y);
}

/**
 * 3h — true when bay centre (x, y) lies inside the fence ring `pylons`
 * (the box of the owner's shield emitters: a grown base's fence is a
 * rectangle around everything, its pads included). Gates open only for
 * pilots, so a hauler can never reach a bay behind a fence. Fewer than two
 * emitters is no fence.
 */
export function bayBehindFence(x: number, y: number, pylons: ReadonlyArray<{ x: number; y: number }>): boolean {
  if (pylons.length < 2) return false;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pylons) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  return x > x0 && x < x1 && y > y0 && y < y1;
}

/** Nearest point of `box` expanded by `m` to (x, y) — a dock outside the base. */
export function dockPoint(box: NpcBaseTrade['box'], m: number, x: number, y: number): { x: number; y: number } {
  const x0 = box.x0 - m, x1 = box.x1 + m, y0 = box.y0 - m, y1 = box.y1 + m;
  let px = Math.min(Math.max(x, x0), x1);
  let py = Math.min(Math.max(y, y0), y1);
  if (px > x0 && px < x1 && py > y0 && py < y1) {
    // Inside: push to the nearest side.
    const d = [px - x0, x1 - px, py - y0, y1 - py];
    const i = d.indexOf(Math.min(...d));
    if (i === 0) px = x0; else if (i === 1) px = x1; else if (i === 2) py = y0; else py = y1;
  }
  return { x: px, y: py };
}

/**
 * Where a hauler enters and leaves a sector for this base: the edge point on
 * the base's own side (haulers fly ~40 u/s, so a far-side entry made every leg
 * minutes long), stepped back toward the centre until it is `clear` u outside
 * the footprint box (a base can reach the edge; never spawn inside its fence).
 */
export function edgeNear(box: NpcBaseTrade['box'], r: number, clear: number): { x: number; y: number } {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const len = Math.hypot(cx, cy);
  const dx = len < 1 ? 1 : cx / len, dy = len < 1 ? 0 : cy / len;
  const outside = (x: number, y: number): boolean =>
    x < box.x0 - clear || x > box.x1 + clear || y < box.y0 - clear || y > box.y1 + clear;
  for (let d = r; d >= 0; d -= 200) {
    if (outside(dx * d, dy * d)) return { x: dx * d, y: dy * d };
  }
  // The box covers the whole ray (a base around the centre): its nearest side.
  return dockPoint(box, clear, 0, 0);
}

/**
 * Solar-system sectors: where a hauler enters / leaves `sectorKey` toward
 * `otherSector`: the rim of the gate pocket facing that way, on the side of
 * the base. Not a neighbour: the gate whose neighbour lies nearest the far
 * sector on the map; same sector: the gate nearest the base. Null when the
 * sector has no gate pockets.
 */
export function solarLanePoint(sectorKey: string, otherSector: string, box: { x0: number; y0: number; x1: number; y1: number }): { x: number; y: number } | null {
  const gates = sectorSites(sectorKey).filter((g) => g.kind === 'gate');
  if (gates.length === 0) return null;
  const bx = (box.x0 + box.x1) / 2, by = (box.y0 + box.y1) / 2;
  let gate = gates.find((g) => g.neighbour === otherSector);
  if (!gate) {
    const far = otherSector !== sectorKey ? getSector(otherSector) : undefined;
    const fp = far ? axialToPixel(far.hex, 1) : null;
    let best = Infinity;
    for (const g of gates) {
      const ns = g.neighbour ? getSector(g.neighbour) : undefined;
      const np = ns ? axialToPixel(ns.hex, 1) : null;
      const d = fp && np ? Math.hypot(np.x - fp.x, np.y - fp.y) : Math.hypot(g.x - bx, g.y - by);
      if (d < best) { best = d; gate = g; }
    }
  }
  const dx = bx - gate!.x, dy = by - gate!.y, len = Math.hypot(dx, dy) || 1;
  return { x: Math.round(gate!.x + (dx / len) * gate!.r), y: Math.round(gate!.y + (dy / len) * gate!.r) };
}
