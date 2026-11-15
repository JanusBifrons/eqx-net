/**
 * RTS Part B slice 3 — an owned ship's trigger is its AI pilot's trigger.
 *
 * An owned hull flown by the AI pilot brain (`HostileDroneBehaviour`, players
 * side) fires through the PLAYER pipeline (`wingmanLocks` → `tickHull` →
 * `PlayerFireResolver.fireHull`), but only while the brain holds the trigger
 * (its `intent.fire`, routed by the `{ hull: true }` registration), and each
 * barrel holds while a friendly is on its line (the AI pilots' one
 * `LineOfFireGate`, which now also sees players' ships).
 *
 * 1. Locked on a target the brain would not shoot at (the nose 0.175 rad off
 *    a small target: outside the fixed gun's hull cone, inside the player
 *    pipeline's bearing window): no shot. Nose on: it fires.
 * 2. Another player's ship on the line to the target: no shot. Ship moves
 *    off the line: it fires.
 *
 * The hull is a Havok (fixed forward hitscan guns, so the brain's aim
 * tolerance is the target's hull cone) and the target a robot cube (small:
 * at 320 u its cone is ~0.14 rad, the player window 0.2). The hull's brain
 * keys are zeroed (it decides, but cannot turn or move) and the cube's brain
 * is idle, so the geometry holds still.
 *
 * Failing first: before this slice the hull fired whenever its lock was
 * complete and a barrel bore, so both "no shot" phases fired.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { AiEntity, AiIntent, AiWorldView, IAiBehaviour } from '../../../src/core/contracts/IAiBehaviour.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages/combatMessages.js';

const TARGET = 'trigger-target';
const RANGE = 320;

describe('SectorRoom integration — owned ship trigger discipline (RTS Part B slice 3)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  const room = (): SectorRoom => harness.getServerRoom()! as unknown as SectorRoom;

  /** Park a Havok at the origin; its AI pilot decides but holds still. The
   *  owner's client counts the hull's beams (`laser_fired`). */
  async function parkHull(): Promise<{ sid: string; angle: number; shots: () => number }> {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'havok', spawnX: 0, spawnY: 0, instantLock: true });
    let n = 0;
    const state = room().state as SectorState;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    expect(sid).not.toBe('');
    client.onMessage('laser_fired', (m: LaserFiredEvent) => { if (m.shooterId === sid) n++; });
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    const internals = room()._internals;
    expect(internals.fleet.isAttached(sid)).toBe(true);
    // Aggressive engages the robot on sight (slice 6); the default Defensive only hits back.
    internals.fleet.setStance(pid, [sid], 'aggressive');
    const brain = internals.aiBrainOf(sid)!;
    const decide = brain.tick.bind(brain);
    brain.tick = (self: AiEntity, view: AiWorldView): AiIntent => {
      const intent = decide(self, view);
      if (intent.input !== undefined) intent.input = 0;
      return intent;
    };
    await harness.advance(300);
    return { sid, angle: internals.lingeringPoseCache.get(sid)!.angle, shots: () => n };
  }

  /** An idle robot cube (on-sight hostile to the players side) at bearing
   *  `angle`, `RANGE` out. */
  function spawnTarget(angle: number): void {
    const internals = room()._internals;
    expect(internals.spawnTestDrone(TARGET, -Math.sin(angle) * RANGE, Math.cos(angle) * RANGE, 'robot-square')).toBe(true);
    const idle: AiIntent = { fx: 0, fy: 0, torque: 0 };
    (internals.aiBrainOf(TARGET) as IAiBehaviour).tick = () => idle;
  }

  function moveTarget(angle: number): void {
    room()._internals.postToWorker({
      type: 'SET_POSITION', entityId: TARGET,
      x: -Math.sin(angle) * RANGE, y: Math.cos(angle) * RANGE, angle: 0, vx: 0, vy: 0, angvel: 0,
    });
  }

  /** Wait until the hull's lock on the target is complete. */
  async function waitLocked(sid: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const g = room()._internals.locksOf(sid);
      if (g?.some((grp) => grp.l.some((l) => l.s === 2))) return;
      await harness.advance(100);
    }
    throw new Error('the hull never locked its target');
  }

  it('locked on a target its pilot would not shoot (nose outside the hull cone): no shot; nose on: fires', async () => {
    const { sid, angle, shots } = await parkHull();
    spawnTarget(angle + 0.175);
    await waitLocked(sid);
    expect(room()._internals.aiBrainOf(sid)!.getTargetId?.()).toBe(TARGET);
    await harness.advance(1500);
    expect(shots(), 'locked, barrel inside the pipeline window, but the pilot holds').toBe(0);

    moveTarget(angle);
    let fired = 0;
    for (let i = 0; i < 20 && fired === 0; i++) {
      await harness.advance(100);
      fired = shots();
    }
    expect(fired, 'nose on the target: the pilot pulls the trigger').toBeGreaterThan(0);
  }, 60_000);

  it('another player\'s ship on the line holds the shot; off the line, it fires', async () => {
    const { sid, angle, shots } = await parkHull();
    // A bystander pilot's ship halfway down the line of fire.
    const qid = randomUUID();
    await harness.connectActive(qid, { shipKind: 'fighter', spawnX: -Math.sin(angle) * RANGE * 0.5, spawnY: Math.cos(angle) * RANGE * 0.5 });
    await harness.advance(200);
    spawnTarget(angle);
    await waitLocked(sid);
    await harness.advance(1500);
    expect(shots(), 'a friendly ship on the line: the pilot holds fire').toBe(0);

    room()._internals.postToWorker({
      type: 'SET_POSITION', entityId: qid, x: 900, y: -900, angle: 0, vx: 0, vy: 0, angvel: 0,
    });
    let fired = 0;
    for (let i = 0; i < 20 && fired === 0; i++) {
      await harness.advance(100);
      fired = shots();
    }
    expect(fired, 'the line is clear: it fires').toBeGreaterThan(0);
  }, 60_000);
});
