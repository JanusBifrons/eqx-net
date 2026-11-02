/**
 * Where an NPC base goes in a real galaxy sector, and where a ship may spawn
 * once bases exist (plan soft-leaping-truffle v3, phase T1). Pure, zone-blind.
 *
 * A grown base is laid out around its Capital at (0, 0). `chooseBaseSite`
 * scans the sector for a Capital position where the whole base (plus a margin)
 * fits inside the sector and touches no HARD blocker: saved player structures
 * and parked hulls always win the space. Among those it prefers the fewest
 * SOFT obstacles (asteroids — the caller clears the ones it returns), then the
 * site farthest from the origin (players spawn near it), with a seeded
 * tie-break so a sector's base is stable across restarts.
 */
import { structureHalfExtents } from '../../shared-types/structureKinds.js';
import { seededRandom } from './baseProfile.js';
import type { GrownPlacement } from './growBase.js';

/** An axis-aligned box: centre + half extents. */
export interface SiteBox { x: number; y: number; hw: number; hh: number }
/** A circle (an asteroid). */
export interface SiteCircle { x: number; y: number; r: number }
/** A base's extent relative to its Capital. */
export interface BaseExtent { x0: number; x1: number; y0: number; y1: number }

/** The box around every structure of a grown base (relative to its Capital). */
export function grownExtent(placements: readonly GrownPlacement[]): BaseExtent {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of placements) {
    const { hw, hh } = structureHalfExtents(p.kind, p.rot ?? 0);
    x0 = Math.min(x0, p.x - hw); x1 = Math.max(x1, p.x + hw);
    y0 = Math.min(y0, p.y - hh); y1 = Math.max(y1, p.y + hh);
  }
  return placements.length === 0 ? { x0: 0, x1: 0, y0: 0, y1: 0 } : { x0, x1, y0, y1 };
}

export interface ChooseSiteOptions {
  /** The sector's playable half extent (square, centred on the origin). */
  halfExtent: number;
  /** Clear space kept around the base (and inside the sector edge). */
  margin: number;
  /** Candidate grid spacing (u). */
  step: number;
  seed: number;
}

export interface BaseSite {
  /** World position for the Capital. */
  x: number;
  y: number;
  /** Indices into `soft` the base overlaps (the caller clears them). */
  overlapped: number[];
}

function boxHitsBox(ax0: number, ax1: number, ay0: number, ay1: number, b: SiteBox): boolean {
  return ax0 < b.x + b.hw && ax1 > b.x - b.hw && ay0 < b.y + b.hh && ay1 > b.y - b.hh;
}

function boxHitsCircle(ax0: number, ax1: number, ay0: number, ay1: number, c: SiteCircle): boolean {
  const dx = Math.max(ax0 - c.x, 0, c.x - ax1);
  const dy = Math.max(ay0 - c.y, 0, c.y - ay1);
  return dx * dx + dy * dy < c.r * c.r;
}

/** The best Capital position, or null when the base fits nowhere. */
export function chooseBaseSite(
  ext: BaseExtent,
  hard: readonly SiteBox[],
  soft: readonly SiteCircle[],
  o: ChooseSiteOptions,
): BaseSite | null {
  const lim = o.halfExtent - o.margin;
  const cxMin = -lim - ext.x0, cxMax = lim - ext.x1;
  const cyMin = -lim - ext.y0, cyMax = lim - ext.y1;
  if (cxMin > cxMax || cyMin > cyMax) return null;
  const rnd = seededRandom(o.seed);
  let best: { x: number; y: number; soft: number; score: number } | null = null;
  for (let cx = cxMin; cx <= cxMax + 1e-6; cx += o.step) {
    for (let cy = cyMin; cy <= cyMax + 1e-6; cy += o.step) {
      const x0 = cx + ext.x0 - o.margin, x1 = cx + ext.x1 + o.margin;
      const y0 = cy + ext.y0 - o.margin, y1 = cy + ext.y1 + o.margin;
      let blocked = false;
      for (const b of hard) if (boxHitsBox(x0, x1, y0, y1, b)) { blocked = true; break; }
      if (blocked) continue;
      let n = 0;
      for (const c of soft) if (boxHitsCircle(x0, x1, y0, y1, c)) n++;
      // Fewest asteroids first, then farthest from the origin (spawn), then a
      // small seeded jitter so equal sites don't all pick the same corner.
      const score = Math.hypot(cx, cy) + rnd() * o.step * 0.5;
      if (best === null || n < best.soft || (n === best.soft && score > best.score)) {
        best = { x: cx, y: cy, soft: n, score };
      }
    }
  }
  if (best === null) return null;
  const x0 = best.x + ext.x0 - o.margin, x1 = best.x + ext.x1 + o.margin;
  const y0 = best.y + ext.y0 - o.margin, y1 = best.y + ext.y1 + o.margin;
  const overlapped: number[] = [];
  for (let i = 0; i < soft.length; i++) if (boxHitsCircle(x0, x1, y0, y1, soft[i]!)) overlapped.push(i);
  return { x: best.x, y: best.y, overlapped };
}

/**
 * The nearest point to (x, y) where a body of `radius` overlaps none of
 * `boxes` (spawning a ship inside a structure would trap or fling it).
 * Searches rings outward; returns (x, y) unchanged when already clear, or the
 * original point if nothing within `maxDistance` is clear.
 */
export function nearestClearPoint(
  x: number, y: number, boxes: readonly SiteBox[], radius: number, maxDistance = 6000,
): { x: number; y: number } {
  const clear = (px: number, py: number): boolean => {
    for (const b of boxes) {
      if (boxHitsCircle(b.x - b.hw, b.x + b.hw, b.y - b.hh, b.y + b.hh, { x: px, y: py, r: radius })) return false;
    }
    return true;
  };
  if (clear(x, y)) return { x, y };
  const RING = 150;
  for (let d = RING; d <= maxDistance; d += RING) {
    const steps = Math.max(8, Math.ceil((2 * Math.PI * d) / RING));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      if (clear(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}
