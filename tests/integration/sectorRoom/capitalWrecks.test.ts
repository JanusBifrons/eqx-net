/**
 * Capital destruction S2a (docs/architecture/capital-destruction.md §S2): a
 * dying capital breaks into wreck pieces that are solid bodies on the server.
 * Behind the `capitalWrecks` room option (off by default: clients don't draw
 * wrecks until S3, and a playtest must never meet invisible walls).
 *
 * Drives the real chain: applyDamage → DamageRouter → the capital's death
 * (swarm death policy / SHIP_DESTROYED) → CapitalWreckSubsystem →
 * buildWreckPieces → SwarmSpawner.spawnWreck → the physics worker; then the
 * projectile pipeline, the beam ray test and a ram against the pieces.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { shipShapeToPolygon } from '../../../src/core/geometry/shipHullDecomp.js';
import { shipHullOutline } from '../../../src/core/geometry/shipHullOutline.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { fracturePlan } from '../../../src/core/destruction/fractureHull.js';

type V = { x: number; y: number };
const WRECK_KIND = 4;

function area(poly: ReadonlyArray<V>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function distToOutline(poly: ReadonlyArray<V>, p: V): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
  }
  return best;
}

function pointIn(poly: ReadonlyArray<V>, p: V): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function worldHull(kindId: string, x: number, y: number, angle: number): V[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return shipShapeToPolygon(getShipKind(kindId)).map((v) => ({ x: x + v.x * c - v.y * s, y: y + v.x * s + v.y * c }));
}

/** A seed whose plan shatters (no clean snap), so the piece count is earned. */
function shatterSeed(): number {
  const hull = shipHullOutline(getShipKind('battleship'));
  for (let seed = 1; ; seed++) {
    if (!fracturePlan({ hull, seed, killPoint: { x: 0, y: 0 }, maxPieces: 64, killBlowDamage: 1 }).snap) return seed;
  }
}

describe('SectorRoom integration — capital wrecks (S2a)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function boot(capitalWrecks: boolean, extra: Record<string, unknown> = {}): Promise<SectorRoom['_internals']> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks, ...extra,
    });
    await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: -20_000, spawnY: -20_000 });
    return (harness.getServerRoom() as unknown as SectorRoom)._internals;
  }

  function wrecks(internal: SectorRoom['_internals']) {
    return [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
  }

  it('an NPC capital killed with the flag on leaves N ≥ 2 wreck bodies tiling its hull, pushed outward', async () => {
    const internal = await boot(true);
    expect(internal.spawnTestDrone('bb', 6000, 0, 'battleship')).toBe(true);
    await harness.advance(100);
    const at = internal.wreckState('bb')!;
    const hull = worldHull('battleship', at.x, at.y, at.angle);
    const hit = hull[4]!; // a point on the hull's edge
    internal.applyDamage('bb', 'shooter-x', 1e7, hit.x, hit.y);

    expect(internal.swarmRegistry.get('bb')).toBeFalsy();
    const ps = wrecks(internal);
    expect(ps.length).toBeGreaterThanOrEqual(2);
    const want = Math.abs(area(hull));
    let total = 0;
    for (const r of ps) {
      const st = internal.wreckState(r.id)!;
      const parts = internal.wreckParts(r.id)!;
      const c = Math.cos(st.angle);
      const s = Math.sin(st.angle);
      for (const part of parts) {
        total += area(part);
        // Every vertex sits on or inside the hull at death (world space). The
        // worker runs on its own thread and may already have stepped the
        // pieces once (1/60 s of drift and spin): a few units of slack.
        for (const v of part) {
          const w = { x: st.x + v.x * c - v.y * s, y: st.y + v.x * s + v.y * c };
          expect(pointIn(hull, w) || distToOutline(hull, w) < 5, `${w.x},${w.y} off by ${distToOutline(hull, w)}; ship ${JSON.stringify(at)} piece ${JSON.stringify(st)}`).toBe(true);
        }
      }
      // Inherits the hull's velocity (at rest + ω×r ≈ 0) plus a push AWAY
      // from the kill point.
      const ex = st.vx - at.vx + at.angvel * (st.y - at.y);
      const ey = st.vy - at.vy - at.angvel * (st.x - at.x);
      const ox = st.x - hit.x;
      const oy = st.y - hit.y;
      expect(ex * ox + ey * oy).toBeGreaterThan(0);
    }
    expect(Math.abs(total - want) / want).toBeLessThan(0.005);
  }, 25_000);

  it('a single huge final hit breaks into more pieces than a slow grind (same seed)', async () => {
    const internal = await boot(true);
    internal.setWreckSeed(shatterSeed());
    internal.spawnTestDrone('heavy', 6000, 0, 'battleship');
    internal.spawnTestDrone('grind', -6000, 0, 'battleship');
    await harness.advance(100);
    internal.applyDamage('heavy', 'shooter-x', 1e7);
    const heavy = wrecks(internal).length;
    // The grind: the hull was worn down long ago, the last hit is a chip.
    internal.swarmHealth.set('grind', 1);
    internal.applyDamage('grind', 'shooter-x', 2);
    const grind = wrecks(internal).length - heavy;
    expect(grind).toBeGreaterThanOrEqual(2);
    expect(heavy).toBeGreaterThan(grind);
  }, 25_000);

  it('a bolt or a shell fired through a wreck piece hits it and does not pass', async () => {
    const internal = await boot(true);
    internal.spawnTestDrone('bb', 6000, 0, 'battleship');
    await harness.advance(100);
    internal.applyDamage('bb', 'shooter-x', 1e7);
    const big = wrecks(internal).sort((a, b) => b.radius - a.radius)[0]!;
    for (const weapon of ['laser', 'naval_m'] as const) {
      const st = internal.wreckState(big.id)!;
      // Where a +x ray through the piece's centre first meets the wreck
      // (this piece or a neighbour); the target sits past the piece.
      const far = big.radius + 2000;
      const enter = internal.rayHit(st.x - far, st.y, 1, 0, 2 * far, 'nobody');
      expect(internal.swarmRegistry.get(enter!.id)?.kind, 'the ray meets a wreck piece').toBe(WRECK_KIND);
      // A beam stops there too: nothing past it is reported.
      const x0 = st.x - far + enter!.dist - 300;
      const x1 = st.x + big.radius + 150;
      // Behind the piece, and (positive control) the same shot in the clear.
      const hidden = `hidden-${weapon}`;
      const clear = `clear-${weapon}`;
      internal.spawnTestDrone(hidden, x1, st.y, 'fighter');
      internal.spawnTestDrone(clear, x1, st.y + 40_000, 'fighter');
      const hidden0 = internal.swarmHealth.get(hidden)!;
      const clear0 = internal.swarmHealth.get(clear)!;
      internal.spawnTestProjectile('shooter-x', x0, st.y, 4000, 0, weapon, 30);
      internal.spawnTestProjectile('shooter-x', x0, st.y + 40_000, 4000, 0, weapon, 30);
      await harness.advance(3000);
      expect(internal.swarmHealth.get(clear), `${weapon} reaches a target in the clear`).toBeLessThan(clear0);
      expect(internal.swarmHealth.get(hidden), `${weapon} stops at the wreck`).toBe(hidden0);
    }
  }, 25_000);

  it('a ship ramming a wreck piece collides with it', async () => {
    const internal = await boot(true);
    internal.spawnTestDrone('bb', 6000, 0, 'battleship');
    await harness.advance(100);
    internal.applyDamage('bb', 'shooter-x', 1e7);
    const big = wrecks(internal).sort((a, b) => b.radius - a.radius)[0]!;
    const st = internal.wreckState(big.id)!;
    // A fighter aimed at the piece's centre, starting just short of the
    // wreck's surface on that line (this piece or a neighbour in front of it).
    const far = big.radius + 2000;
    const enter = internal.rayHit(st.x - far, st.y, 1, 0, 2 * far, 'nobody')!;
    const x0 = st.x - far + enter.dist - 250;
    internal.spawnTestDrone('rammer', x0, st.y, 'fighter');
    await harness.advance(50);
    internal.postToWorker({ type: 'SET_POSITION', entityId: 'rammer', x: x0, y: st.y, angle: 0, vx: 600, vy: 0, angvel: 0 });
    const isWreck = (id: unknown): boolean => typeof id === 'string' && internal.swarmRegistry.get(id)?.kind === WRECK_KIND;
    await harness.events.waitFor({
      tag: 'collision_resolved',
      where: (d) => (d['aId'] === 'rammer' && isWreck(d['bId'])) || (d['bId'] === 'rammer' && isWreck(d['aId'])),
    }, { timeoutMs: 8000 });
  }, 25_000);

  it("a player capital's death also fractures", async () => {
    const internal = await boot(true, { pilotCapitals: true });
    const victim = randomUUID();
    await harness.connectActive(victim, { shipKind: 'battleship', spawnX: 8000, spawnY: 0 });
    await harness.advance(100);
    // The shield takes the first hit whole (no spill-over); the second kills.
    internal.applyDamage(victim, 'shooter-x', 1e9);
    internal.applyDamage(victim, 'shooter-x', 1e9);
    expect(wrecks(internal).length).toBeGreaterThanOrEqual(2);
  }, 25_000);

  it('with the flag off a capital dies exactly as today: no wreck bodies', async () => {
    const internal = await boot(false);
    internal.spawnTestDrone('bb', 6000, 0, 'battleship');
    await harness.advance(100);
    internal.applyDamage('bb', 'shooter-x', 1e7);
    expect(internal.swarmRegistry.get('bb')).toBeFalsy();
    expect(wrecks(internal)).toHaveLength(0);
  }, 25_000);
});
