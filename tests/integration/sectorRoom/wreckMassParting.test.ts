/**
 * Capital wreck pieces part as heavy bodies: the break-up kicks are impulses
 * against each piece's real mass, so a big piece parts subtly and slowly and
 * a sliver a bit faster (owner, 2026-11-15: "the scrap/wreck should weigh A
 * LOT and be more resistant to moving, and should have a subtle much slower
 * movement, presumably by just giving it an accurate mass value vs the
 * forces applied").
 *
 * The finding: every shared cut opened at a SET speed (`wreckSeparate`,
 * ~31 u/s for a heavy cruiser) whatever the pieces weighed, so a piece
 * holding most of the hull's mass slid off at ~15-70 u/s.
 *
 * Repro: a real naval shell kills a heavy cruiser at rest (capital wrecks
 * on). After the crack hold ends, every piece's speed is its parting kick:
 *  - the biggest piece parts at under 0.0035 × radius (~7.6 u/s; ~3 u/s
 *    measured, the brief's 2-5 u/s);
 *  - the lightest piece parts faster than the biggest (mass-scaled), and
 *    under 0.015 × radius (~33 u/s);
 *  - the momentum the kicks add is the blast's only: the pieces' momentum
 *    is under 0.003 × radius × hull mass.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { shipShapeToPolygon } from '../../../src/core/geometry/shipHullDecomp.js';
import { shipHullOutline } from '../../../src/core/geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../../src/shared-types/shipKinds.js';
import { fracturePlan, FRACTURE_MAX_PIECES } from '../../../src/core/destruction/fractureHull.js';
import { wreckPieceGeometry } from '../../../src/core/destruction/wreckPieces.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';

const WRECK_KIND = 4;
const KIND = 'heavy-cruiser';

describe('SectorRoom integration: capital wreck pieces part by their mass', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('the big piece parts slowly and a light piece faster', async () => {
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
    internal.postToWorker({ type: 'SET_POSITION', entityId: victim, x: 8000, y: 0, angle: 0.7, vx: 0, vy: 0, angvel: 0 });
    await harness.advance(150);
    const pose = internal.playerPose(victim)!;
    const hull = shipShapeToPolygon(kind);
    let half = 0;
    for (const v of hull) half = Math.max(half, Math.abs(v.y));
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    const toW = (bx: number, by: number): { x: number; y: number } => ({ x: pose.x + bx * c - by * s, y: pose.y + bx * s + by * c });
    const start = toW(kind.radius * 0.6, 0.1 * half);
    const end = toW(-kind.radius * 0.6, 0.1 * half);
    const len = Math.hypot(end.x - start.x, end.y - start.y);
    internal.spawnTestProjectile('bb-shooter', start.x, start.y, ((end.x - start.x) / len) * 3000, ((end.y - start.y) / len) * 3000, 'naval_xl', 5000);
    for (let i = 0; i < 40 && internal.wreckDescriptors().length === 0; i++) await harness.advance(50);
    const d = internal.wreckDescriptors()[0];
    expect(d, 'the shell killed the cruiser and it broke up').toBeDefined();

    const geom = wreckPieceGeometry({
      kindId: d!.parentKind as ShipKindId, seed: d!.seed, killX: d!.killX, killY: d!.killY,
      killBlowDamage: d!.killBlowDamage, recentDamageRate: d!.recentDamageRate, snapChance: d!.snapChance,
    });
    const ids = [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    const massOf = (id: string): number => geom.find((g) => g.index === Number(id.slice(id.lastIndexOf('-') + 1)))!.mass;
    let hullMass = 0;
    for (const id of ids) hullMass += massOf(id);
    const byMass = [...ids].sort((a, b) => massOf(b) - massOf(a));
    const big = byMass[0]!;
    const light = byMass[byMass.length - 1]!;

    // Each piece's velocity in the crack hold (the hull's rigid motion),
    // then past the hold: the difference is its parting kick.
    const held = new Map<string, { vx: number; vy: number }>();
    for (const id of ids) {
      const st = internal.wreckState(id)!;
      held.set(id, { vx: st.vx, vy: st.vy });
    }
    await harness.advance(WRECK_CRACK_MS + 300);
    const kick = (id: string): { x: number; y: number } => {
      const st = internal.wreckState(id)!;
      const h = held.get(id)!;
      return { x: st.vx - h.vx, y: st.vy - h.vy };
    };
    const speed = (id: string): number => Math.hypot(kick(id).x, kick(id).y);
    let px = 0, py = 0;
    for (const id of ids) {
      px += massOf(id) * kick(id).x;
      py += massOf(id) * kick(id).y;
    }
    const momentum = Math.hypot(px, py) / hullMass;
    const lines = byMass.map((id) => `${id} ${(100 * massOf(id) / hullMass).toFixed(1)} % ${speed(id).toFixed(2)} u/s`);
    console.log(`[wreck mass parting] ${ids.length} pieces, hull radius ${kind.radius.toFixed(0)} u; momentum/hull mass ${momentum.toFixed(2)} u/s\n  ${lines.join('\n  ')}`);

    expect(speed(big), 'the biggest piece parts slowly (u/s)').toBeLessThan(0.0035 * kind.radius);
    expect(speed(big), '...but it does part').toBeGreaterThan(0.05);
    expect(speed(light), 'a light piece parts faster than the biggest').toBeGreaterThan(speed(big));
    expect(speed(light), 'a light piece is not flung (u/s)').toBeLessThan(0.015 * kind.radius);
    expect(momentum, 'the kicks add little net momentum (u/s of the whole hull)').toBeLessThan(0.003 * kind.radius);
  }, 60_000);
});
