/**
 * Strafing runs on a parked ship (owner decision 2026-11-14): "Dive in
 * firing, pass, swing round and come again, like a fighter on a ground
 * target. Always moving." Replaces the rule under which a Tail on a parked
 * target put its nose on it and held: the filmed Robot Orb hovered nose-on at
 * ~380 u, creeping, for 20 s.
 *
 * Scene: one NPC fighter 700 u from a pilot who never touches the stick
 * (its AUTO guns still shoot back), 30 s. One strafing cycle (dive, pass,
 * swing round) takes ~11–12 s for a fighter at the default 2x scale, so 30 s
 * is the shortest window that holds three.
 *  - the attacker keeps moving: speed > 40 % of its cruise on ≥ 90 % of
 *    samples (before the change: 10 %, a Tail holding nose-on);
 *  - it flies passes: ≥ 3 closest approaches (inside 0.25 × fire range, then
 *    back out past 0.6 × fire range: a pass and a swing-round);
 *  - the dives shoot: it lands hits on the pilot;
 *  - no rams (contacts between the two).
 * The ship flies only with player controls (virtual pilot).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MANOEUVRE_ATTACK_RUN, MANOEUVRE_COUNT, MANOEUVRE_TAIL } from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';

const SAMPLE_MS = 50;
const WINDOW_MS = 30_000;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
    playerPose: (pid: string) => { x: number; y: number; angle: number } | null;
    swarmHealth: Map<string, number>;
  };
  aiController: { getBehaviour(id: string): unknown };
  bus: { on(e: 'COLLISION_RESOLVED', fn: (p: { aId: string; bId: string; tick: number }) => void): void };
  applyDamage: (t: string, s: string, ...rest: unknown[]) => void;
}

describe('SectorRoom integration — strafing runs on a parked ship', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('a fighter on a parked pilot: always moving, ≥ 3 passes, hits, no rams (30 s)', { timeout: 90_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      dronePoses: [{ kind: 'fighter', x: 0, y: -700, angle: 0, hullExposed: false }],
      lockTimeCapS: 0,
      defaultSpawnX: 0,
      defaultSpawnY: 0,
    });
    const pilot = randomUUID();
    await harness.connectActive(pilot, { startHostile: true, initialHull: 1_000_000, initialShield: 1_000_000 });
    const room = harness.getServerRoom()! as unknown as Room;
    const rec = [...room._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'fighter')!;
    expect(rec).toBeTruthy();
    const npc = rec.id;
    room._internals.swarmHealth.set(npc, 1e9);
    const brain = room.aiController.getBehaviour(npc) as HostileDroneBehaviour;
    brain.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
    const R = brain.getFireRange();
    const cruise = brain.getCruiseSpeed();

    let hits = 0;
    const origDmg = room.applyDamage.bind(room);
    room.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
      if (t === pilot && s === npc) hits++;
      origDmg(t, s, ...rest);
    };
    let rams = 0;
    let lastContact = -1_000;
    room.bus.on('COLLISION_RESOLVED', (p) => {
      const pair = (p.aId === npc && p.bId === pilot) || (p.aId === pilot && p.bId === npc);
      if (!pair) return;
      if (p.tick - lastContact > 30) rams++;
      lastContact = p.tick;
    });

    // Let the first dive start.
    await harness.advance(1000);
    const hist = new Array<number>(MANOEUVRE_COUNT).fill(0);
    let samples = 0, moving = 0, passes = 0, armed = true;
    let minD = Infinity, maxD = 0, pilotDrift = 0;
    const p0 = room._internals.playerPose(pilot)!;
    let prev = room._internals.swarmPose(npc)!;
    let prevT = Date.now();
    const t0 = prevT;
    while (Date.now() - t0 < WINDOW_MS) {
      await harness.advance(SAMPLE_MS);
      const p = room._internals.swarmPose(npc);
      const q = room._internals.playerPose(pilot);
      if (!p || !q) break;
      const now = Date.now();
      const dt = (now - prevT) / 1000;
      prevT = now;
      const v = Math.hypot(p.x - prev.x, p.y - prev.y) / dt;
      prev = p;
      samples++;
      if (v > 0.4 * cruise) moving++;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      pilotDrift = Math.max(pilotDrift, Math.hypot(q.x - p0.x, q.y - p0.y));
      if (armed && d < 0.25 * R) { passes++; armed = false; }
      else if (!armed && d > 0.6 * R) armed = true;
      hist[brain.getManoeuvre()]!++;
    }
    const movingFrac = moving / Math.max(1, samples);
    console.log(`[strafeParked] R=${R.toFixed(0)} cruise=${cruise.toFixed(0)} samples=${samples} moving=${movingFrac.toFixed(3)} passes=${passes} hits=${hits} rams=${rams} minD=${minD.toFixed(0)} maxD=${maxD.toFixed(0)} pilotDrift=${pilotDrift.toFixed(0)} manoeuvres=${hist.join(',')}`);
    expect(samples).toBeGreaterThan(100);
    expect(movingFrac, 'always moving: speed > 40 % cruise').toBeGreaterThanOrEqual(0.9);
    expect(passes, 'dive, pass, swing round, come again').toBeGreaterThanOrEqual(3);
    expect(hits, 'the dives shoot').toBeGreaterThan(0);
    expect(rams, 'passes go beside the target').toBe(0);
    expect(hist[MANOEUVRE_ATTACK_RUN]! / samples, 'strafing runs, not a tail').toBeGreaterThan(0.8);
    expect(hist[MANOEUVRE_TAIL]).toBe(0);
  });
});
