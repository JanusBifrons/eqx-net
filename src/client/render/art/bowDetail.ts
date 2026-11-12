/**
 * Machined art — bow detail for capital hulls (owner decision 2026-11-12).
 *
 * A close-up showed a battleship's bow as a plain grey wedge: the warship
 * generator puts the superstructure, stacks and mounts amidships, and the
 * forge only plates the bow. This plans the fittings a WW2 forecastle
 * carries, from the hull's own geometry, so every capital kind (and every
 * style variant) gets them:
 *
 *  - anchor gear: hawse pipes and anchors near the bow edges, chain runs to
 *    a windlass and its wildcats on the centreline;
 *  - a V breakwater ahead of turret A;
 *  - deck fittings: bollards, fairleads, ventilators, hatches, a jackstaff at
 *    the stem;
 *  - a few plating seams across and along the forecastle;
 *  - a forward fire-control director between the forward turrets and the
 *    bridge, where the gap holds one.
 *
 * Every size is a fraction of the hull's beam (the kind's own dimensions,
 * which already follow the ship scale; invariant #18). Nothing lands under a
 * gunhouse's swept circle, over a turret ring or on another part: a feature
 * that would is moved along its row or dropped. The plan is pure and seeded
 * by the kind id, so it is the same on every device. The forge stamps it
 * into the hull's height, material and albedo fields (`forgeShip`), so the
 * baked frames and the GPU-lit maps (normals from height) both carry it.
 *
 * Coordinates: entity-local world units, Pixi-up (nose at −y), the forge's
 * space.
 */
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { insidePoly, hashStr, rng, type Poly } from './raster.js';
import { shipTurrets } from './turretLayout.js';

export type BowFeatureKind =
  | 'jackstaff' | 'hawse' | 'anchor' | 'chain' | 'windlass' | 'wildcat'
  | 'breakwater' | 'bollard' | 'fairlead' | 'ventilator' | 'hatch' | 'seam' | 'director' | 'rangefinder';

/** One fitting: a box (half extents hw × hh, long axis along local y,
 *  turned by `rot` from world +y) or a disc (radius hw). */
export interface BowFeature {
  kind: BowFeatureKind;
  shape: 'box' | 'disc';
  x: number;
  y: number;
  hw: number;
  hh: number;
  rot: number;
}

/** A circle nothing may touch: a turret's ring and its gunhouse's sweep. */
export interface KeepOut { x: number; y: number; r: number; id: string }

export interface BowPlan {
  features: BowFeature[];
  /** Stem (most forward hull point) and the bow's aft edge (turret A's keep-out). */
  stemY: number;
  bowEndY: number;
  /** Hull beam (2 × the widest half-breadth). */
  beam: number;
  keepOuts: KeepOut[];
}

export interface BowPart { pts: Poly; role?: string }

/** Half-breadth of a closed polygon at y (widest crossing; 0 outside). */
export function halfWidthAt(poly: Poly, y: number): number {
  let best = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x0, y0] = poly[j]!, [x1, y1] = poly[i]!;
    if ((y0 > y) === (y1 > y)) continue;
    const x = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
    if (Math.abs(x) > best) best = Math.abs(x);
  }
  return best;
}

/** World-space sample points on a feature's outline (corners / rim). */
export function featureOutline(f: BowFeature): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (f.shape === 'disc') {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      out.push([f.x + Math.cos(a) * f.hw, f.y + Math.sin(a) * f.hw]);
    }
    return out;
  }
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1]] as const) {
    const px = lx * f.hw, py = ly * f.hh;
    out.push([f.x + px * c - py * s, f.y + px * s + py * c]);
  }
  return out;
}

/** Distance from a point to a feature's area (0 inside). */
export function distToFeature(f: BowFeature, px: number, py: number): number {
  if (f.shape === 'disc') return Math.max(0, Math.hypot(px - f.x, py - f.y) - f.hw);
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  const dx = px - f.x, dy = py - f.y;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const ex = Math.max(0, Math.abs(lx) - f.hw), ey = Math.max(0, Math.abs(ly) - f.hh);
  return Math.hypot(ex, ey);
}

/** Turret keep-outs for a ship kind: each mount's ring (as stamped, r × 1.15)
 *  or its gunhouse's swept circle, whichever is larger. */
export function turretKeepOuts(kindId: string): KeepOut[] {
  return shipTurrets(kindId).map((t) => {
    const house = t.naval ? Math.hypot(t.naval.houseW, t.naval.houseL) / 2 : t.cap;
    return { x: t.px, y: t.py, r: Math.max(t.ring * 1.15, house), id: t.mount.id };
  });
}

/**
 * Plan the bow fittings for a capital kind. `parts` are the forge's world
 * parts (with roles); the first `hull` part is the outline. Returns an empty
 * plan for a kind with no forward main turret (not a capital layout).
 */
export function planBowFeatures(kindId: string, parts: readonly BowPart[]): BowPlan {
  const hullPart = parts.find((p) => p.role === 'hull') ?? parts[0]!;
  const hull = hullPart.pts;
  let stemY = Infinity, maxHalf = 0;
  for (const [x, y] of hull) { stemY = Math.min(stemY, y); maxHalf = Math.max(maxHalf, Math.abs(x)); }
  const b = maxHalf * 2;
  const keepOuts = turretKeepOuts(kindId);
  const fore = shipTurrets(kindId).filter((t) => t.mount.id.startsWith('main-') && t.py < 0).sort((p, q) => p.py - q.py);
  const empty: BowPlan = { features: [], stemY, bowEndY: stemY, beam: b, keepOuts };
  if (fore.length === 0 || getShipKind(kindId).sizeClass !== 'capital') return empty;
  const margin = b * 0.02;
  const keepA = keepOuts.find((k) => k.id === fore[0]!.mount.id)!;
  const bowEndY = keepA.y - keepA.r - margin;
  const len = bowEndY - stemY;
  if (len <= b * 0.2) return empty;
  const Y = (f: number): number => stemY + f * len;
  const hw = (y: number): number => halfWidthAt(hull, y);
  // Parts a fitting must stay off (other than the hull and its deck plate).
  const blockers = parts.filter((p) => p.role === 'superstructure' || p.role === 'stack' || p.role === 'engine');
  const R = rng(hashStr(`${kindId}:bow`));
  const features: BowFeature[] = [];

  const insideHull = (f: BowFeature): boolean => featureOutline(f).every(([x, y]) => insidePoly(hull, x, y) && hw(y) - Math.abs(x) >= b * 0.006);
  const clearOfTurrets = (f: BowFeature): boolean => keepOuts.every((k) => distToFeature(f, k.x, k.y) >= k.r + margin * 0.5);
  const clearOfParts = (f: BowFeature): boolean => blockers.every((p) => featureOutline(f).every(([x, y]) => !insidePoly(p.pts, x, y))
    && p.pts.every(([x, y]) => distToFeature(f, x, y) > 0));
  const clearOfFittings = (f: BowFeature): boolean => features.every((o) => {
    if (o.kind === 'seam' || o.kind === 'chain' || f.kind === 'seam' || f.kind === 'chain') return true;
    // Conservative: centre distance against both bounding radii.
    return Math.hypot(o.x - f.x, o.y - f.y) >= Math.hypot(o.hw, o.hh) + Math.hypot(f.hw, f.hh) + b * 0.004;
  });
  const fits = (f: BowFeature, solo = true): boolean => insideHull(f) && clearOfTurrets(f) && clearOfParts(f) && (!solo || clearOfFittings(f));
  const box = (kind: BowFeatureKind, x: number, y: number, hwx: number, hhy: number, rot = 0): BowFeature => ({ kind, shape: 'box', x, y, hw: hwx, hh: hhy, rot });
  const disc = (kind: BowFeatureKind, x: number, y: number, r: number): BowFeature => ({ kind, shape: 'disc', x, y, hw: r, hh: r, rot: 0 });
  /** Place a mirrored pair (or one centreline feature); returns whether it went in. */
  const add = (make: (side: 1 | -1) => BowFeature, pair: boolean): boolean => {
    const set = pair ? [make(1), make(-1)] : [make(1)];
    if (!set.every((f) => fits(f))) return false;
    features.push(...set);
    return true;
  };
  /** Try a row at each fraction in turn until one fits. */
  const addAt = (fs: readonly number[], make: (y: number, side: 1 | -1) => BowFeature, pair: boolean): number | null => {
    for (const f of fs) if (add((side) => make(Y(f), side), pair)) return Y(f);
    return null;
  };
  const near = (f: number, spread = 0.06): number[] => [f, f + spread, f - spread, f + spread * 2, f - spread * 2].filter((v) => v > 0.02 && v < 0.98);

  // Jackstaff: a thin rod on the stem, where the bow is wide enough to hold it.
  const jsH = b * 0.035, jsW = b * 0.007;
  for (let y = stemY + jsH; y < Y(0.3); y += b * 0.01) {
    if (add(() => box('jackstaff', 0, y + b * 0.01, jsW, jsH), false)) break;
  }

  // Anchor gear: windlass + wildcats on the centreline, hawse pipes and
  // anchors near the edges forward of it, chain runs between.
  // The windlass and its wildcats go in as one group (they touch by design);
  // lateral sizes follow the local half-breadth, as the bow is narrow.
  let wild: { x: number; y: number } | null = null;
  for (const f of near(0.42)) {
    const y = Y(f), h = hw(y);
    const whw = Math.min(b * 0.06, h * 0.3), wr = Math.min(b * 0.024, h * 0.16);
    const wx = whw + wr * 1.1;
    const set = [box('windlass', 0, y, whw, Math.min(b * 0.032, whw * 0.6)), disc('wildcat', wx, y, wr), disc('wildcat', -wx, y, wr)];
    if (set.every((q) => fits(q))) { features.push(...set); wild = { x: wx, y }; break; }
  }
  let hawseR = b * 0.022;
  let hawse: { x: number; y: number } | null = null;
  for (const f of near(0.22, 0.04)) {
    const y = Y(f), x = hw(y) * 0.62;
    hawseR = Math.min(b * 0.022, hw(y) * 0.2);
    if (add((side) => disc('hawse', side * x, y, hawseR), true)) { hawse = { x, y }; break; }
  }
  if (hawse) {
    // Anchor: stowed against the flare just ahead of its hawse, shank along the edge.
    for (let k = 0; k < 6; k++) {
      const ya = hawse.y - b * (0.05 + k * 0.01);
      const slope = (hw(ya + b * 0.02) - hw(ya - b * 0.02)) / (b * 0.04);
      const aw = Math.min(b * 0.016, hw(ya) * 0.16), xa = hw(ya) - aw * 1.9;
      if (add((side) => box('anchor', side * xa, ya, aw, aw * 2.5, side * -Math.atan(slope)), true)) break;
    }
    if (wild) {
      const h = hawse, w = wild;
      const dx = w.x - h.x, dy = w.y - h.y;
      const l = Math.hypot(dx, dy) / 2;
      const chain = (side: 1 | -1): BowFeature => box('chain', side * (h.x + w.x) / 2, (h.y + w.y) / 2, Math.min(b * 0.0075, hawseR * 0.4), l, Math.atan2(-side * dx, dy));
      add(chain, true);
    }
  }

  // Breakwater: a V just ahead of turret A, apex forward, arms raking aft
  // toward the edges.
  for (const back of [0.025, 0.05, 0.08, 0.11, 0.14]) {
    const yEnd = bowEndY - b * back;
    const yApex = yEnd - b * 0.16;
    const reach = hw(yEnd) * 0.72;
    const dx = reach, dy = yEnd - yApex;
    const l = Math.hypot(dx, dy) / 2;
    const arm = (side: 1 | -1): BowFeature => box('breakwater', side * reach / 2, (yApex + yEnd) / 2, b * 0.011, l, Math.atan2(-side * dx, dy));
    if (add(arm, true)) break;
  }

  // Bollards: twin posts (one long block) near the deck edge, three stations.
  for (const f of [0.3, 0.55, 0.8]) {
    addAt(near(f, 0.04), (y, side) => {
      const w = Math.min(b * 0.012, hw(y) * 0.1);
      return box('bollard', side * hw(y) * 0.76, y, w, w * 2.5);
    }, true);
  }
  // Fairleads at the deck edge, between the bollards.
  for (const f of [0.38, 0.66]) {
    addAt(near(f, 0.04), (y, side) => {
      const w = Math.min(b * 0.009, hw(y) * 0.07);
      return box('fairlead', side * (hw(y) - w * 2.2), y, w, w * 2.2);
    }, true);
  }
  // Hatches on the centreline, aft and forward of the windlass.
  addAt(near(0.62, 0.05), (y) => box('hatch', 0, y, Math.min(b * 0.05, hw(y) * 0.3), Math.min(b * 0.04, hw(y) * 0.24)), false);
  addAt(near(0.3, 0.04), (y) => box('hatch', 0, y, Math.min(b * 0.032, hw(y) * 0.25), Math.min(b * 0.028, hw(y) * 0.2)), false);
  // Ventilators (mushroom heads), offset from the centreline.
  for (const [f, k] of [[0.34, 0.45], [0.72, 0.45], [0.5, 0.5]] as const) {
    addAt(near(f + (R() - 0.5) * 0.04, 0.04), (y, side) => disc('ventilator', side * hw(y) * k, y, Math.min(b * 0.018, hw(y) * 0.13)), true);
  }

  // Plating: transverse seams across the forecastle and a longitudinal seam
  // either side following the flare. Seams never cross a turret keep-out.
  for (const f0 of [0.2, 0.46, 0.7, 0.9]) {
    const f = f0 + (R() - 0.5) * 0.05;
    for (const ff of near(f, 0.025)) {
      const y = Y(ff);
      // A transverse seam: the box's long axis turned across the hull.
      const s = box('seam', 0, y, b * 0.0025, hw(y) * 0.8, Math.PI / 2);
      if (fits(s, false)) { features.push(s); break; }
    }
  }
  const segs = 5, k = 0.55;
  for (let i = 0; i < segs; i++) {
    const ya = Y(0.12 + (0.86 * i) / segs), yb = Y(0.12 + (0.86 * (i + 1)) / segs);
    for (const side of [1, -1] as const) {
      const xa = hw(ya) * k, xb = hw(yb) * k;
      const dx = xb - xa, dy = yb - ya;
      const s = box('seam', side * (xa + xb) / 2, (ya + yb) / 2, b * 0.0025, Math.hypot(dx, dy) / 2, Math.atan2(-side * dx, dy));
      if (fits(s, false)) features.push(s);
    }
  }

  // Forward fire-control director: on open deck between the forward turrets'
  // keep-out and the bridge face when the gap holds one, else on the
  // bridge's forward step (the lowest superstructure tier, ahead of the next
  // tier up), the way the real tops sat on the conning tower. Sized to the gap.
  const keepB = keepOuts.find((q) => q.id === fore[fore.length - 1]!.mount.id)!;
  const tiers = parts.filter((p) => p.role === 'superstructure')
    .map((p) => ({ p, front: Math.min(...p.pts.map(([, y]) => y)) }))
    .sort((p, q) => p.front - q.front);
  const director = (lo: number, hi: number, within?: Poly): boolean => {
    const hh = Math.min(b * 0.06, (hi - lo) / 2);
    if (hh < b * 0.025) return false;
    const y = (lo + hi) / 2;
    const body = box('director', 0, y, hh * 1.25, hh);
    const bar = box('rangefinder', 0, y + hh * 0.2, hh * 2.6, hh * 0.22);
    const ok = within
      ? [body, bar].every((q) => insideHull(q) && clearOfTurrets(q) && featureOutline(q).every(([x, yy]) => insidePoly(within, x, yy))
        && tiers.slice(1).every((t) => t.p.pts.every(([x, yy]) => distToFeature(q, x, yy) > 0) && featureOutline(q).every(([x, yy]) => !insidePoly(t.p.pts, x, yy))))
      : fits(body) && fits(bar, false);
    if (ok) features.push(body, bar);
    return ok;
  };
  if (tiers.length > 0) {
    const placed = director(keepB.y + keepB.r + margin, tiers[0]!.front - margin);
    const step = tiers.find((t) => t.front > tiers[0]!.front + b * 0.01);
    if (!placed && step) director(Math.max(tiers[0]!.front + margin * 0.5, keepB.y + keepB.r + margin), step.front - margin * 0.5, tiers[0]!.p.pts);
  }
  return { features, stemY, bowEndY, beam: b, keepOuts };
}
