/**
 * Capital destruction S2a (docs/architecture/capital-destruction.md §S2): a
 * dying capital breaks into wreck pieces that are solid bodies on the server.
 * Behind the `capitalWrecks` room option, ON by default since 2026-11-14
 * (owner: "land it switched on"); `capitalWrecks: false` opts a room out.
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
import { cutDirFromAngle, fracturePlan } from '../../../src/core/destruction/fractureHull.js';
import { wreckPieceGeometry } from '../../../src/core/destruction/wreckPieces.js';
import { shipShapeScale } from '../../../src/core/geometry/shipHullOutline.js';
import { HEAVY_BEAM_WIDTH, WEAPONS } from '../../../src/core/combat/WeaponCatalogue.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';
import { BEAM_CUT_BUFFER } from '../../../src/shared-types/shipScale/destruction.js';

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

  it('an NPC capital killed with the flag on leaves N ≥ 2 wreck bodies tiling its hull, holding together, then parting away from the kill point', async () => {
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
      // Holds together for the crack delay: the hull's own velocity (at rest
      // + ω×r ≈ 0), no push yet.
      expect(Math.hypot(st.vx - at.vx, st.vy - at.vy)).toBeLessThan(1);
    }
    expect(Math.abs(total - want) / want).toBeLessThan(0.005);
    // After WRECK_CRACK_MS the pieces part. The kicks are impulses against
    // each piece's mass (`wreckBreakKicks`): the cracks push neighbours both
    // ways (momentum kept), the blast throws the wreck as a whole AWAY from
    // the kill point. Mass ∝ area (one density).
    await harness.advance(WRECK_CRACK_MS + 300);
    let px = 0, py = 0, cx = 0, cy = 0, m = 0;
    for (const r of ps) {
      const st = internal.wreckState(r.id)!;
      let a = 0;
      for (const part of internal.wreckParts(r.id)!) a += area(part);
      px += a * (st.vx - at.vx); py += a * (st.vy - at.vy); cx += a * st.x; cy += a * st.y; m += a;
    }
    expect(px * (cx / m - hit.x) + py * (cy / m - hit.y), 'the wreck moves away from the kill point').toBeGreaterThan(0);
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
      // Clear this weapon's targets: wreck pieces are heavy and barely drift
      // (knockScale 0.003), so the next weapon's targets spawn a few units
      // from these and its shot would hit whichever fighter is first.
      internal.evictSwarm(hidden);
      internal.evictSwarm(clear);
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
    // 100 u short: a coasting fighter sheds its speed within ~150 u since the
    // arcade handling tune (owner 2026-11-13: "make it more like micro machines").
    const x0 = st.x - far + enter.dist - 100;
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
    // applyDamage reports true on the killing call only.
    expect(internal.applyDamage(victim, 'shooter-x', 1e9)).toBe(false);
    expect(internal.applyDamage(victim, 'shooter-x', 1e9)).toBe(true);
    expect(wrecks(internal).length).toBeGreaterThanOrEqual(2);
    // The wreck names its pilot: the client's pieces wear the livery bake the
    // live hull wore (owner = playerId), never a new one.
    expect(internal.wreckDescriptors().find((d) => d.parentKind === 'battleship')?.owner).toBe(victim);
    expect(internal.applyDamage(victim, 'shooter-x', 1e9)).toBe(false);
  }, 25_000);

  it('applyDamage returns true only on the call that destroys an NPC capital', async () => {
    const internal = await boot(true);
    internal.spawnTestDrone('bb', 6000, 0, 'battleship');
    await harness.advance(100);
    internal.swarmHealth.set('bb', 100);
    // A chip that leaves it alive, a hit with point + direction + weapon that
    // kills it, then a hit on the gone hull.
    expect(internal.applyDamage('bb', 'shooter-x', 10)).toBe(false);
    expect(internal.applyDamage('bb', 'shooter-x', 1e7, 6000, 0, 1, 0, 'naval_l')).toBe(true);
    expect(internal.swarmRegistry.get('bb')).toBeFalsy();
    expect(internal.applyDamage('bb', 'shooter-x', 1e7)).toBe(false);
  }, 25_000);

  it('a killCut slice kill: the descriptor carries the shot direction in the hull frame and the pieces split straight along the shot', async () => {
    // No weapon has a kill cut yet: give the laser one for this test only.
    const laser = WEAPONS.get('laser')!;
    const had = 'killCut' in laser;
    const prev = laser.killCut;
    laser.killCut = { kind: 'slice' };
    try {
      const internal = await boot(true);
      internal.setWreckSeed(shatterSeed());
      expect(internal.spawnTestDrone('bb', 6000, 0, 'battleship')).toBe(true);
      await harness.advance(100);
      const at = internal.wreckState('bb')!;
      const hit = worldHull('battleship', at.x, at.y, at.angle)[4]!;
      // A shot from outside the hull through the hit point toward the centre.
      const len = Math.hypot(at.x - hit.x, at.y - hit.y);
      const dir = { x: (at.x - hit.x) / len, y: (at.y - hit.y) / len };
      expect(internal.applyDamage('bb', 'shooter-x', 1e7, hit.x, hit.y, dir.x, dir.y, 'laser')).toBe(true);
      const desc = internal.wreckDescriptors().find((d) => d.parentKind === 'battleship')!;
      expect(desc.cutKind).toBe('slice');
      expect(desc.cutW).toBeUndefined();
      // The shot in the hull's math-up frame (turned back by the hull's angle),
      // then Pixi-up (y flipped): the angle the descriptor must carry.
      const c = Math.cos(at.angle);
      const sn = Math.sin(at.angle);
      const hx = dir.x * c + dir.y * sn;
      const hy = -dir.x * sn + dir.y * c;
      const got = cutDirFromAngle(desc.cutAng!);
      expect(got.x * hx + got.y * -hy).toBeGreaterThan(Math.cos(0.002));

      // Rebuild the pieces from the descriptor (what a client does): a cut
      // edge runs dead straight along the shot through the kill point,
      // across the whole hull. The same wreck without the cut does not.
      const s = shipShapeScale(getShipKind('battleship'));
      const k = { x: desc.killX * s, y: -desc.killY * s };
      const d = { x: hx, y: hy };
      const dist = (p: V): number => (p.x - k.x) * -d.y + (p.y - k.y) * d.x;
      const onShotLine = (cut: boolean): number => {
        const inputs = {
          kindId: 'battleship' as const, seed: desc.seed, killX: desc.killX, killY: desc.killY,
          killBlowDamage: desc.killBlowDamage, recentDamageRate: desc.recentDamageRate, snapChance: desc.snapChance,
          ...(cut ? { cutKind: desc.cutKind, cutAng: desc.cutAng } : {}),
        };
        let total = 0;
        for (const g of wreckPieceGeometry(inputs)) {
          let run = 0;
          for (let i = 0; i < g.outline.length; i++) {
            if (!g.cutEdges[i]) continue;
            const a = g.outline[i]!;
            const b = g.outline[(i + 1) % g.outline.length]!;
            const pa = { x: a.x + g.cx, y: a.y + g.cy };
            const pb = { x: b.x + g.cx, y: b.y + g.cy };
            // 2 u: the u16 angle's quantisation over the hull's beam.
            if (Math.abs(dist(pa)) < 2 && Math.abs(dist(pb)) < 2) run += Math.hypot(pb.x - pa.x, pb.y - pa.y);
          }
          total += run;
        }
        return total;
      };
      // The chord of the hull along that line (math-up, scaled frame).
      const hull = shipShapeToPolygon(getShipKind('battleship'));
      const ts: number[] = [];
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i]!;
        const b = hull[(i + 1) % hull.length]!;
        const da = dist(a);
        const db = dist(b);
        if ((da < 0) === (db < 0)) continue;
        const f = da / (da - db);
        ts.push((a.x + (b.x - a.x) * f - k.x) * d.x + (a.y + (b.y - a.y) * f - k.y) * d.y);
      }
      ts.sort((p, q) => p - q);
      const chord = ts[ts.length - 1]! - ts[0]!;
      // Every cut edge is on two pieces: the whole chord, counted twice.
      expect(onShotLine(true)).toBeGreaterThan(1.9 * chord);
      expect(onShotLine(false)).toBeLessThan(0.5 * chord);
    } finally {
      if (had) laser.killCut = prev; else delete laser.killCut;
    }
  }, 25_000);

  it('a heavy_beam kill slices the wreck; a fighter beam or a bolt kill does not', async () => {
    // The catalogue's own records (no test-only killCut): only the capital
    // heavy beam slices (plan beam-slices §8, owner: "heavy means only the
    // new capital heavy beam").
    const internal = await boot(true);
    internal.setWreckSeed(shatterSeed());
    const seen = new Set<number>();
    const killWith = async (id: string, weaponId: 'heavy_beam' | 'hitscan' | 'laser') => {
      for (const d of internal.wreckDescriptors()) seen.add(d.wreckId);
      // Each hull well clear of the last one's wreck.
      expect(internal.spawnTestDrone(id, 6000 + 4000 * seen.size, 0, 'battleship')).toBe(true);
      await harness.advance(100);
      const at = internal.wreckState(id)!;
      const hit = worldHull('battleship', at.x, at.y, at.angle)[4]!;
      const len = Math.hypot(at.x - hit.x, at.y - hit.y);
      expect(internal.applyDamage(id, 'shooter-x', 1e7, hit.x, hit.y, (at.x - hit.x) / len, (at.y - hit.y) / len, weaponId)).toBe(true);
      // This kill's descriptor: the one wreck id not seen before (copied, the
      // subsystem reuses its list).
      const fresh = internal.wreckDescriptors().filter((d) => !seen.has(d.wreckId));
      expect(fresh.length).toBe(1);
      return { ...fresh[0]! };
    };
    const sliced = await killWith('bb-heavy', 'heavy_beam');
    expect(sliced.cutKind).toBe('slice');
    expect(sliced.cutAng).toBeDefined();
    // v13: its slice burns a gap the beam's width plus BEAM_CUT_BUFFER (hull 1x frame).
    expect(sliced.cutW).toBe((HEAVY_BEAM_WIDTH + BEAM_CUT_BUFFER) / shipShapeScale(getShipKind('battleship')));
    for (const [id, w] of [['bb-beam', 'hitscan'], ['bb-bolt', 'laser']] as const) {
      const plain = await killWith(id, w);
      expect(plain.cutKind, w).toBeUndefined();
      expect(plain.cutAng, w).toBeUndefined();
    }
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
