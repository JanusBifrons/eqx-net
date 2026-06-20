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
import { setAuditSink, type AuditEvent } from '../../audit/GameplayAuditLog.js';

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
    despawnLivingWorldBot: () =>
      over.carry ?? ({ kind: DEFAULT_SHIP_KIND, health: 40, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 } as BotCarry),
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

describe('HunterBotWarpController.arrive — carry-over spawn position (WS-E #13/#19)', () => {
  it('arrives at the CARRY pose (clamped) when arrivalPoseFor returns one (wave hop)', async () => {
    const { pool, rec } = makePool();
    // The bot departed from world (1234, -987) in the source sector.
    const carry: BotCarry = {
      kind: DEFAULT_SHIP_KIND,
      health: 33,
      x: 1234,
      y: -987,
      vx: 7,
      vy: -3,
      angle: 0,
      angvel: 0,
    };
    const src = makeRoom({ carry });
    const { room: dest, spawns } = makeRoom();
    const rooms = new Map<string, LivingWorldRoom>([['src', src.room], ['dest', dest]]);
    const controller = new HunterBotWarpController({
      rooms,
      pool,
      rng: makeSeededRng(1),
      respawnDelayMs: 100,
      hopTravelMs: 0,
      // A WAVE hop: carry the (clamped) pose forward.
      arrivalPoseFor: (_botId, _to, c) => ({ x: c.x, y: c.y, vx: c.vx, vy: c.vy }),
    });

    await hop({ controller, rec, from: 'src', to: 'dest' });

    expect(spawns).toHaveLength(1);
    // Arrives near where it left — NOT at the ~4600 u edge anchor (the old bug).
    expect(spawns[0]!.x).toBe(1234);
    expect(spawns[0]!.y).toBe(-987);
    expect(spawns[0]!.vx).toBe(7);
    expect(spawns[0]!.vy).toBe(-3);
    expect(spawns[0]!.health).toBe(33);
  });

  it('falls back to the EDGE spawn when arrivalPoseFor returns null (roam hop)', async () => {
    const { pool, rec } = makePool();
    const carry: BotCarry = {
      kind: DEFAULT_SHIP_KIND,
      health: 40,
      x: 100,
      y: 100,
      vx: 0,
      vy: 0,
      angle: 0,
      angvel: 0,
    };
    const src = makeRoom({ carry });
    const { room: dest, spawns } = makeRoom();
    const rooms = new Map<string, LivingWorldRoom>([['src', src.room], ['dest', dest]]);
    const controller = new HunterBotWarpController({
      rooms,
      pool,
      rng: makeSeededRng(1),
      respawnDelayMs: 100,
      hopTravelMs: 0,
      squadKeyOf: () => 'squad-0',
      arrivalPoseFor: () => null, // roaming ⇒ edge spawn
    });

    await hop({ controller, rec, from: 'src', to: 'dest' });

    expect(spawns).toHaveLength(1);
    // Edge spawn radius is ~0.92 × 5000 ≈ 4600 — far from the carry pose (100,100).
    const r = Math.hypot(spawns[0]!.x, spawns[0]!.y);
    expect(r).toBeGreaterThan(2000);
  });
});

/**
 * #18 — durable sector-change logging. Drone hops previously only hit the
 * volatile in-RAM `serverLogEvent` ring (dies on restart, never in the audit
 * NDJSON), so a galaxy-map "ship" (drone squad) jumping sectors left NO
 * checkable record. This locks a DURABLE `sector_change` audit event on every
 * drone arrival, carrying from/to + an `adjacent` watchdog flag (computed via
 * the real galaxy graph) so an illegal (non-neighbour) hop is a trivial grep.
 */
describe('HunterBotWarpController.arrive — durable sector_change audit (#18)', () => {
  async function captureHop(from: string, to: string): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [];
    setAuditSink((e) => events.push(e));
    try {
      const { pool, rec } = makePool();
      const src = makeRoom();
      const { room: dest } = makeRoom();
      const rooms = new Map<string, LivingWorldRoom>([[from, src.room], [to, dest]]);
      const controller = new HunterBotWarpController({
        rooms, pool, rng: makeSeededRng(1), respawnDelayMs: 100, hopTravelMs: 0,
      });
      await hop({ controller, rec, from, to });
      return events.filter((e) => e.event === 'sector_change');
    } finally {
      setAuditSink(null);
    }
  }

  it('emits a durable sector_change (entityKind=drone, from/to) on arrival', async () => {
    // sol-prime → vega-reach is a REAL adjacency (galaxy.ts).
    const changes = await captureHop('sol-prime', 'vega-reach');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      event: 'sector_change', entityKind: 'drone', id: 'lwbot-0',
      from: 'sol-prime', to: 'vega-reach', adjacent: true,
    });
  });

  it('flags adjacent=false when a drone hops between NON-neighbour sectors (the illegal-warp watchdog)', async () => {
    // sol-prime and thornfield are NOT neighbours — this is exactly the
    // "ship jumped Thornfield→Cygnus" class the user reported; if it ever
    // happens for real, the audit log now records adjacent=false.
    const changes = await captureHop('sol-prime', 'thornfield');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ event: 'sector_change', adjacent: false });
  });
});
