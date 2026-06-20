/**
 * HunterBotWarpController — depart/arrive hop + WS-E #13/#15 fixes.
 *
 * These unit tests lock the warp controller's ARRIVE behaviour at the precise
 * seam where two playtest bugs lived:
 *
 *  - #15 (renders neutral on arrival): the arriving member must be marked hostile
 *    INLINE at spawn (the `hostileSpecFor` resolver threaded into
 *    `spawnLivingWorldBot`), not a control-tick later. FAILS today: `arrive`
 *    never consults a hostility resolver.
 *  - #13/#19 (all attackers stack at one edge): a despawned bot's pre-warp world
 *    pose must CARRY to the destination and be clamped, not snap to the squad
 *    edge anchor. FAILS today: `BotCarry` has no x/y and `arrive` always uses
 *    `squadEdgePose`/`sectorEdgePose`.
 *
 * Hand-rolled mock rooms (the gold-standard TransitOrchestrator style): fast,
 * no I/O, no Colyseus. `arrive` is private, so we drive it through the public
 * `depart` + the macrotask timer (hopTravelMs 0 ⇒ arrival fires one microtask
 * later) and assert on what the destination room's `spawnLivingWorldBot`
 * received.
 */
import { describe, it, expect } from 'vitest';
import { HunterBotWarpController } from './HunterBotWarpController.js';
import { HunterBotPool, type BotRecord } from './HunterBotPool.js';
import type { LivingWorldRoom } from '../LivingWorldRoom.js';
import type { BotCarry } from '../botTypes.js';
import { makeSeededRng } from '../population.js';
import { DEFAULT_SHIP_KIND } from '../../../shared-types/shipKinds.js';

type SpawnSpec = Parameters<LivingWorldRoom['spawnLivingWorldBot']>[0];

function makeRoom(
  over: Partial<LivingWorldRoom> & { carry?: BotCarry | null } = {},
): { room: LivingWorldRoom; spawns: SpawnSpec[] } {
  const spawns: SpawnSpec[] = [];
  const room: LivingWorldRoom = {
    eventBus: () => ({}) as never,
    playerCount: () => 0,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: (spec: SpawnSpec): boolean => {
      spawns.push(spec);
      return true;
    },
    despawnLivingWorldBot: () => over.carry ?? ({ kind: DEFAULT_SHIP_KIND, health: 40, vx: 0, vy: 0, angle: 0, angvel: 0 } as BotCarry),
    markBotHostile: () => {},
    factionHostility: (id: string) => ({ playerId: id, structureIds: [`pstruct-${id}`] }),
    factionBaseReadiness: () => [],
    setFactionUnderWave: () => {},
    markSquadHostileToFaction: () => {},
    ...over,
  };
  return { room, spawns };
}

function makePool(): { pool: HunterBotPool; rec: BotRecord } {
  const pool = new HunterBotPool({ botCount: 0, initialStaggerMs: 0, rng: () => 0, nowMs: () => 0 });
  const rec: BotRecord = {
    botId: 'lwbot-0',
    kind: DEFAULT_SHIP_KIND,
    sectorKey: 'src',
    state: 'in-transit',
    respawnAtMs: 0,
    arrivedAtMs: 0,
    controller: null,
  };
  return { pool, rec };
}

/** Drive depart→(timer)→arrive and resolve once the destination spawn fires. */
async function hop(opts: {
  controller: HunterBotWarpController;
  rec: BotRecord;
  from: string;
  to: string;
}): Promise<void> {
  opts.controller.depart(opts.rec, opts.from, opts.to);
  // hopTravelMs 0 ⇒ arrival timer fires on the next macrotask.
  await new Promise((r) => setTimeout(r, 0));
}

describe('HunterBotWarpController.arrive — inline hostility (WS-E #15)', () => {
  it('passes the destination faction hostility spec to spawn when the squad is attacking there', async () => {
    const { pool, rec } = makePool();
    const src = makeRoom();
    const { room: dest, spawns } = makeRoom();
    const rooms = new Map<string, LivingWorldRoom>([['src', src.room], ['dest', dest]]);
    const controller = new HunterBotWarpController({
      rooms,
      pool,
      rng: makeSeededRng(1),
      respawnDelayMs: 100,
      hopTravelMs: 0,
      // The director's resolver: the squad targets faction 'alice' at 'dest'.
      hostileSpecFor: (botId, sectorKey) =>
        sectorKey === 'dest'
          ? { hostileToFaction: { playerId: 'alice', structureIds: ['pstruct-1'] } }
          : {},
    });

    await hop({ controller, rec, from: 'src', to: 'dest' });

    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.hostileToFaction).toEqual({ playerId: 'alice', structureIds: ['pstruct-1'] });
  });

  it('does NOT pass a hostility spec when the resolver returns none (roaming hop)', async () => {
    const { pool, rec } = makePool();
    const src = makeRoom();
    const { room: dest, spawns } = makeRoom();
    const rooms = new Map<string, LivingWorldRoom>([['src', src.room], ['dest', dest]]);
    const controller = new HunterBotWarpController({
      rooms,
      pool,
      rng: makeSeededRng(1),
      respawnDelayMs: 100,
      hopTravelMs: 0,
      hostileSpecFor: () => ({}), // roaming ⇒ never hostile inline
    });

    await hop({ controller, rec, from: 'src', to: 'dest' });

    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.hostileToFaction).toBeUndefined();
  });

  it('omits the hostility spec entirely when no resolver is injected (back-compat)', async () => {
    const { pool, rec } = makePool();
    const src = makeRoom();
    const { room: dest, spawns } = makeRoom();
    const rooms = new Map<string, LivingWorldRoom>([['src', src.room], ['dest', dest]]);
    const controller = new HunterBotWarpController({
      rooms,
      pool,
      rng: makeSeededRng(1),
      respawnDelayMs: 100,
      hopTravelMs: 0,
    });

    await hop({ controller, rec, from: 'src', to: 'dest' });

    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.hostileToFaction).toBeUndefined();
  });
});
