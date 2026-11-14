/**
 * A ship running away still evades (hostile review of the npc-dogfight 3v3
 * clip, 2026-11-14): a damaged fighter whose morale die came up Flee flew dead
 * straight for ~4 s with a hostile one or two ship lengths on its tail, never
 * turning, breaking or boosting, until it blew up. Flee and FallBack are
 * locked morale outcomes (never re-scored), so "tailed => Break" never fired,
 * and both flew a straight course.
 *
 * Scene: a 20 %-hull fighter, its die forced to Flee, with a hostile fighter
 * sitting right behind it. Its hull is topped back up after every hit (hits
 * still land and count, so the brain sees them), and we count the tailer's
 * hits per game tick of the chase (logged). Counts and game ticks only, no wall clock
 * in the measure (the harness advances in real time; the window is ticks).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MANOEUVRE_FLEE } from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

const SAMPLE_MS = 50;
/** Chase window (game ticks, 60 Hz): ~4.5 s, inside Flee's 6 s warp cap. */
const WINDOW_TICKS = 270;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number }> };
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

function wrap(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

describe('SectorRoom integration — a fleeing ship evades its tailer', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('weaves off its escape line, boosts past the reserve, and still gets away', { timeout: 60_000 }, async () => {
    // Me at the origin flying south (angle π: forward (0, -1)); the hostile
    // fighter 250 u behind me (north), nose on my tail.
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      dronePoses: [
        { kind: 'fighter', x: 0, y: 0, angle: Math.PI, hullExposed: false },
        { kind: 'patrol-fighter', x: 0, y: 250, angle: Math.PI, hullExposed: false },
      ],
      defaultSpawnX: 0,
      defaultSpawnY: 9000,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom() as unknown as Room;
    const [me, tailer] = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1).map((r) => r.id) as [string, string];
    const mb = room.aiController.getBehaviour(me) as HostileDroneBehaviour;
    mb.setMoraleRoll(() => MORALE_OUTCOME.Flee);
    (room.aiController.getBehaviour(tailer) as HostileDroneBehaviour).setMoraleRoll(() => MORALE_OUTCOME.FightOn);
    const hull = 0.2 * getShipKind('fighter').maxHealth;
    room._internals.swarmHealth.set(me, hull);
    room._internals.swarmHealth.set(tailer, 1e9);
    // Hits land (the brain sees them) but never kill: the hull is topped back
    // up to 20 % after each, so the chase runs the whole window.
    let hits = 0;
    let counting = false;
    const orig = room.applyDamage.bind(room);
    room.applyDamage = (t: string, src: string, ...rest: unknown[]) => {
      orig(t, src, ...rest);
      if (t === me) {
        if (counting) hits++;
        room._internals.swarmHealth.set(me, hull);
      }
    };
    room.aiController.markHostile(me, tailer, room.serverTick);
    room.aiController.markHostile(tailer, me, room.serverTick);

    // Wait for the die (first decision) to start the Flee.
    let guard = 0;
    while (mb.getManoeuvre() !== MANOEUVRE_FLEE && guard++ < 40) await harness.advance(SAMPLE_MS);
    expect(mb.getManoeuvre(), 'the die forced Flee').toBe(MANOEUVRE_FLEE);

    const start = room.serverTick;
    const boost0 = mb.getBoostTicks();
    const p0 = room._internals.swarmPose(me)!;
    counting = true;
    let prevAngle = p0.angle;
    let turnSum = 0;
    let minOff = 0, maxOff = 0, n = 0, sumGap = 0, maxGap = 0;
    // The escape line: straight away from the tailer at the start.
    const q0 = room._internals.swarmPose(tailer)!;
    const esc = Math.atan2(-(p0.x - q0.x), p0.y - q0.y); // angle whose forward is (-sin, cos)
    while (room.serverTick - start < WINDOW_TICKS) {
      await harness.advance(SAMPLE_MS);
      if (room.botWarpPhase(me) !== 0) break;
      const p = room._internals.swarmPose(me);
      const q = room._internals.swarmPose(tailer);
      if (!p || !q) break;
      n++;
      turnSum += Math.abs(wrap(p.angle - prevAngle));
      prevAngle = p.angle;
      const off = wrap(p.angle - esc);
      minOff = Math.min(minOff, off); maxOff = Math.max(maxOff, off);
      const gap = Math.hypot(p.x - q.x, p.y - q.y);
      sumGap += gap; maxGap = Math.max(maxGap, gap);
    }
    counting = false;
    const ticks = room.serverTick - start;
    const p1 = room._internals.swarmPose(me)!;
    const progress = Math.hypot(p1.x - q0.x, p1.y - q0.y) - Math.hypot(p0.x - q0.x, p0.y - q0.y);
    const boostTicks = mb.getBoostTicks() - boost0;
    const rate = hits / Math.max(1, ticks);
    console.log(`[flee-evade] ticks=${ticks} samples=${n} hits=${hits} hitsPer100t=${(100 * rate).toFixed(2)} turnSum=${turnSum.toFixed(2)}rad off=[${minOff.toFixed(2)}, ${maxOff.toFixed(2)}] boostTicks=${boostTicks} gapAvg=${(sumGap / Math.max(1, n)).toFixed(0)} gapMax=${maxGap.toFixed(0)} progress=${progress.toFixed(0)} manoeuvre=${mb.getManoeuvre()}`);

    // Before the fix (2026-11-14, this scene): turnSum 0.00 rad, heading
    // spread 0.03 rad (dead straight), 178 boost ticks (stopped at the 25 %
    // reserve), progress 395 u, 26 hits. After: turnSum ~3.8 rad, spread
    // ~1.2 rad, ~215 boost ticks, progress ~338 u, 26-27 hits.
    expect(n, 'the chase ran').toBeGreaterThan(30);
    expect(mb.getManoeuvre(), 'still fleeing').toBe(MANOEUVRE_FLEE);
    // It weaves: the nose swings well off the escape line.
    expect(maxOff - minOff, 'heading spread off the escape line (rad)').toBeGreaterThan(0.6);
    expect(turnSum, 'total turning during the run (rad)').toBeGreaterThan(1.5);
    // It burns the afterburner, past the combat reserve, while it runs.
    expect(boostTicks, 'boost ticks (straight run: 178)').toBeGreaterThan(195);
    // It still gets away (net distance gained from where the tailer started).
    expect(progress, 'made progress away').toBeGreaterThan(250);
    // The tailer's hit rate is LOGGED, not gated: at these ranges a bolt
    // (1600 u/s) reaches a 44 u shield bubble in 0.15-0.4 s, and a ship that
    // turns at 1 rad/s (velocity lagging its nose by lateral grip) cannot
    // stray from the shooter's lead by a bubble radius in that time, so every
    // bolt hits whether it weaves or not (measured: 26 vs 26 at a 250 u gap,
    // 25 vs 26 at 600 u).
  });
});
