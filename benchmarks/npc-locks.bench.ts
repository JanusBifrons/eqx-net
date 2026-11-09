/**
 * NPC lock step cost (fire control, lock-to-fire universal). Every connected
 * pilot is now tracked, so `NpcLockSubsystem.step` (every 6 server ticks,
 * 10 Hz) walks every hostile NPC for every pilot: O(drones × pilots). The
 * fake room mirrors SectorRoom's `forEachHostileNpc` (a scan of the whole
 * swarm per pilot) with every drone hostile and in reach, so this is the
 * worst case. Budget: src/server/CLAUDE.md (Thresholds → NPC lock step).
 */
import { bench, describe } from 'vitest';
import { NpcLockSubsystem, type NpcPose } from '../src/server/rooms/NpcLockSubsystem.js';
import { getShipKind } from '../src/shared-types/shipKinds.js';

function subsystem(drones: number, pilots: number): NpcLockSubsystem {
  const pilotIds: string[] = [];
  const pilotPos = new Map<string, NpcPose>();
  for (let p = 0; p < pilots; p++) {
    const id = `p${p}`;
    pilotIds.push(id);
    pilotPos.set(id, { x: p * 150, y: 0, vx: 0, vy: 0 });
  }
  const droneIds: string[] = [];
  const dronePos = new Map<string, NpcPose>();
  for (let i = 0; i < drones; i++) {
    const id = `d${i}`;
    droneIds.push(id);
    dronePos.set(id, { x: (i % 10) * 40, y: 200 + Math.floor(i / 10) * 40, vx: 0, vy: 0 });
  }
  const fighter = getShipKind('fighter');
  const pilotKind = getShipKind('interceptor');
  return new NpcLockSubsystem({
    pilots: () => pilotIds,
    pilotPose: (id, out) => {
      const p = pilotPos.get(id)!;
      out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy;
      return pilotKind;
    },
    forEachHostileNpc: (_pid, visit) => {
      for (let i = 0; i < droneIds.length; i++) visit(droneIds[i]!, i);
    },
    npcPose: (id, out) => {
      const p = dronePos.get(id)!;
      out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy;
      return fighter;
    },
  });
}

describe('NpcLockSubsystem.step (every pilot tracked)', () => {
  for (const [drones, pilots] of [[25, 1], [25, 4], [56, 4], [56, 10]] as const) {
    const s = subsystem(drones, pilots);
    s.step(); // first step creates the entries
    bench(`${drones} hostile drones × ${pilots} pilots`, () => { s.step(); });
  }
});
