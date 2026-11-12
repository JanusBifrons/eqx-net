/**
 * Capital wreck review fixes (docs/architecture/capital-destruction.md
 * "Kill point and drift fixes"). Hostile review of a filmed death: a
 * battleship's 16" salvo killed a player heavy cruiser in
 * `showcase-capital-duel` (EQX_CAPITAL_WRECKS=1).
 *
 *  1. "The break does not follow the strikes": shells hit mid-hull yet the
 *     fragmenting spanned ~60 % of the hull. This reproduces that death with a
 *     real naval shell through the projectile pipeline and checks the kill
 *     point the server recorded against the shell's actual impact point.
 *  2. "The pieces barely drift": they kept the outline with thin gaps, no
 *     spin and no spreading for 6 s.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { shipShapeToPolygon } from '../../../src/core/geometry/shipHullDecomp.js';
import { shipHullOutline, shipShapeScale } from '../../../src/core/geometry/shipHullOutline.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import { fracturePlan, FRACTURE_MAX_PIECES } from '../../../src/core/destruction/fractureHull.js';

type V = { x: number; y: number };
const WRECK_KIND = 4;
const KIND = 'heavy-cruiser';

/** Where the segment a→b first crosses the polygon (world), or null. */
function firstCrossing(poly: ReadonlyArray<V>, a: V, b: V): V | null {
  let best = Infinity;
  let hit: V | null = null;
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const sx = q.x - p.x;
    const sy = q.y - p.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - a.x) * sy - (p.y - a.y) * sx) / den;
    const u = ((p.x - a.x) * ry - (p.y - a.y) * rx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) {
      best = t;
      hit = { x: a.x + t * rx, y: a.y + t * ry };
    }
  }
  return hit;
}

describe('SectorRoom integration: capital wreck break and drift', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function killByShell(angle: number, aimFrac: number, seed: number | null = null): Promise<{
    internal: SectorRoom['_internals']; pose: { x: number; y: number; angle: number }; impact: V;
  }> {
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
    expect(Math.abs(pose.angle - angle)).toBeLessThan(1e-3);

    // Aim at a point on the keel `aimFrac` of the half-length forward of the
    // centre, from the starboard side, square across the keel. Body frame is
    // math-up (nose +y), the same as the live collider.
    const hull = shipShapeToPolygon(getShipKind(KIND));
    let half = 0;
    for (const v of hull) half = Math.max(half, Math.abs(v.y));
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    const toW = (bx: number, by: number): V => ({ x: pose.x + bx * c - by * s, y: pose.y + bx * s + by * c });
    const start = toW(3000, aimFrac * half);
    const end = toW(-3000, aimFrac * half);
    const world = hull.map((v) => toW(v.x, v.y));
    const impact = firstCrossing(world, start, end)!;
    expect(impact).not.toBeNull();
    const speed = 3000;
    const dx = (end.x - start.x) / 6000;
    const dy = (end.y - start.y) / 6000;
    internal.spawnTestProjectile('bb-shooter', start.x, start.y, dx * speed, dy * speed, 'naval_xl', 5000);
    await harness.advance(2000);
    expect(internal.wreckDescriptors().length, 'the shell killed the cruiser and it broke up').toBe(1);
    return { internal, pose, impact };
  }

  it.each([
    ['bow-on east', 0, 0.2],
    ['turned 0.7 rad', 0.7, 0.2],
    ['turned -2.2 rad, hit aft', -2.2, -0.3],
  ])('the recorded kill point is the shell impact (%s)', async (_name, angle, aimFrac) => {
    const { internal, pose, impact } = await killByShell(angle, aimFrac);
    const d = internal.wreckDescriptors()[0]!;
    const kind = getShipKind(KIND);
    const sc = shipShapeScale(kind);
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    // Descriptor kill point: hull-local 1× Pixi-up → world.
    const mx = d.killX * sc;
    const my = -d.killY * sc;
    const kw = { x: pose.x + mx * c - my * s, y: pose.y + mx * s + my * c };
    console.log(`[kill point] ${_name}: impact ${impact.x.toFixed(1)},${impact.y.toFixed(1)} recorded ${kw.x.toFixed(1)},${kw.y.toFixed(1)} local ${d.killX},${d.killY}`);
    const err = Math.hypot(kw.x - impact.x, kw.y - impact.y);
    expect(err, 'recorded kill point vs the shell impact (world u)').toBeLessThan(10 * sc);

    // The primary break line passes through the impact (hull-local).
    const plan = fracturePlan({
      hull: shipHullOutline(kind), seed: d.seed, killPoint: { x: d.killX, y: d.killY }, maxPieces: FRACTURE_MAX_PIECES,
      killBlowDamage: d.killBlowDamage, recentDamageRate: d.recentDamageRate, snapChance: d.snapChance,
    });
    const ilx = ((impact.x - pose.x) * c + (impact.y - pose.y) * s) / sc;
    const ily = -(-(impact.x - pose.x) * s + (impact.y - pose.y) * c) / sc;
    const p = plan.primary!;
    const off = Math.abs((ilx - p.point.x) * p.dir.y - (ily - p.point.y) * p.dir.x);
    expect(off, 'primary line distance from the impact (1× hull-local u)').toBeLessThan(10);
  }, 30_000);

  it('the pieces visibly separate: near ones fly faster, spread grows and they spin', async () => {
    // A seed that shatters (no clean snap) for this hull and kill.
    const kind = getShipKind(KIND);
    let seed = 1;
    while (fracturePlan({ hull: shipHullOutline(kind), seed, killPoint: { x: -220, y: -200 }, maxPieces: FRACTURE_MAX_PIECES, killBlowDamage: 1.2, recentDamageRate: 1.2 }).snap) seed++;
    const { internal, pose } = await killByShell(0.7, 0.1, seed);
    const ids = [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    const d = internal.wreckDescriptors()[0]!;
    const sc = shipShapeScale(kind);
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    const kx = pose.x + d.killX * sc * c + d.killY * sc * s;
    const ky = pose.y + d.killX * sc * s - d.killY * sc * c;
    // Speed (the hull was at rest) of the piece nearest the kill point and of
    // the farthest one.
    let near = { d: Infinity, v: 0 };
    let far = { d: -Infinity, v: 0 };
    for (const id of ids) {
      const st = internal.wreckState(id)!;
      const dist = Math.hypot(st.x - kx, st.y - ky);
      const v = Math.hypot(st.vx, st.vy);
      if (dist < near.d) near = { d: dist, v };
      if (dist > far.d) far = { d: dist, v };
    }
    console.log(`[drift] near piece ${near.v.toFixed(1)} u/s at ${near.d.toFixed(0)} u, far piece ${far.v.toFixed(1)} u/s at ${far.d.toFixed(0)} u`);
    const t = shipTuning(kind);
    expect(near.v, 'a piece at the kill point flies out near the top push').toBeGreaterThan(0.6 * t.wreckPushMax);
    expect(far.v, 'a far piece still drifts').toBeGreaterThan(0.6 * t.wreckPushMin);
    expect(near.v, 'near pieces fly out faster than distant ones').toBeGreaterThan(1.5 * far.v);
    const centroidSpread = (): number => {
      let cx = 0;
      let cy = 0;
      const ps = ids.map((id) => internal.wreckState(id)!);
      for (const p of ps) { cx += p.x; cy += p.y; }
      cx /= ps.length; cy /= ps.length;
      let r = 0;
      for (const p of ps) r += Math.hypot(p.x - cx, p.y - cy);
      return r / ps.length;
    };
    const r0 = centroidSpread();
    await harness.advance(5000);
    const r5 = centroidSpread();
    let spin = 0;
    for (const id of ids) spin = Math.max(spin, Math.abs(internal.wreckState(id)!.angvel));
    console.log(`[drift] pieces ${ids.length} spread ${r0.toFixed(1)} → ${r5.toFixed(1)}, max spin ${(spin * 180 / Math.PI).toFixed(2)} deg/s`);
    // Before the fix the field opened 132 u in 5 s (a 2,184 u hull): pieces
    // kept the outline with hairline gaps.
    expect(r5 - r0, 'mean distance from the debris centre grows by a clear margin in 5 s').toBeGreaterThan(0.12 * kind.radius);
    expect(spin * 180 / Math.PI, 'pieces spin at a few deg/s').toBeGreaterThan(1);
  }, 30_000);
});
