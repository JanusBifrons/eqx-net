/**
 * Owner decision 2026-11-15, "Hit by its width": the capital heavy beam is
 * drawn `HEAVY_BEAM_WIDTH` (60 u) wide but hit-tested as a thin centre line,
 * so a near miss visibly covered a small ship and passed through it. Now
 * anything the drawn beam covers is hit and the beam stops on it.
 *
 * Through a real SectorRoom: a beam fired down a line whose CENTRE passes
 * 20 u outside a frigate's hit shape (its shield bubble) goes through the
 * room's own beam sinks (`AiFireResolver.hitscan` → `nonPlayerRayHit`, and
 * `PlayerFireResolver.hitscan`'s swarm pass) via the weapon flyweight, so the
 * width comes from the catalogue record. The heavy beam hits the frigate and
 * its `laser_fired` ends at the first contact of the beam's edge; the
 * fighter beam (no width) on the same line still misses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages.js';
import { HEAVY_BEAM_WIDTH, type WeaponId } from '../../../src/core/combat/WeaponCatalogue.js';
import { getWeaponObject, type WeaponFireContext, type WeaponFireSink } from '../../../src/core/combat/weapons/index.js';
import { shipBubbleRadius } from '../../../src/core/combat/shipHitShape.js';

interface Sink extends WeaponFireSink {
  deps: {
    broadcast: (type: string, msg: LaserFiredEvent) => void;
    applyDamage: (targetId: string, shooterId: string, damage: number, ...rest: unknown[]) => boolean | void;
    snapshotRing?: { getPoseAt: (id: string, tick: number) => { x: number; y: number } | null | undefined };
  };
  [k: string]: unknown;
}
interface RoomInternals {
  aiFireResolver: Sink;
  playerFireResolver: Sink;
  swarmRegistry: { all: () => Iterable<{ id: string; entityId: number; shipKind?: string | null }> };
}

const MISS_BY = 20; // centre line passes this far outside the frigate's bubble
const HW = HEAVY_BEAM_WIDTH / 2;

describe('SectorRoom integration — the heavy beam hits by its width (owner 2026-11-15)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('a heavy beam whose centre misses a frigate by 20 u hits it and stops on it; a fighter beam misses', { timeout: 15_000 }, async () => {
    expect(MISS_BY).toBeLessThan(HW);
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], lockTimeCapS: 0, traverseTicksCap: 0,
      dronePoses: [
        { kind: 'battlecruiser-lance', x: -9000, y: -9000, angle: 0 },
        // One frigate per beam sink, so one sink's hits don't drop the
        // other's target shield (its hit shape would turn to the hull).
        { kind: 'missile-frigate', x: 8000, y: 8000, angle: 0 },
        { kind: 'missile-frigate', x: 8000, y: -8000, angle: 0 },
      ],
    });
    const pid = randomUUID();
    await harness.connectActive(pid, { shipKind: 'fighter', initialHull: 1_000_000, startHostile: false });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const r = room as unknown as RoomInternals;
    let lanceId = '', lanceWire = '';
    const frigates: Array<{ id: string; wire: string }> = [];
    for (const rec of r.swarmRegistry.all()) {
      if (rec.shipKind === 'battlecruiser-lance') { lanceId = rec.id; lanceWire = `swarm-${rec.entityId}`; }
      if (rec.shipKind === 'missile-frigate') frigates.push({ id: rec.id, wire: `swarm-${rec.entityId}` });
    }
    expect(lanceId).not.toBe('');
    expect(frigates.length).toBe(2);
    const frigateFor = (sinkName: 'ai' | 'player') => frigates[sinkName === 'ai' ? 0 : 1]!;
    const R = shipBubbleRadius('missile-frigate');

    const fired: LaserFiredEvent[] = [];
    const hits: string[] = [];
    for (const sink of [r.aiFireResolver, r.playerFireResolver]) {
      const ob = sink.deps.broadcast.bind(sink.deps);
      sink.deps.broadcast = (type, msg) => { if (type === 'laser_fired') fired.push(msg); ob(type, msg); };
      const od = sink.deps.applyDamage.bind(sink.deps);
      sink.deps.applyDamage = (targetId, shooterId, damage, ...rest) => { hits.push(targetId); return od(targetId, shooterId, damage, ...rest); };
    }

    /** The frigate where each sink tests it: the live pose (AI beams), or
     *  the lag-comp ring's pose at the fire tick (player beams). */
    const poseFor = (sinkName: 'ai' | 'player') => {
      const id = frigateFor(sinkName).id;
      const live = room._internals.swarmPose(id)!;
      if (sinkName === 'ai') return live;
      return r.playerFireResolver.deps.snapshotRing!.getPoseAt(id, room._internals.serverTick) ?? live;
    };
    /** Fire `weapon` through `sink` along +x, 300 u short of the frigate,
     *  `lateral` u off its centre (read per shot, so its drift doesn't matter). */
    const fire = (sinkName: 'ai' | 'player', weapon: WeaponId, lateral: number) => {
      const p = poseFor(sinkName);
      const ctx: WeaponFireContext = { fromX: p.x - 300, fromY: p.y + lateral, dirX: 1, dirY: 0, shooterVx: 0, shooterVy: 0, mountId: 'test' };
      fired.length = 0;
      hits.length = 0;
      const sink = sinkName === 'ai' ? r.aiFireResolver : r.playerFireResolver;
      if (sinkName === 'ai') {
        Object.assign(sink, { _shooterId: lanceId, _wireShooterId: lanceWire, _weaponId: weapon, _passDebris: false, _shotKilled: false });
      } else {
        Object.assign(sink, {
          _shooterId: pid, _effTick: room._internals.serverTick, _weaponId: weapon, _damageMul: 1,
          _bestHitId: null, _bestHitDist: Infinity, _bestHitDamage: 0, _bestHitWireId: undefined,
        });
      }
      getWeaponObject(weapon).resolveFire(ctx, sink);
      expect(fired.length, `${sinkName} ${weapon}: one laser_fired`).toBe(1);
      return { ev: fired[0]!, hit: hits.includes(frigateFor(sinkName).id), ctx, p };
    };

    for (const sinkName of ['ai', 'player'] as const) {
      // Sanity: dead centre, the fighter beam hits.
      expect(fire(sinkName, 'hitscan', 0).hit, `${sinkName}: fighter beam dead centre`).toBe(true);

      // The centre line passes 20 u outside the bubble.
      const thin = fire(sinkName, 'hitscan', R + MISS_BY);
      expect(thin.hit, `${sinkName}: the fighter beam (no width) misses`).toBe(false);
      expect(thin.ev.targetId).toBeUndefined();

      const wide = fire(sinkName, 'heavy_beam', R + MISS_BY);
      expect(wide.hit, `${sinkName}: the heavy beam's width covers the frigate, so it is hit`).toBe(true);
      expect(wide.ev.hit).toBe(true);
      expect(wide.ev.targetId).toBe(frigateFor(sinkName).wire);
      // It stops on it: the end is where the beam's edge first touched the bubble.
      const contactX = wide.p.x - Math.sqrt((R + HW) ** 2 - (R + MISS_BY) ** 2);
      expect(wide.ev.toX, `${sinkName}: laser_fired ends at the first contact`).toBeCloseTo(contactX, 1);
      expect(wide.ev.toY).toBeCloseTo(wide.ctx.fromY, 3);

      // Past the half-width the heavy beam misses too.
      expect(fire(sinkName, 'heavy_beam', R + HW + 5).hit, `${sinkName}: past the half-width`).toBe(false);
    }
  });
});
