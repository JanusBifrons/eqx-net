/**
 * An AI pilot lights its afterburner to run down a target that pulls away
 * (owner, watching fleet-melee take 10, 2026-11-14: "why doesn't the fighter
 * being followed ever use its boost to catch up and chase down the ship it
 * was fighting?!").
 *
 * Scene: a drone-faction fighter 300 u behind a Traders patrol fighter, both
 * noses north. The patrol fighter's morale die is forced to Flee, so it turns
 * and runs at full speed with boost (and weaves). The fighter tails it. Before
 * the fix Tail only asked for boost beyond 1.5 × fire range, or when the
 * STATION (0.3 × fire range behind the target) was more than half a fire range
 * off, so a runner inside ~670 u was chased at cruise: 0 boost ticks while the
 * target opened the range at up to ~360 u/s (diag, 2026-11-14).
 *
 * Counts and game ticks only (no wall clock in the measure).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MANOEUVRE_FLEE, MANOEUVRE_TAIL } from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

const SAMPLE_MS = 50;
/** Chase window (game ticks): inside Flee's 6 s warp-out cap. */
const WINDOW_TICKS = 300;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
    swarmHealth: Map<string, number>;
  };
  aiController: {
    markHostile(id: string, other: string, tick: number): void;
    getBehaviour(id: string): unknown;
  };
  serverTick: number;
  applyDamage: (t: string, s: string, ...rest: unknown[]) => void;
  botWarpPhase(id: string): number;
}

describe('SectorRoom integration — an AI pilot boosts to run down a runner', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it.each([300, 1100])('a fighter %d u behind a ship that turns and runs boosts and closes the gap', { timeout: 60_000 }, async (start0) => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      dronePoses: [
        { kind: 'fighter', x: 0, y: 0, angle: 0, vx: 0, vy: 250, hullExposed: false },
        { kind: 'patrol-fighter', x: 0, y: start0, angle: 0, vx: 0, vy: 250, hullExposed: false },
      ],
      defaultSpawnX: 0,
      defaultSpawnY: -9000,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom() as unknown as Room;
    const recs = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1);
    const chaser = recs.find((r) => r.shipKind === 'fighter')!.id;
    const runner = recs.find((r) => r.shipKind === 'patrol-fighter')!.id;
    const cb = room.aiController.getBehaviour(chaser) as HostileDroneBehaviour;
    const rb = room.aiController.getBehaviour(runner) as HostileDroneBehaviour;
    cb.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
    rb.setMoraleRoll(() => MORALE_OUTCOME.Flee);
    // The runner at 20 % hull (the die rolls Flee at its first decision); its
    // hull is topped back up after each hit so the chase runs the window.
    const hull = 0.2 * getShipKind('patrol-fighter').maxHealth;
    room._internals.swarmHealth.set(runner, hull);
    room._internals.swarmHealth.set(chaser, 1e9);
    const orig = room.applyDamage.bind(room);
    room.applyDamage = (t: string, src: string, ...rest: unknown[]) => {
      orig(t, src, ...rest);
      if (t === runner) room._internals.swarmHealth.set(runner, hull);
    };
    room.aiController.markHostile(chaser, runner, room.serverTick);
    room.aiController.markHostile(runner, chaser, room.serverTick);

    let guard = 0;
    while (rb.getManoeuvre() !== MANOEUVRE_FLEE && guard++ < 40) await harness.advance(SAMPLE_MS);
    expect(rb.getManoeuvre(), 'the runner runs').toBe(MANOEUVRE_FLEE);

    const fireRange = cb.getFireRange();
    const start = room.serverTick;
    const boost0 = cb.getBoostTicks();
    const gapOf = (): number => {
      const p = room._internals.swarmPose(chaser)!;
      const q = room._internals.swarmPose(runner)!;
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    const gap0 = gapOf();
    let maxGap = gap0;
    let tailSamples = 0;
    let n = 0;
    while (room.serverTick - start < WINDOW_TICKS) {
      await harness.advance(SAMPLE_MS);
      if (room.botWarpPhase(runner) !== 0) break;
      const g = gapOf();
      if (g > maxGap) maxGap = g;
      if (cb.getManoeuvre() === MANOEUVRE_TAIL) tailSamples++;
      n++;
    }
    const gap1 = gapOf();
    const boostTicks = cb.getBoostTicks() - boost0;
    const ticks = room.serverTick - start;
    console.log(`[boost-chase] R=${fireRange.toFixed(0)} ticks=${ticks} samples=${n} tail=${tailSamples} boostTicks=${boostTicks} gap0=${gap0.toFixed(0)} gapMax=${maxGap.toFixed(0)} gap1=${gap1.toFixed(0)} energy=${(cb.getEnergyFrac() * 100).toFixed(0)}%`);

    expect(n, 'the chase ran').toBeGreaterThan(30);
    expect(boostTicks, 'the chaser lights its afterburner').toBeGreaterThan(60);
    // It runs the target down: the gap never opens past where it started (or
    // gun range), ends inside gun range, and a runner already out of gun
    // range is closed on.
    expect(maxGap, 'the runner never pulls away').toBeLessThan(Math.max(gap0 + 50, fireRange));
    expect(gap1, 'gap at the end, inside gun range').toBeLessThan(fireRange);
    if (gap0 > fireRange) expect(gap0 - gap1, 'gap closed from beyond gun range').toBeGreaterThan(150);
  });
});
