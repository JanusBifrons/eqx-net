/**
 * Flagship escorts guard round the flagship, not round a fixed pocket
 * (owner 2026-11-15: "Leash, but the zone follows the flagship"). The
 * director anchors each escort's guard post to the flagship
 * (`setBotGuardPost(…, anchorId)`), so the AI pilot brain measures its guard
 * zone from the flagship's live pose every tick.
 *
 * Scenario: the flagship spawns on its gate pocket's rim (a pocket radius
 * from the old fixed post's centre) and heads further out; a robot (on-sight hostile to the drone side through the allegiance
 * stance table, no new rule) sits next to the escorts but OUTSIDE the old
 * fixed pocket. An escort engages it.
 *
 * Failing first: with the escorts posted on the fixed pocket (the director
 * before this change) the robot is outside every escort's guard radius and
 * nobody engages it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { escortRing, FlagshipDirector, FLEET_ESCORT_KINDS } from '../../../src/server/livingworld/FlagshipDirector.js';
import type { LivingWorldRoom } from '../../../src/server/livingworld/LivingWorldRoom.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { sectorSites } from '../../../src/core/galaxy/sectorSites.js';

const A = 'sol-prime';
const LEAD = 'flagship-0-lead';
const ROBOT = 'robot-attacker';

describe('SectorRoom integration — flagship escorts guard round the moving flagship', () => {
  let h: LivingWorldTestHarness | undefined;
  let d: FlagshipDirector | undefined;
  afterEach(async () => {
    d?.stop();
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('an escort engages an attacker next to the moved flagship that is outside the old fixed pocket', { timeout: 90_000 }, async () => {
    h = await bootLivingWorldTestServer({ sectors: [A], botCount: 0, seed: 5, solarSectors: true } as never);
    const sector = h.getRoom(A) as unknown as SectorRoom;
    const room = sector as unknown as LivingWorldRoom;
    const rooms = new Map<string, LivingWorldRoom>([[A, room]]);
    const clock = { now: 1_000_000 };
    d = new FlagshipDirector(rooms, { powers: ['core'], holderOf: () => 'core', rng: () => 0.42, nowMs: () => clock.now, dwellMs: 600_000 });
    d.start();
    // Small clock steps: the director re-posts and re-stations every control
    // tick but never wanders the flagship (45 s) or moves the fleet.
    const control = (): void => { clock.now += 100; d!.tick(clock.now); };
    control();

    const pocketId = d.state().fleets[0]!.pocketId;
    const pocket = sectorSites(A).find((s) => s.id === pocketId)!;
    const lead0 = room.getBotPose(LEAD)!;
    // Out from the pocket centre, through where the flagship spawned (its rim).
    const d0 = Math.hypot(lead0.x - pocket.x, lead0.y - pocket.y);
    const ux = (lead0.x - pocket.x) / d0, uy = (lead0.y - pocket.y) / d0;

    // The flagship moves further out.
    room.setBotFlockLeaderCourse(LEAD, lead0.x + ux * 3000, lead0.y + uy * 3000);
    for (let i = 0; i < 6; i++) { await h.advance(500); control(); }
    const lead = room.getBotPose(LEAD)!;
    // A capital turns and builds speed slowly: it is still about on the rim,
    // a whole pocket radius from the old fixed post's centre.
    expect(Math.hypot(lead.x - pocket.x, lead.y - pocket.y), 'the flagship is out on the rim').toBeGreaterThan(pocket.r * 0.9);

    // The attacker: beside the escort farthest out, inside the zone round the
    // flagship, outside the old fixed pocket.
    const fleet = d.fleetsView()[0]!;
    let spot: { x: number; y: number } | null = null;
    let best = -Infinity;
    for (let i = 0; i < FLEET_ESCORT_KINDS.length; i++) {
      const e = room.getBotPose(`flagship-0-e${i}`);
      if (!e) continue;
      const de = Math.hypot(e.x - pocket.x, e.y - pocket.y);
      const sx = e.x + ((e.x - pocket.x) / de) * 400, sy = e.y + ((e.y - pocket.y) / de) * 400;
      const zone = escortRing(fleet.kind, FLEET_ESCORT_KINDS[i]!) + pocket.r;
      if (Math.hypot(sx - lead.x, sy - lead.y) > zone * 0.9) continue;
      if (de > best) { best = de; spot = { x: sx, y: sy }; }
    }
    expect(spot, 'an escort sits where an attacker can be inside the zone round the flagship').not.toBeNull();
    expect(Math.hypot(spot!.x - pocket.x, spot!.y - pocket.y), 'the attacker is outside the old fixed pocket').toBeGreaterThan(pocket.r + 300);

    expect(sector._internals.spawnTestDrone(ROBOT, spot!.x, spot!.y, 'robot-square')).toBe(true);
    // Hold the robot there and keep it from opening fire, so what an escort
    // does is its own on-sight choice, not a retaliation.
    room.setBotGuardPost?.(ROBOT, spot!.x, spot!.y, 0);
    sector._internals.aiBrainOf(ROBOT)?.setEngageOnSight?.(false);

    const escortOnRobot = (): boolean => {
      for (let i = 0; i < FLEET_ESCORT_KINDS.length; i++) {
        const b = sector._internals.aiBrainOf(`flagship-0-e${i}`);
        if (b instanceof HostileDroneBehaviour && b.getTargetId() === ROBOT) return true;
      }
      return false;
    };
    let engaged = false;
    for (let i = 0; i < 20 && !engaged; i++) {
      await h.advance(250);
      engaged = escortOnRobot();
      if (i % 4 === 3) control();
    }
    expect(engaged, 'no escort engaged an attacker inside the zone round the flagship').toBe(true);
  });
});
