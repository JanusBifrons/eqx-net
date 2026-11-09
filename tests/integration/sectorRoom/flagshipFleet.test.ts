/**
 * Flagship fleets (wrap-up W2a) in real rooms: a fleet arrives at a gate
 * pocket of a solar-system sector, its escorts flock round the flagship, the
 * whole fleet warps to another pocket (the NPC warp), and a restart resumes it
 * at the pocket it was in. (Never shed: LoadShedder.test.ts.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { escortRing, FlagshipDirector, FLEET_ESCORT_KINDS } from '../../../src/server/livingworld/FlagshipDirector.js';
import type { LivingWorldRoom } from '../../../src/server/livingworld/LivingWorldRoom.js';
import { sectorSites } from '../../../src/core/galaxy/sectorSites.js';

const A = 'sol-prime';
const B = 'vega-reach';

describe('SectorRoom integration — flagship fleets (W2a)', () => {
  let h: LivingWorldTestHarness | undefined;
  let d: FlagshipDirector | undefined;
  afterEach(async () => {
    d?.stop();
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  function poseOf(room: LivingWorldRoom, id: string): { x: number; y: number } {
    return room.getBotPose(id)!;
  }

  it('arrives at a gate pocket with escorts on station round it, warps on, and resumes after a restart', { timeout: 90_000 }, async () => {
    h = await bootLivingWorldTestServer({ sectors: [A, B], botCount: 0, seed: 5, solarSectors: true } as never);
    const rooms = new Map<string, LivingWorldRoom>([
      [A, h.getRoom(A) as unknown as LivingWorldRoom],
      [B, h.getRoom(B) as unknown as LivingWorldRoom],
    ]);
    const room = rooms.get(A)!;
    const clock = { now: 1_000_000 };
    d = new FlagshipDirector(rooms, { firstSector: A, rng: () => 0.42, nowMs: () => clock.now, dwellMs: 60_000 });
    d.start();
    const [fleet] = d.fleetsView();
    expect(fleet?.sectorKey).toBe(A);
    expect(fleet?.escorts).toBe(FLEET_ESCORT_KINDS.length);
    const lead = 'flagship-0-lead';
    const start = poseOf(room, lead);
    const gate = sectorSites(A).filter((s) => s.kind === 'gate').sort((a, b) => Math.hypot(start.x - a.x, start.y - a.y) - Math.hypot(start.x - b.x, start.y - b.y))[0]!;
    expect(Math.hypot(start.x - gate.x, start.y - gate.y)).toBeLessThan(gate.r + 200);

    // Let the escorts flock on the flagship (re-asserted each control tick).
    for (let i = 0; i < 6; i++) { clock.now += 1500; d.tick(clock.now); await h.advance(1000); }
    const at = poseOf(room, lead);
    for (let i = 0; i < FLEET_ESCORT_KINDS.length; i++) {
      const e = poseOf(room, `flagship-0-e${i}`);
      expect(Math.hypot(e.x - at.x, e.y - at.y)).toBeLessThan(escortRing(fleet!.kind, FLEET_ESCORT_KINDS[i]!) + 1500);
    }

    // Dwell over: the whole fleet warps to another (non-gate) pocket.
    clock.now += 61_000;
    d.tick(clock.now);
    // The flagship turns to face the jump first (up to ~20 s for a capital);
    // the director sends the escorts when it is nearly lined up. Tick it on
    // its real cadence meanwhile.
    const end = Date.now() + 45_000;
    let landed: { x: number; y: number } | null = null;
    let sinceTick = 0;
    while (Date.now() < end) {
      await h.advance(250);
      if ((sinceTick += 250) >= 1500) { sinceTick = 0; clock.now += 1500; d.tick(clock.now); }
      const p = poseOf(room, lead);
      const site = sectorSites(A).find((s) => s.kind !== 'gate' && Math.hypot(p.x - s.x, p.y - s.y) < s.r + 300);
      const escortsIn = FLEET_ESCORT_KINDS.every((_, i) => { const e = poseOf(room, `flagship-0-e${i}`); return (room.botWarpPhase?.(`flagship-0-e${i}`) ?? 0) === 0 && Math.hypot(e.x - p.x, e.y - p.y) < escortRing(fleet!.kind, FLEET_ESCORT_KINDS[i]!) + 2000; });
      if (site && escortsIn && (room.botWarpPhase?.(lead) ?? 0) === 0) { landed = p; break; }
    }
    expect(landed).not.toBeNull();
    for (let i = 0; i < FLEET_ESCORT_KINDS.length; i++) {
      const e = poseOf(room, `flagship-0-e${i}`);
      expect(Math.hypot(e.x - landed!.x, e.y - landed!.y)).toBeLessThan(escortRing(fleet!.kind, FLEET_ESCORT_KINDS[i]!) + 2000); // came along, alive
    }

    // Restart: save, tear down, a new director resumes at that pocket.
    const saved = d.state();
    d.stop();
    room.despawnLivingWorldBot(lead);
    for (let i = 0; i < FLEET_ESCORT_KINDS.length; i++) room.despawnLivingWorldBot(`flagship-0-e${i}`);
    d = new FlagshipDirector(rooms, { restore: saved, rng: () => 0.42, nowMs: () => clock.now });
    d.start();
    const [again] = d.fleetsView();
    expect(again?.name).toBe(fleet!.name);
    expect(again?.sectorKey).toBe(A);
    const pocket = sectorSites(A).find((s) => s.id === saved.fleets[0]!.pocketId)!;
    const p = poseOf(room, 'flagship-0-lead');
    expect(Math.hypot(p.x - pocket.x, p.y - pocket.y)).toBeLessThan(pocket.r + 200);
  });
});
