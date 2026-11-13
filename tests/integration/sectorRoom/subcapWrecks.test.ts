/**
 * Sub-capital break-up slice 2 (plan `subcapital-breakup.md`; story in
 * docs/architecture/capital-destruction.md "Sub-capital profile"): with the
 * `subcapWrecks` room option on, every polygon sub-capital that dies leaves
 * 2-3 wreck pieces through the SAME wreck system as a capital, driven by its
 * destruction profile: no crack hold, a gentle push, pieces that ignore each
 * other, and damping that brings them to rest so Rapier puts them to SLEEP
 * (owner 2026-11-13: "They should drift to a stop with some friction and
 * then they'll go to sleep in the physics engine and shouldn't be too
 * expensive"). Pieces are permanent; a separate FIFO cap never evicts a
 * capital piece. Composite kinds (havok) keep their scrap.
 *
 * Drives the real chain: a projectile (or applyDamage with a hull point) →
 * DamageRouter → the drone death policy → `spawnScrapFromDrone` → the wreck
 * subsystem → SwarmSpawner.spawnWreck → the physics worker, whose sleep poll
 * sets FLAG_SLEEPING in the SAB (read by `_internals.swarmSleeping`).
 *
 * The room runs at game speed 4 (`timeScale`) so 20 game seconds take 5 s of
 * wall time; settle times below are GAME seconds (server ticks / 60).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type ShipKindId } from '../../../src/shared-types/shipKinds.js';
import { shipScrapGroups } from '../../../src/core/geometry/shipScrapGroups.js';
import { shipShapeToPolygon } from '../../../src/core/geometry/shipHullDecomp.js';

const WRECK_KIND = 4;
const SCRAP_KIND = 3;
const SPEED = 4;
/** The owner's target: a piece settles and sleeps within ~10-20 s. */
const SLEEP_WITHIN_GAME_S = 20;

describe('SectorRoom integration — sub-capital wrecks (sub-cap break-up slice 2)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  type Internals = SectorRoom['_internals'];
  async function boot(opts: { subcapWrecks?: boolean; capitalWrecks?: boolean }): Promise<() => Internals> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      timeScale: SPEED, ...opts,
    });
    await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: -40_000, spawnY: -40_000 });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    return () => room._internals;
  }

  function byKind(internal: Internals, kind: number) {
    return [...internal.swarmRegistry.all()].filter((r) => r.kind === kind);
  }

  /** A point on the ship's hull outline (world space), for a hit with a point. */
  function hullPoint(kindId: ShipKindId, x: number, y: number, angle: number): { x: number; y: number } {
    const v = shipShapeToPolygon(getShipKind(kindId))[0]!;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: x + v.x * c - v.y * s, y: y + v.x * s + v.y * c };
  }

  /** Poll until every piece reports FLAG_SLEEPING; returns game seconds from
   *  the death (server ticks / 60), or Infinity past the deadline. */
  async function secondsToSleep(int: () => Internals, ids: readonly string[], deathTick: number, maxGameS: number): Promise<number> {
    for (;;) {
      const i = int();
      const elapsed = (i.serverTick - deathTick) / 60;
      if (ids.every((id) => i.swarmSleeping(id) === true)) return elapsed;
      if (elapsed > maxGameS) return Infinity;
      await harness.advance(100);
    }
  }

  it('a fighter killed by a real shot leaves 2-3 permanent pieces that come to rest and SLEEP', async () => {
    const int = await boot({ subcapWrecks: true });
    expect(int().spawnTestDrone('f1', 3000, 0, 'fighter')).toBe(true);
    await harness.advance(100);
    const at = int().wreckState('f1')!;
    // A heavy bolt from 600 u to the left, straight at it.
    int().spawnTestProjectile('shooter-x', at.x - 600, at.y, 4000, 0, 'laser', 1e6);
    for (let t = 0; t < 40 && int().swarmRegistry.get('f1'); t++) await harness.advance(50);
    expect(int().swarmRegistry.get('f1'), 'the shot killed the fighter').toBeFalsy();
    const deathTick = int().serverTick;

    const pieces = byKind(int(), WRECK_KIND);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces.length).toBeLessThanOrEqual(3);
    for (const p of pieces) expect(p.shipKind).toBe('fighter');
    // One descriptor for the wreck, same transport as a capital's.
    const desc = int().wreckDescriptors().filter((d) => d.parentKind === 'fighter');
    expect(desc).toHaveLength(1);
    expect(int().wreckCounts().subcap).toBe(pieces.length);

    const ids = pieces.map((p) => p.id);
    const s = await secondsToSleep(int, ids, deathTick, 30);
    console.log(`[subcap-sleep] fighter (real shot, at rest): ${pieces.length} pieces asleep after ${s.toFixed(1)} game s`);
    expect(s).toBeLessThan(SLEEP_WITHIN_GAME_S);
    // Permanent: still there, asleep, and the resting SAB pose holds (the
    // worker skips reading/writing a body that stays asleep).
    const rest = int().wreckState(ids[0]!)!;
    await harness.advance(500);
    for (const id of ids) {
      expect(int().swarmRegistry.get(id)?.kind).toBe(WRECK_KIND);
      expect(int().swarmSleeping(id)).toBe(true);
    }
    const still = int().wreckState(ids[0]!)!;
    expect(Math.hypot(still.x - rest.x, still.y - rest.y)).toBeLessThan(1e-3);

    // Overkill knock-back wakes a sleeping piece and moves it; its SAB record
    // follows again (the quiet skip never freezes a woken body).
    // A real bolt (the projectile path passes the shot's direction) from the
    // left at the piece's centre; it stops on the first piece in its path.
    const before = ids.map((id) => int().wreckState(id)!);
    int().spawnTestProjectile('shooter-x', rest.x - 600, rest.y, 4000, 0, 'laser', 1e6);
    await harness.advance(150);
    const woke = ids.findIndex((id, i) => int().swarmSleeping(id) === false && int().wreckState(id)!.x > before[i]!.x);
    expect(woke, 'the hit piece woke and moved along the shot').toBeGreaterThanOrEqual(0);
  }, 30_000);

  /** World polygons of a piece (its body-local convex parts at its SAB pose). */
  function piecePolys(int: Internals, id: string): Array<Array<{ x: number; y: number }>> {
    const st = int.wreckState(id)!;
    const c = Math.cos(st.angle);
    const s = Math.sin(st.angle);
    return int.wreckParts(id)!.map((part) => part.map((p) => ({ x: st.x + p.x * c - p.y * s, y: st.y + p.x * s + p.y * c })));
  }

  function segDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /** Least distance between two pieces' outlines (0 if they touch or overlap). */
  function pieceGap(a: Array<Array<{ x: number; y: number }>>, b: Array<Array<{ x: number; y: number }>>): number {
    const inside = (p: { x: number; y: number }, poly: Array<{ x: number; y: number }>): boolean => {
      let sign = 0;
      for (let i = 0; i < poly.length; i++) {
        const q = poly[i]!, r = poly[(i + 1) % poly.length]!;
        const cr = (r.x - q.x) * (p.y - q.y) - (r.y - q.y) * (p.x - q.x);
        if (cr === 0) continue;
        const sg = cr > 0 ? 1 : -1;
        if (sign === 0) sign = sg; else if (sg !== sign) return false;
      }
      return true;
    };
    let best = Infinity;
    for (const pa of a) for (const pb of b) {
      for (const [x, y] of [[pa, pb], [pb, pa]] as const) {
        for (const p of x) {
          if (inside(p, y)) return 0;
          for (let i = 0; i < y.length; i++) best = Math.min(best, segDist(p, y[i]!, y[(i + 1) % y.length]!));
        }
      }
    }
    return best;
  }

  /**
   * Round-2 hostile review (2026-11-13): "robot pieces touching about 1 s
   * after the break; fighter wreckage still reads as a whole fighter". The
   * profile's push runs away from the kill point, so it moved the pieces off
   * together; the cracks only opened at the capital seam speed (1.4 % of the
   * radius a second). On the real server, killed at rest by hits round the
   * hull (one ship per hit point, killed on the same tick), every pair of a
   * wreck's pieces must stand clearly apart 1 game s later (~1/3 of the hull
   * radius), and still come to rest and sleep (tests below). With the old
   * seam speed a missile frigate's narrowest gap was ~0.08 radii.
   */
  for (const kind of ['fighter', 'robot-hexagon', 'missile-frigate'] as const) {
    it(`a ${kind}'s pieces stand clearly apart 1 s after the break, wherever it was hit`, async () => {
      const int = await boot({ subcapWrecks: true });
      const outline = shipShapeToPolygon(getShipKind(kind));
      const HITS = 4;
      for (let h = 0; h < HITS; h++) expect(int().spawnTestDrone(`g${h}`, 3000 + h * 2000, 0, kind)).toBe(true);
      await harness.advance(100);
      const wrecks: string[][] = [];
      for (let h = 0; h < HITS; h++) {
        const at = int().wreckState(`g${h}`)!;
        const v = outline[Math.floor((h * outline.length) / HITS)]!;
        const c = Math.cos(at.angle), s = Math.sin(at.angle);
        const before = new Set(byKind(int(), WRECK_KIND).map((p) => p.id));
        int().applyDamage(`g${h}`, 'shooter-x', 1e7, at.x + v.x * c - v.y * s, at.y + v.x * s + v.y * c);
        const ids = byKind(int(), WRECK_KIND).map((p) => p.id).filter((id) => !before.has(id));
        expect(ids.length).toBeGreaterThanOrEqual(2);
        wrecks.push(ids);
      }
      const deathTick = int().serverTick;
      while (int().serverTick - deathTick < 60) await harness.advance(20);
      const elapsed = (int().serverTick - deathTick) / 60;
      const r = getShipKind(kind).radius;
      let least = Infinity;
      for (const ids of wrecks) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) least = Math.min(least, pieceGap(piecePolys(int(), ids[i]!), piecePolys(int(), ids[j]!)));
        }
      }
      console.log(`[subcap-gap] ${kind}: narrowest gap over ${HITS} hit points ${least.toFixed(1)} u = ${(least / r).toFixed(2)} radii after ${elapsed.toFixed(2)} game s`);
      expect(elapsed).toBeLessThan(1.3);
      expect(least / r, `${kind}: narrowest gap after ~1 s, in hull radii`).toBeGreaterThanOrEqual(0.25);
    }, 20_000);
  }

  // A ship killed at speed and turning: the pieces inherit its motion and
  // must drift to a stop under the profile's damping, then sleep.
  for (const kind of ['fighter', 'missile-frigate', 'robot-hexagon'] as const) {
    it(`a ${kind} killed at full speed and turning settles and sleeps within ${SLEEP_WITHIN_GAME_S} game s`, async () => {
      const int = await boot({ subcapWrecks: true });
      expect(int().spawnTestDrone('v', 3000, 0, kind)).toBe(true);
      await harness.advance(100);
      const k = getShipKind(kind);
      const at0 = int().wreckState('v')!;
      int().postToWorker({ type: 'SET_POSITION', entityId: 'v', x: at0.x, y: at0.y, angle: 0.3, vx: k.maxSpeed, vy: 0, angvel: 2 });
      await harness.advance(60);
      const at = int().wreckState('v')!;
      const hit = hullPoint(kind, at.x, at.y, at.angle);
      int().applyDamage('v', 'shooter-x', 1e7, hit.x, hit.y);
      const deathTick = int().serverTick;
      expect(int().swarmRegistry.get('v')).toBeFalsy();
      const pieces = byKind(int(), WRECK_KIND);
      expect(pieces.length).toBeGreaterThanOrEqual(2);
      expect(pieces.length).toBeLessThanOrEqual(3);
      // No crack hold: the parting is in the spawn motion, no pending kick.
      expect(Math.hypot(at.vx, at.vy)).toBeGreaterThan(k.maxSpeed * 0.5);
      const s = await secondsToSleep(int, pieces.map((p) => p.id), deathTick, 30);
      console.log(`[subcap-sleep] ${kind} at ${k.maxSpeed} u/s, 2 rad/s: ${pieces.length} pieces asleep after ${s.toFixed(1)} game s`);
      expect(s).toBeLessThan(SLEEP_WITHIN_GAME_S);
    }, 30_000);
  }

  it('the sub-cap cap evicts the OLDEST sub-cap piece and never a capital piece', async () => {
    const int = await boot({ subcapWrecks: true, capitalWrecks: true });
    int().spawnTestDrone('bb', 0, 20_000, 'battleship');
    await harness.advance(100);
    int().applyDamage('bb', 'shooter-x', 1e7);
    const capital = byKind(int(), WRECK_KIND).map((r) => r.id);
    expect(capital.length).toBeGreaterThanOrEqual(2);

    int().setSubcapWreckCap(4);
    const order: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const id = `f${i}`;
      int().spawnTestDrone(id, 4000 + i * 1500, 0, 'fighter');
      await harness.advance(50);
      const before = new Set(byKind(int(), WRECK_KIND).map((r) => r.id));
      int().applyDamage(id, 'shooter-x', 1e7);
      order.push(byKind(int(), WRECK_KIND).map((r) => r.id).filter((x) => !before.has(x)));
    }
    const live = new Set(byKind(int(), WRECK_KIND).map((r) => r.id));
    // Every capital piece survived four fighters' worth of debris.
    for (const id of capital) expect(live.has(id), `capital piece ${id}`).toBe(true);
    // The sub-cap FIFO is at its cap, and what went was the oldest.
    expect(int().wreckCounts().subcap).toBe(4);
    const subLive = [...live].filter((id) => !capital.includes(id));
    expect(subLive).toHaveLength(4);
    const newest = order[3]!;
    for (const id of newest) expect(live.has(id), `newest piece ${id}`).toBe(true);
    expect(order[0]!.some((id) => !live.has(id)), 'the first fighter lost a piece first').toBe(true);
    // Descriptors follow the evictions (a wreck with no piece left is gone).
    const parents = int().wreckDescriptors().map((d) => d.parentKind);
    expect(parents.filter((p) => p === 'battleship')).toHaveLength(1);
  }, 30_000);

  it('with the flag off a fighter dies exactly as today: no pieces', async () => {
    const int = await boot({ subcapWrecks: false, capitalWrecks: true });
    int().spawnTestDrone('f1', 3000, 0, 'fighter');
    await harness.advance(100);
    int().applyDamage('f1', 'shooter-x', 1e7);
    expect(int().swarmRegistry.get('f1')).toBeFalsy();
    expect(byKind(int(), WRECK_KIND)).toHaveLength(0);
    expect(int().wreckCounts().total).toBe(0);
  }, 20_000);

  it('a havok keeps its scrap (one per component), with the flag on: no wreck pieces', async () => {
    const int = await boot({ subcapWrecks: true });
    int().spawnTestDrone('h', 3000, 0, 'havok');
    await harness.advance(100);
    int().applyDamage('h', 'shooter-x', 1e7);
    expect(int().swarmRegistry.get('h')).toBeFalsy();
    expect(byKind(int(), WRECK_KIND)).toHaveLength(0);
    // Its components (a loot pod is scrap kind too, parent 'cargo-pod').
    expect(byKind(int(), SCRAP_KIND).filter((r) => r.shipKind === 'havok')).toHaveLength(shipScrapGroups('havok').length);
  }, 20_000);
});
