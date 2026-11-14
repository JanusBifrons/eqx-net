/**
 * No formation flying behind a slower target (owner decisions 2026-11-13/14:
 * "no toe-to-toe slugging"; fights are dogfights, always moving).
 *
 * Before: Tail's close station sat 0.1 × fire range (~3 own radii) behind
 * the target and was reached at the target's speed, so a fighter tailing a
 * pilot cruising at ~93 u/s settled at 92–94 u and matched it 93/93 u/s for
 * ~4 s, trading fire at point blank (filmed showcase melee, 2026-11-14).
 *
 * Scene: one NPC fighter 700 u behind a pilot who holds ~90 u/s straight
 * ahead (scripted thrust on / off; its AUTO guns still shoot back), 30 s.
 *  - no formation hold: the longest continuous run inside 6 own radii is
 *    ≤ 4 s and the share of samples inside 6 radii ≤ 20 % (before: 16.9 s
 *    on end, 56 % of samples);
 *  - it keeps moving: speed > 40 % of its cruise on ≥ 90 % of samples;
 *  - it still shoots (hits on the pilot).
 * Passes are logged, not gated: a fighter (sustained ~141–160 u/s) barely
 * outruns a 90 u/s pilot, so it closes from behind at 35–60 u/s.
 * The ship flies only with player controls (virtual pilot).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MANOEUVRE_COUNT } from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';

const SAMPLE_MS = 50;
const WINDOW_MS = 30_000;
const PILOT_SPEED = 90;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
    playerPose: (pid: string) => { x: number; y: number; angle: number } | null;
    swarmHealth: Map<string, number>;
  };
  shipPoseCache: Map<string, { vx: number; vy: number }>;
  aiController: { getBehaviour(id: string): unknown };
  applyDamage: (t: string, s: string, ...rest: unknown[]) => void;
}

describe('SectorRoom integration — no formation flying behind a slower target', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('a fighter on a pilot cruising at ~90 u/s: no formation hold, always moving (30 s)', { timeout: 90_000 }, async () => {
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
    const client = await harness.connectActive(pilot, { startHostile: true, initialHull: 1_000_000, initialShield: 1_000_000 });
    const room = harness.getServerRoom()! as unknown as Room;
    const rec = [...room._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'fighter')!;
    expect(rec).toBeTruthy();
    const npc = rec.id;
    room._internals.swarmHealth.set(npc, 1e9);
    const brain = room.aiController.getBehaviour(npc) as HostileDroneBehaviour;
    brain.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
    const R = brain.getFireRange();
    const cruise = brain.getCruiseSpeed();
    const radius = (brain as unknown as { kind: { radius: number } }).kind.radius;

    let hits = 0;
    const origDmg = room.applyDamage.bind(room);
    room.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
      if (t === pilot && s === npc) hits++;
      origDmg(t, s, ...rest);
    };

    // The pilot holds ~90 u/s along its nose: thrust on below it, off above.
    let thrusting = false;
    const steer = (): number => {
      const v = room.shipPoseCache.get(pilot);
      const sp = v ? Math.hypot(v.vx, v.vy) : 0;
      const want = sp < PILOT_SPEED;
      if (want !== thrusting) {
        thrusting = want;
        client.send('input', { type: 'input', tick: 0, thrust: want, turnLeft: false, turnRight: false });
      }
      return sp;
    };

    // Get the pilot up to speed and let the fight start.
    for (let i = 0; i < 40; i++) { steer(); await harness.advance(SAMPLE_MS); }
    const hist = new Array<number>(MANOEUVRE_COUNT).fill(0);
    let samples = 0, moving = 0, passes = 0, armed = true, pilotSp = 0;
    let minD = Infinity, closeMs = 0, maxCloseMs = 0, under100Ms = 0, maxUnder100Ms = 0, formMs = 0, maxFormMs = 0, under6r = 0;
    let prev = room._internals.swarmPose(npc)!;
    let prevT = Date.now();
    const t0 = prevT;
    while (Date.now() - t0 < WINDOW_MS) {
      pilotSp += steer();
      await harness.advance(SAMPLE_MS);
      const p = room._internals.swarmPose(npc);
      const q = room._internals.playerPose(pilot);
      if (!p || !q) break;
      const now = Date.now();
      const dtMs = now - prevT;
      prevT = now;
      const v = Math.hypot(p.x - prev.x, p.y - prev.y) / (dtMs / 1000);
      prev = p;
      samples++;
      if (v > 0.4 * cruise) moving++;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < minD) minD = d;
      closeMs = d < 4 * radius ? closeMs + dtMs : 0;
      if (closeMs > maxCloseMs) maxCloseMs = closeMs;
      under100Ms = d < 100 ? under100Ms + dtMs : 0;
      if (under100Ms > maxUnder100Ms) maxUnder100Ms = under100Ms;
      if (d < 6 * radius) under6r++;
      formMs = d < 6 * radius ? formMs + dtMs : 0;
      if (formMs > maxFormMs) maxFormMs = formMs;
      if (armed && d < 0.25 * R) { passes++; armed = false; }
      else if (!armed && d > 0.5 * R) armed = true;
      hist[brain.getManoeuvre()]!++;
    }
    const movingFrac = moving / Math.max(1, samples);
    console.log(`[slowTargetPasses] R=${R.toFixed(0)} cruise=${cruise.toFixed(0)} radius=${radius.toFixed(0)} pilotSp=${(pilotSp / Math.max(1, samples)).toFixed(0)} samples=${samples} moving=${movingFrac.toFixed(3)} passes=${passes} hits=${hits} minD=${minD.toFixed(0)} maxClose4r=${maxCloseMs}ms maxUnder100=${maxUnder100Ms}ms under6r=${(under6r / Math.max(1, samples)).toFixed(3)} maxForm6r=${maxFormMs}ms manoeuvres=${hist.join(',')}`);
    expect(samples).toBeGreaterThan(100);
    expect(maxFormMs, 'no formation hold: never inside 6 own radii for > 4 s on end').toBeLessThanOrEqual(4000);
    expect(under6r / Math.max(1, samples), 'no formation hold: inside 6 own radii ≤ 20 % of the time').toBeLessThanOrEqual(0.2);
    expect(movingFrac, 'always moving: speed > 40 % cruise').toBeGreaterThanOrEqual(0.9);
    expect(hits, 'it still shoots').toBeGreaterThan(0);
  });
});
