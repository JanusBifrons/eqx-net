/**
 * Capital wreck pieces part slowly and never overlap (owner review of a filmed
 * break-up, 2026-11-13: "Tune it." + "they should break apart slower and have
 * more inertia and weight").
 *
 * The finding: neighbouring pieces slid over each other, and two stern pieces
 * stayed joined at their seam and folded into a "V". Pieces don't collide with
 * each other (`WRECK_COLLISION_GROUPS`), and the push away from the kill point
 * is fastest there, so a piece nearer the kill point drove into its slower
 * neighbour further along the same line, and the spin kicks turned long
 * pieces into each other's space.
 *
 * Repro: a real naval shell kills a heavy cruiser (capital wrecks on). From
 * the break, sample every piece's pose for 7 game seconds and check, with the
 * pieces' own convex parts:
 *  - no two pieces ever overlap (SAT penetration > 1 u);
 *  - every pair of neighbours (pieces sharing a cut edge in the fracture)
 *    never moves closer, and has a clear gap at the end;
 *  - the pieces are heavy: slow (a ceiling well under the old 60–370 u/s
 *    push) and slow-turning.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { shipShapeToPolygon } from '../../../src/core/geometry/shipHullDecomp.js';
import { shipHullOutline } from '../../../src/core/geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import { fracturePlan, FRACTURE_MAX_PIECES } from '../../../src/core/destruction/fractureHull.js';
import { wreckPieceGeometry } from '../../../src/core/destruction/wreckPieces.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';

type V = { x: number; y: number };
const WRECK_KIND = 4;
const KIND = 'heavy-cruiser';

/** Signed SAT depth of two convex polygons: > 0 penetration, < 0 gap. */
function satDepth(a: ReadonlyArray<V>, b: ReadonlyArray<V>): number {
  let best = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      let nx = q.y - p.y;
      let ny = p.x - q.x;
      const l = Math.hypot(nx, ny);
      if (l < 1e-9) continue;
      nx /= l; ny /= l;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const v of a) { const d = v.x * nx + v.y * ny; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const v of b) { const d = v.x * nx + v.y * ny; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      best = Math.min(best, Math.min(aMax - bMin, bMax - aMin));
    }
  }
  return best;
}

/** Signed depth between two pieces (each a list of world convex parts): the
 *  deepest overlap of any part pair, else the smallest gap. */
function pieceDepth(a: V[][], b: V[][]): number {
  let d = -Infinity;
  for (const pa of a) for (const pb of b) d = Math.max(d, satDepth(pa, pb));
  return d;
}

/** Closest distance between two segments (they share a cut edge when ~0). */
function segDist(a: V, b: V, c: V, d: V): number {
  const pt = (p: V, s0: V, s1: V): number => {
    const dx = s1.x - s0.x, dy = s1.y - s0.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - s0.x) * dx + (p.y - s0.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - s0.x - t * dx, p.y - s0.y - t * dy);
  };
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}

describe('SectorRoom integration: capital wreck pieces separate', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it.each([
    ['turned 0.7 rad, hit forward', 0.7, 0.1],
    ['turned -2.2 rad, hit aft', -2.2, -0.3],
  ])('neighbouring pieces part slowly, never overlap and never hinge (%s)', async (_name, angle, aimFrac) => {
    const kind = getShipKind(KIND);
    let seed = 1;
    while (fracturePlan({ hull: shipHullOutline(kind), seed, killPoint: { x: -220, y: -200 }, maxPieces: FRACTURE_MAX_PIECES, killBlowDamage: 1.2, recentDamageRate: 1.2 }).snap) seed++;

    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true, pilotCapitals: true,
    });
    const victim = randomUUID();
    await harness.connectActive(victim, { shipKind: KIND, spawnX: 8000, spawnY: 0, initialHull: 1, initialShield: 0 });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    internal.setWreckSeed(seed);
    internal.postToWorker({ type: 'SET_POSITION', entityId: victim, x: 8000, y: 0, angle, vx: 0, vy: 0, angvel: 0 });
    await harness.advance(150);
    const pose = internal.playerPose(victim)!;
    const hull = shipShapeToPolygon(kind);
    let half = 0;
    for (const v of hull) half = Math.max(half, Math.abs(v.y));
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    const toW = (bx: number, by: number): V => ({ x: pose.x + bx * c - by * s, y: pose.y + bx * s + by * c });
    // Fire from just off the starboard beam so the shell lands within a few ticks.
    const start = toW(kind.radius * 0.6, aimFrac * half);
    const end = toW(-kind.radius * 0.6, aimFrac * half);
    const len = Math.hypot(end.x - start.x, end.y - start.y);
    const speed = 3000;
    internal.spawnTestProjectile('bb-shooter', start.x, start.y, ((end.x - start.x) / len) * speed, ((end.y - start.y) / len) * speed, 'naval_xl', 5000);
    for (let i = 0; i < 40 && internal.wreckDescriptors().length === 0; i++) await harness.advance(50);
    const d = internal.wreckDescriptors()[0];
    expect(d, 'the shell killed the cruiser and it broke up').toBeDefined();

    // Neighbours from the fracture itself: pieces sharing a cut edge.
    const geom = wreckPieceGeometry({
      kindId: d!.parentKind as ShipKindId, seed: d!.seed, killX: d!.killX, killY: d!.killY,
      killBlowDamage: d!.killBlowDamage, recentDamageRate: d!.recentDamageRate, snapChance: d!.snapChance,
    });
    const ids = [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    const idByIndex = new Map<number, string>();
    for (const id of ids) idByIndex.set(Number(id.slice(id.lastIndexOf('-') + 1)), id);
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < geom.length; i++) {
      for (let j = i + 1; j < geom.length; j++) {
        const gi = geom[i]!, gj = geom[j]!;
        let shared = 0;
        for (let a = 0; a < gi.outline.length; a++) {
          if (!gi.cutEdges[a]) continue;
          const a0 = gi.outline[a]!, a1 = gi.outline[(a + 1) % gi.outline.length]!;
          for (let b = 0; b < gj.outline.length; b++) {
            if (!gj.cutEdges[b]) continue;
            const b0 = gj.outline[b]!, b1 = gj.outline[(b + 1) % gj.outline.length]!;
            const dd = segDist(
              { x: a0.x + gi.cx, y: a0.y + gi.cy }, { x: a1.x + gi.cx, y: a1.y + gi.cy },
              { x: b0.x + gj.cx, y: b0.y + gj.cy }, { x: b1.x + gj.cx, y: b1.y + gj.cy },
            );
            if (dd < 0.5) shared = Math.max(shared, Math.min(Math.hypot(a1.x - a0.x, a1.y - a0.y), Math.hypot(b1.x - b0.x, b1.y - b0.y)));
          }
        }
        const idI = idByIndex.get(gi.index), idJ = idByIndex.get(gj.index);
        if (shared > 1 && idI && idJ) pairs.push([idI, idJ]);
      }
    }
    expect(pairs.length, 'the fracture has neighbouring pieces').toBeGreaterThanOrEqual(ids.length - 1);

    const worldParts = (id: string): V[][] => {
      const st = internal.wreckState(id)!;
      const ca = Math.cos(st.angle), sa = Math.sin(st.angle);
      return internal.wreckParts(id)!.map((part) => part.map((v) => ({ x: st.x + v.x * ca - v.y * sa, y: st.y + v.x * sa + v.y * ca })));
    };
    const centreDist = (a: string, b: string): number => {
      const sa = internal.wreckState(a)!, sb = internal.wreckState(b)!;
      return Math.hypot(sa.x - sb.x, sa.y - sb.y);
    };

    const t = shipTuning(kind);
    const lastDist = new Map<string, number>();
    const firstDist = new Map<string, number>();
    let crackDrift = 0;
    for (const [a, b] of pairs) lastDist.set(`${a}|${b}`, centreDist(a, b));
    let worstOverlap = { depth: -Infinity, at: 0, pair: '' };
    let worstShrink = { by: 0, at: 0, pair: '' };
    let maxSpeed = 0;
    let maxSpin = 0;
    const STEP_MS = 100;
    const SAMPLES = 70; // 7 game s
    for (let k = 1; k <= SAMPLES; k++) {
      await harness.advance(STEP_MS);
      for (const id of ids) {
        const st = internal.wreckState(id)!;
        maxSpeed = Math.max(maxSpeed, Math.hypot(st.vx, st.vy));
        maxSpin = Math.max(maxSpin, Math.abs(st.angvel));
      }
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const depth = pieceDepth(worldParts(ids[i]!), worldParts(ids[j]!));
          if (depth > worstOverlap.depth) worstOverlap = { depth, at: k * STEP_MS, pair: `${ids[i]}|${ids[j]}` };
        }
      }
      for (const [a, b] of pairs) {
        const key = `${a}|${b}`;
        const dist = centreDist(a, b);
        const shrink = lastDist.get(key)! - dist;
        if (shrink > worstShrink.by) worstShrink = { by: shrink, at: k * STEP_MS, pair: key };
        if (!firstDist.has(key)) firstDist.set(key, dist);
        if (k * STEP_MS <= WRECK_CRACK_MS - 300) crackDrift = Math.max(crackDrift, Math.abs(dist - firstDist.get(key)!));
        lastDist.set(key, dist);
      }
    }
    let minEndGap = Infinity;
    for (const [a, b] of pairs) minEndGap = Math.min(minEndGap, -pieceDepth(worldParts(a), worldParts(b)));
    console.log(`[wreck separate] ${_name}: ${ids.length} pieces, ${pairs.length} neighbour pairs; worst overlap ${worstOverlap.depth.toFixed(1)} u at ${worstOverlap.at} ms (${worstOverlap.pair}); worst neighbour approach ${worstShrink.by.toFixed(2)} u at ${worstShrink.at} ms (${worstShrink.pair}); smallest neighbour gap at 7 s ${minEndGap.toFixed(1)} u; crack drift ${crackDrift.toFixed(2)} u; max speed ${maxSpeed.toFixed(1)} u/s, max spin ${(maxSpin * 180 / Math.PI).toFixed(2)} deg/s`);

    expect(worstOverlap.depth, 'no two wreck pieces overlap (SAT penetration, u)').toBeLessThan(1);
    expect(worstShrink.by, 'no neighbouring pair moves closer between samples (u)').toBeLessThan(0.5);
    // Crack delay: the hull holds its shape (pieces move as one) before it parts.
    expect(crackDrift, 'neighbours keep their spacing during the crack delay (u)').toBeLessThan(0.5);
    // Parting at wreckSeparate or more from the end of the crack delay, less damping and spin.
    expect(minEndGap, 'every neighbouring pair has a clear gap after 7 s (u)').toBeGreaterThan(0.5 * t.wreckSeparate * (SAMPLES * STEP_MS - WRECK_CRACK_MS) / 1000);
    // Heavy: a slow parting, not a fly-off (the old push was 175–370 u/s for
    // this hull), and slow turning.
    expect(maxSpeed, 'pieces drift slowly (u/s)').toBeLessThan(0.03 * kind.radius);
    expect(maxSpeed, '...but they do move apart').toBeGreaterThan(0.25 * t.wreckPushMin);
    expect(maxSpin * 180 / Math.PI, 'pieces turn slowly (deg/s)').toBeLessThan(4);

    // Pieces are solid to each other: shove one into its neighbour (as a
    // later shell would) and it bumps it instead of passing through.
    let pick: [string, string] = pairs[0]!;
    let bestMass = 0;
    for (const pr of pairs) {
      // Prefer a pair of decent-sized pieces (radius as a proxy).
      const m = Math.min(internal.swarmRegistry.get(pr[0])!.radius, internal.swarmRegistry.get(pr[1])!.radius);
      if (m > bestMass) { bestMass = m; pick = pr; }
    }
    const [mover, struck] = pick;
    const sm = internal.wreckState(mover)!, ss = internal.wreckState(struck)!;
    const dl = Math.hypot(ss.x - sm.x, ss.y - sm.y);
    const ux = (ss.x - sm.x) / dl, uy = (ss.y - sm.y) / dl;
    const shove = 0.05 * kind.radius; // ~110 u/s for a heavy cruiser
    const struckV0 = ss.vx * ux + ss.vy * uy;
    internal.postToWorker({ type: 'WRECK_KICK', entityId: mover, dvx: ux * shove, dvy: uy * shove, dw: 0 });
    let shoveOverlap = -Infinity;
    for (let k = 0; k < 40; k++) {
      await harness.advance(STEP_MS);
      shoveOverlap = Math.max(shoveOverlap, pieceDepth(worldParts(mover), worldParts(struck)));
    }
    const st1 = internal.wreckState(struck)!;
    const struckGain = st1.vx * ux + st1.vy * uy - struckV0;
    console.log(`[wreck separate] ${_name}: shove ${mover} → ${struck} at ${shove.toFixed(0)} u/s: worst overlap ${shoveOverlap.toFixed(1)} u, struck piece gained ${struckGain.toFixed(1)} u/s`);
    expect(shoveOverlap, 'a shoved piece does not pass into its neighbour (u)').toBeLessThan(0.005 * kind.radius);
    expect(struckGain, 'the struck neighbour is knocked along').toBeGreaterThan(0.1 * shove);
  }, 60_000);
});
