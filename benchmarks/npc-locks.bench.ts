/**
 * NPC lock step cost (fire control, lock-to-fire universal). Every connected
 * pilot is now tracked, so `NpcLockSubsystem.step` (every 6 server ticks,
 * 10 Hz) walks every hostile NPC for every pilot: O(drones × pilots). The
 * fake room mirrors SectorRoom's `forEachHostileNpc` (a scan of the whole
 * swarm per pilot) with every drone hostile, so this is the worst case.
 *
 * Since locks work at any distance (owner 2026-11-14) every hostile pair
 * completes its lock math wherever the pilot is, and the hostility refresh
 * runs a fire-range test (`mountsReachTarget`) per pair: the "far" rows put
 * every pilot 20 km out (before: rejected by reach at once), the capital rows
 * use a battleship (many mounts). Budget: src/server/CLAUDE.md (Thresholds →
 * NPC lock step), 0.1 ms per step.
 */
import { bench, describe } from 'vitest';
import { NpcLockSubsystem, type NpcPose } from '../src/server/rooms/NpcLockSubsystem.js';
import { getShipKind } from '../src/shared-types/shipKinds.js';

function subsystem(drones: number, pilots: number, pilotOffset = 0, npcKind = 'fighter'): NpcLockSubsystem {
  const pilotIds: string[] = [];
  const pilotPos = new Map<string, NpcPose>();
  for (let p = 0; p < pilots; p++) {
    const id = `p${p}`;
    pilotIds.push(id);
    pilotPos.set(id, { x: p * 150, y: pilotOffset, vx: 0, vy: 0 });
  }
  const droneIds: string[] = [];
  const dronePos = new Map<string, NpcPose>();
  for (let i = 0; i < drones; i++) {
    const id = `d${i}`;
    droneIds.push(id);
    dronePos.set(id, { x: (i % 10) * 40, y: 200 + Math.floor(i / 10) * 40, vx: 0, vy: 0 });
  }
  const npc = getShipKind(npcKind);
  const pilotKind = getShipKind('interceptor');
  const counter = { refreshes: 0 };
  return new NpcLockSubsystem({
    pilots: () => pilotIds,
    pilotPose: (id, out) => {
      const p = pilotPos.get(id)!;
      out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy; out.angle = 0;
      return pilotKind;
    },
    forEachHostileNpc: (_pid, visit) => {
      for (let i = 0; i < droneIds.length; i++) visit(droneIds[i]!, i);
    },
    npcPose: (id, out) => {
      const p = dronePos.get(id)!;
      out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy; out.angle = 0;
      return npc;
    },
    refreshHostility: () => { counter.refreshes++; },
  });
}

describe('NpcLockSubsystem.step (every pilot tracked)', () => {
  for (const [drones, pilots] of [[25, 1], [25, 4], [56, 4], [56, 10]] as const) {
    const s = subsystem(drones, pilots);
    s.step(); // first step creates the entries
    bench(`${drones} hostile drones × ${pilots} pilots`, () => { s.step(); });
  }
  for (const [drones, pilots] of [[56, 4], [56, 10]] as const) {
    const s = subsystem(drones, pilots, 20_000);
    s.step();
    bench(`far: ${drones} hostile drones × ${pilots} pilots 20 km out`, () => { s.step(); });
  }
  for (const off of [0, 20_000]) {
    const s = subsystem(8, 10, off, 'battleship');
    s.step();
    bench(`capitals: 8 battleships × 10 pilots${off ? ' 20 km out' : ''}`, () => { s.step(); });
  }
});
