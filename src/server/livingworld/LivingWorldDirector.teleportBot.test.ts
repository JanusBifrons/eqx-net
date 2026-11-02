/**
 * v4 T3 — a teleporter carries a director-owned bot to another sector. The
 * director moves it (despawn here, spawn there at the pad pose with its
 * carry) and records the new sector, so its own bookkeeping never goes stale.
 * A bot it doesn't own, or one mid-hop, is refused (the caller leaves it).
 */
import { describe, expect, it } from 'vitest';
import { LivingWorldDirector } from './LivingWorldDirector.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { BotRecord, HunterBotPool } from './director/HunterBotPool.js';
import { makeSeededRng } from './population.js';
import { Bus } from '../../core/events/Bus.js';

interface Spawn { botId: string; sectorKey: string; x: number; y: number }

function room(sectorKey: string, spawns: Spawn[], despawned: string[]): LivingWorldRoom {
  const bus = new Bus();
  return {
    eventBus: () => bus,
    playerCount: () => 0,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: (spec) => { spawns.push({ botId: spec.botId, sectorKey, x: spec.x, y: spec.y }); return true; },
    despawnLivingWorldBot: (botId) => {
      despawned.push(`${sectorKey}:${botId}`);
      return { kind: 'fighter', x: 0, y: 0, vx: 1, vy: 2, angle: 0, angvel: 0, health: 40 } as never;
    },
    markBotHostile: () => {},
    getBotPose: () => null,
    setBotMoveTarget: () => {},
    setBotFlockFollow: () => {},
    setBotFlockLeaderCourse: () => {},
    factionBaseReadiness: () => [],
    setFactionUnderWave: () => {},
    markSquadHostileToFaction: () => {},
    purgeFactionHostility: () => {},
    broadcastWarpWarning: () => {},
    broadcastWarpWarningClear: () => {},
  };
}

describe('LivingWorldDirector.teleportBot (v4 T3)', () => {
  it('moves its own active bot and records the new sector; refuses anything else', () => {
    const spawns: Spawn[] = [];
    const despawned: string[] = [];
    const rooms = new Map<string, LivingWorldRoom>([
      ['greenfall', room('greenfall', spawns, despawned)],
      ['verdance', room('verdance', spawns, despawned)],
    ]);
    const d = new LivingWorldDirector(rooms, {
      botCount: 8, controlIntervalMs: 1_000_000, initialStaggerMs: 0, shedRecoveryMs: 0,
      rng: makeSeededRng(3), nowMs: () => 0,
    });
    d.start();
    try {
      const pool = (d as unknown as { pool: HunterBotPool }).pool;
      (d as unknown as { respawnStep(n: number): void }).respawnStep(1000);
      const rec = [...(pool.values() as IterableIterator<BotRecord>)].find((r) => r.state === 'active')!;
      expect(rec).toBeDefined();
      const from = rec.sectorKey;
      const to = from === 'greenfall' ? 'verdance' : 'greenfall';
      spawns.length = 0;

      expect(d.teleportBot(rec.botId, from, to, 1300, -40)).toBe(true);
      expect(despawned).toContain(`${from}:${rec.botId}`);
      expect(spawns).toEqual([{ botId: rec.botId, sectorKey: to, x: 1300, y: -40 }]);
      expect(rec.sectorKey).toBe(to);

      // Wrong source sector, or a bot it doesn't own: refused.
      expect(d.teleportBot(rec.botId, from, to, 0, 0)).toBe(false);
      expect(d.teleportBot('hauler-x', to, from, 0, 0)).toBe(false);
    } finally {
      d.stop();
    }
  });
});
