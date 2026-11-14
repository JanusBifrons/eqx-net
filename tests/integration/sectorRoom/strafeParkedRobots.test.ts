/**
 * Robots strafe a parked pilot (owner decision 2026-11-14: against a still
 * target an AI pilot flies strafing runs, "dive in firing, pass, swing round
 * and come again… always moving").
 *
 * Filmed (fleet-melee take 6, 2026-11-14): a Robot Orb (robot-circle) held
 * ~1–1.5 ship lengths off the scripted pilot and crept round it, with no
 * passes and no extending. The pilot looked parked, but the shot's script
 * (`showcase/shots/fleetMelee.ts`) flies at the nearest robot whenever it is
 * over 220 u away and then sits facing it, so each time the Orb drew off it
 * lurched 40–150 u toward it at up to ~220 u/s for ~0.5 s and stopped. Each
 * lurch read as a moving target: the Orb broke off its extend (Break: the
 * pilot came at it from behind), tailed it, braked beside it as it stopped
 * again, and started the next run from a crawl ~130 u off it. Its extends
 * never got past ~4–5 ship lengths and 31 % of the take sat inside 3.
 *
 * Scenes, 30 s each, a Robot Orb (robot-circle, fixed charge laser) and a
 * Robot Cube (robot-square, fixed laser) 700 u off a pilot whose AUTO guns
 * shoot back. Per robot, both scenes:
 *  - no hover: ≤ `MAX_INSIDE_FRAC` of samples inside `HOLD_LENGTHS` own
 *    ship lengths (2 hull radii each), and the longest run inside them at
 *    under `SLOW_FRAC` of its cruise ≤ 1 s;
 *  - no rams (contacts with the pilot).
 * (a) The pilot never touches the stick: strafing runs, so also
 *     ≥ `MIN_PASSES` passes (closest approaches inside `PASS_LENGTHS`
 *     lengths, each re-armed only once it has extended past
 *     `EXTEND_LENGTHS`: dive, pass, extend, swing round, again).
 * (b) The pilot flies the shot's script: it chases each extend in lurches,
 *     so passes and extends are logged, not gated.
 * Both robots together still land hits. The ships fly only with player
 * controls (virtual pilot).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MANOEUVRE_COUNT } from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

const SAMPLE_MS = 50;
const WINDOW_MS = 30_000;
/** "Beside the target": inside this many own ship lengths (2 radii each). */
const HOLD_LENGTHS = 3;
/** "Holding": under this share of the robot's own cruise speed. */
const SLOW_FRAC = 0.4;
const MAX_HOLD_MS = 1000;
/** A pass: a closest approach inside this many lengths… */
const PASS_LENGTHS = 5;
/** …counted again only after the robot extends past this many. */
const EXTEND_LENGTHS = 7;
const MIN_PASSES = 3;
/** Share of samples a robot may spend inside `HOLD_LENGTHS` lengths. */
const MAX_INSIDE_FRAC = 0.1;
/** The shot's pilot (`fleetMelee.ts` → `flyTo(arrive 220, cruise 260,
 *  maxMs 3000, passThrough)` then `face(700 ms)`). */
const NUDGE_ARRIVE = 220;
const NUDGE_CRUISE = 260;
const NUDGE_MAX_MS = 3000;
const NUDGE_FACE_MS = 700;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
    playerPose: (pid: string) => { x: number; y: number; angle: number } | null;
    swarmHealth: Map<string, number>;
  };
  shipPoseCache: Map<string, { vx: number; vy: number }>;
  aiController: { getBehaviour(id: string): unknown };
  bus: { on(e: 'COLLISION_RESOLVED', fn: (p: { aId: string; bId: string; tick: number }) => void): void };
  applyDamage: (t: string, s: string, ...rest: unknown[]) => void;
}

interface Track {
  kind: string;
  id: string;
  brain: HostileDroneBehaviour;
  cruise: number;
  len: number;
  prev: { x: number; y: number };
  samples: number;
  holdMs: number;
  maxHoldMs: number;
  inside: number;
  passes: number;
  armed: boolean;
  farSincePass: number;
  extends: number[];
  hist: number[];
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

describe('SectorRoom integration — robots strafe a parked pilot', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  async function scene(label: string, nudge: boolean): Promise<void> {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      dronePoses: [
        { kind: 'robot-circle', x: -500, y: -500, angle: 0, hullExposed: false },
        { kind: 'robot-square', x: 500, y: -500, angle: 0, hullExposed: false },
      ],
      lockTimeCapS: 0,
      defaultSpawnX: 0,
      defaultSpawnY: 0,
    });
    const pilot = randomUUID();
    const client = await harness.connectActive(pilot, { startHostile: true, initialHull: 1_000_000, initialShield: 1_000_000 });
    const room = harness.getServerRoom()! as unknown as Room;
    const tracks: Track[] = [];
    for (const rec of room._internals.swarmRegistry.all()) {
      if (rec.kind !== 1 || !rec.shipKind?.startsWith('robot')) continue;
      room._internals.swarmHealth.set(rec.id, 1e9);
      const brain = room.aiController.getBehaviour(rec.id) as HostileDroneBehaviour;
      brain.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
      tracks.push({
        kind: rec.shipKind, id: rec.id, brain, cruise: brain.getCruiseSpeed(),
        len: 2 * getShipKind(rec.shipKind).radius, prev: room._internals.swarmPose(rec.id)!,
        samples: 0, holdMs: 0, maxHoldMs: 0, inside: 0, passes: 0, armed: true, farSincePass: 0,
        extends: [], hist: new Array<number>(MANOEUVRE_COUNT).fill(0),
      });
    }
    expect(tracks.map((t) => t.kind).sort()).toEqual(['robot-circle', 'robot-square']);

    const rams = new Map<string, number>();
    const lastContact = new Map<string, number>();
    room.bus.on('COLLISION_RESOLVED', (p) => {
      const other = p.aId === pilot ? p.bId : p.bId === pilot ? p.aId : null;
      if (other === null || !tracks.some((k) => k.id === other)) return;
      if (p.tick - (lastContact.get(other) ?? -1_000) > 30) rams.set(other, (rams.get(other) ?? 0) + 1);
      lastContact.set(other, p.tick);
    });
    let hits = 0;
    const origDmg = room.applyDamage.bind(room);
    room.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
      if (t === pilot && tracks.some((k) => k.id === s)) hits++;
      origDmg(t, s, ...rest);
    };

    // The shot's pilot: fly at where the nearest robot is (thrust while the
    // nose is within 0.6 rad and under NUDGE_CRUISE) until within
    // NUDGE_ARRIVE of that point or NUDGE_MAX_MS, then sit facing it.
    let keys = '';
    let goal: { x: number; y: number } | null = null;
    let phaseEnd = 0;
    let facing = false;
    const send = (thrust: boolean, left: boolean, right: boolean): void => {
      const k = `${thrust}${left}${right}`;
      if (k === keys) return;
      keys = k;
      client.send('input', { type: 'input', tick: 0, thrust, turnLeft: left, turnRight: right });
    };
    const nearest = (q: { x: number; y: number }): { x: number; y: number } | null => {
      let best: { x: number; y: number } | null = null;
      let bd = Infinity;
      for (const t of tracks) {
        const p = room._internals.swarmPose(t.id);
        if (!p) continue;
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < bd) { bd = d; best = { x: p.x, y: p.y }; }
      }
      return best;
    };
    const steer = (nowMs: number): void => {
      if (!nudge) return;
      const q = room._internals.playerPose(pilot);
      const v = room.shipPoseCache.get(pilot);
      if (!q) return;
      const sp = v ? Math.hypot(v.vx, v.vy) : 0;
      if (goal === null || nowMs >= phaseEnd) {
        // Next step of the script's loop: fly at the nearest robot, then face it.
        if (goal !== null && !facing) { facing = true; phaseEnd = nowMs + NUDGE_FACE_MS; }
        else { goal = nearest(q); facing = false; phaseEnd = nowMs + NUDGE_MAX_MS; }
      }
      if (!goal) { send(false, false, false); return; }
      if (!facing && Math.hypot(goal.x - q.x, goal.y - q.y) < NUDGE_ARRIVE) {
        facing = true;
        phaseEnd = nowMs + NUDGE_FACE_MS;
      }
      const aim = facing ? (nearest(q) ?? goal) : goal;
      const diff = wrapPi(Math.atan2(-(aim.x - q.x), aim.y - q.y) - q.angle);
      const thrust = !facing && Math.abs(diff) < 0.6 && sp < NUDGE_CRUISE;
      send(thrust, diff > 0.08, diff < -0.08);
    };

    const tStart = Date.now();
    while (Date.now() - tStart < 1000) { steer(Date.now()); await harness.advance(SAMPLE_MS); }
    for (const t of tracks) t.prev = room._internals.swarmPose(t.id)!;
    let prevT = Date.now();
    const t0 = prevT;
    while (Date.now() - t0 < WINDOW_MS) {
      steer(Date.now());
      await harness.advance(SAMPLE_MS);
      const q = room._internals.playerPose(pilot);
      if (!q) break;
      const now = Date.now();
      const dtMs = now - prevT;
      prevT = now;
      for (const t of tracks) {
        const p = room._internals.swarmPose(t.id);
        if (!p) continue;
        const v = Math.hypot(p.x - t.prev.x, p.y - t.prev.y) / (dtMs / 1000);
        t.prev = p;
        t.samples++;
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        const m = t.brain.getManoeuvre();
        t.hist[m]!++;
        if (process.env.ZZ) console.log(`ZZ ${label} ${t.kind} t=${((now - t0) / 1000).toFixed(2)} m=${m} d=${d.toFixed(0)} v=${v.toFixed(0)}`);
        const near = d < HOLD_LENGTHS * t.len;
        if (near) t.inside++;
        t.holdMs = near && v < SLOW_FRAC * t.cruise ? t.holdMs + dtMs : 0;
        if (t.holdMs > t.maxHoldMs) t.maxHoldMs = t.holdMs;
        if (d > t.farSincePass) t.farSincePass = d;
        if (t.armed && d < PASS_LENGTHS * t.len) {
          // A new pass: the farthest point since the last one was its extend.
          if (t.passes > 0) t.extends.push(t.farSincePass);
          t.passes++;
          t.armed = false;
          t.farSincePass = d;
        } else if (!t.armed && d > EXTEND_LENGTHS * t.len) {
          t.armed = true;
        }
      }
    }
    send(false, false, false);
    for (const t of tracks) {
      const ext = [...t.extends].sort((a, b) => a - b);
      const med = ext.length > 0 ? ext[Math.floor(ext.length / 2)]! / t.len : 0;
      console.log(`[strafeParkedRobots:${label}] ${t.kind} len=${t.len} cruise=${t.cruise.toFixed(0)} samples=${t.samples} rams=${rams.get(t.id) ?? 0} maxSlowHold=${t.maxHoldMs}ms inside${HOLD_LENGTHS}L=${(t.inside / Math.max(1, t.samples)).toFixed(2)} passes=${t.passes} extends(L)=${t.extends.map((e) => (e / t.len).toFixed(1)).join(',')} medianExtend=${med.toFixed(1)}L manoeuvres=${t.hist.join(',')}`);
    }
    console.log(`[strafeParkedRobots:${label}] hits=${hits}`);
    for (const t of tracks) {
      expect(t.samples).toBeGreaterThan(100);
      expect(t.maxHoldMs, `${label} ${t.kind}: held inside ${HOLD_LENGTHS} lengths under ${SLOW_FRAC * 100} % cruise for > 1 s`).toBeLessThanOrEqual(MAX_HOLD_MS);
      expect(t.inside / t.samples, `${label} ${t.kind}: no hover inside ${HOLD_LENGTHS} lengths`).toBeLessThanOrEqual(MAX_INSIDE_FRAC);
      expect(rams.get(t.id) ?? 0, `${label} ${t.kind}: passes go beside the pilot`).toBe(0);
      if (!nudge) expect(t.passes, `${label} ${t.kind}: dive, pass, extend, come again`).toBeGreaterThanOrEqual(MIN_PASSES);
    }
    expect(hits, 'the robots still shoot').toBeGreaterThan(0);
  }

  it('(a) the pilot never touches the stick', { timeout: 90_000 }, async () => {
    await scene('still', false);
  });

  it('(b) the pilot nudges toward the nearest robot, as the filmed script does', { timeout: 90_000 }, async () => {
    await scene('nudge', true);
  });
});
