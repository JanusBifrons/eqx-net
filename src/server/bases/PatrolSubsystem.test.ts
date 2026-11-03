import { describe, expect, it } from 'vitest';
import { PATROL_ENGAGE_RANGE, PATROL_RESPAWN_MS, PATROL_WAYPOINT_MARGIN, PatrolSubsystem } from './PatrolSubsystem.js';

const BOX = { x0: -500, x1: 500, y0: -400, y1: 400 };

function rig() {
  const poses = new Map<string, { x: number; y: number }>();
  const moves = new Map<string, { x: number; y: number }>();
  const hostile: Array<[string, string]> = [];
  const pilots: Array<{ id: string; x: number; y: number; hostile: boolean }> = [];
  const sub = new PatrolSubsystem({
    spawn: (id, x, y) => { poses.set(id, { x, y }); return true; },
    poseOf: (id, out) => {
      const p = poses.get(id);
      if (!p) return false;
      out.x = p.x; out.y = p.y;
      return true;
    },
    moveTo: (id, x, y) => moves.set(id, { x, y }),
    markHostile: (id, pid) => hostile.push([id, pid]),
    forEachPilot: (cb) => { for (const p of pilots) cb(p.id, p.x, p.y); },
    isHostileToOwner: (pid) => pilots.find((p) => p.id === pid)?.hostile === true,
  });
  sub.addBase('s-mil', 'npc:core:mil', 'core', BOX, 0, 0, 3);
  return { sub, poses, moves, hostile, pilots };
}

describe('PatrolSubsystem (v4 M2)', () => {
  it('spawns the squad outside the fence, each at a different corner, flying for the owner', () => {
    const { sub, poses } = rig();
    const m = PATROL_WAYPOINT_MARGIN;
    expect([...poses.values()]).toEqual([
      { x: BOX.x0 - m, y: BOX.y0 - m },
      { x: BOX.x1 + m, y: BOX.y0 - m },
      { x: BOX.x1 + m, y: BOX.y1 + m },
    ]);
    for (const id of poses.keys()) {
      expect(sub.factionOf(id)).toBe('core');
      expect(id.startsWith('patrol-')).toBe(true);
    }
  });

  it('flies to the next corner on arrival', () => {
    const { sub, poses, moves } = rig();
    const id = [...poses.keys()][0]!;
    sub.tick(0);
    // It sits on corner 0, so it heads for corner 1.
    expect(moves.get(id)).toEqual({ x: BOX.x1 + PATROL_WAYPOINT_MARGIN, y: BOX.y0 - PATROL_WAYPOINT_MARGIN });
  });

  it('engages a hostile pilot near the base; leaves neutral or distant pilots alone', () => {
    const { sub, hostile, pilots } = rig();
    pilots.push({ id: 'neutral', x: 100, y: 0, hostile: false });
    pilots.push({ id: 'far', x: PATROL_ENGAGE_RANGE + 10, y: 0, hostile: true });
    sub.tick(0);
    expect(hostile).toEqual([]);
    pilots.push({ id: 'raider', x: 200, y: 200, hostile: true });
    sub.tick(1000);
    expect(hostile.map(([, p]) => p)).toEqual(['raider', 'raider', 'raider']);
  });

  it('a lost ship comes back after the respawn delay', () => {
    const { sub, poses } = rig();
    const id = [...poses.keys()][1]!;
    poses.delete(id);
    sub.tick(1000);
    expect(poses.has(id)).toBe(false);
    sub.tick(1000 + PATROL_RESPAWN_MS - 1);
    expect(poses.has(id)).toBe(false);
    sub.tick(1000 + PATROL_RESPAWN_MS);
    expect(poses.has(id)).toBe(true);
  });
});
