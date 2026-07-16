/**
 * Campaign 4.1 (anti-patterns review A3 row 1 / Part D #6a) — "all attackers
 * appear at the exact same spot NE of 0,0".
 *
 * `respawnStep` posed every (re)spawn with `squadEdgePose(squadKey, sector,
 * botId)` — a PURE deterministic hash. The same bot respawning into the same
 * sector therefore rematerialised at the BYTE-IDENTICAL pose, forever: a
 * player camping the spot farms every respawn of the squad at one fixed point.
 *
 * The fix folds a time-bucketed RESPAWN EPOCH into the shared anchor bearing:
 * squadmates respawning within the same window still share the anchor (the
 * herd-warps-in-together clustering is deliberate and kept), but successive
 * respawn windows enter at rotating bearings — no permanent farm spot. The
 * entry-only-ingress invariant is untouched (still an edge pose, same radius).
 *
 * Harness mirrors `LivingWorldDirector.arrivalResolvers.test.ts`: the REAL
 * production director (real SquadPool seed, real private `respawnStep`), fake
 * rooms that capture every `spawnLivingWorldBot` spec. No injected resolvers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LivingWorldDirector, type LivingWorldOptions } from './LivingWorldDirector.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { HunterBotPool, BotRecord } from './director/HunterBotPool.js';
import { makeSeededRng, SQUAD_RESPAWN_EPOCH_MS } from './population.js';
import { Bus } from '../../core/events/Bus.js';

interface CapturedSpawn {
  botId: string;
  sectorKey: string;
  x: number;
  y: number;
}

function makeCapturingRoom(sectorKey: string, sink: CapturedSpawn[]): LivingWorldRoom {
  const bus = new Bus();
  return {
    eventBus: () => bus,
    playerCount: () => 0,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: (spec) => {
      sink.push({ botId: spec.botId, sectorKey, x: spec.x, y: spec.y });
      return true;
    },
    despawnLivingWorldBot: () => null,
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

/** Pierce the director's private pool + respawnStep (the REAL bodies under test —
 *  same piercing pattern as `arrivalResolvers.test.ts`). */
type DirectorInternals = {
  pool: HunterBotPool;
  respawnStep(now: number): void;
};
const pierce = (d: LivingWorldDirector): DirectorInternals => d as unknown as DirectorInternals;

describe('LivingWorldDirector.respawnStep — respawn pose varies across respawn epochs (campaign 4.1)', () => {
  let director: LivingWorldDirector | undefined;
  const spawns: CapturedSpawn[] = [];

  afterEach(() => {
    director?.stop();
    director = undefined;
    spawns.length = 0;
  });

  function boot(): LivingWorldDirector {
    // 'greenfall' is a REAL entry sector, so squads home there and
    // `respawnSectorFor` resolves to it — every respawn lands in ONE sector,
    // isolating the pose comparison to the epoch axis.
    const rooms = new Map<string, LivingWorldRoom>([
      ['greenfall', makeCapturingRoom('greenfall', spawns)],
    ]);
    const opts: Partial<LivingWorldOptions> & { rng: () => number; nowMs: () => number } = {
      botCount: 8, // one full squad: lwbot-0..7
      controlIntervalMs: 1_000_000, // control timer never fires in-test
      initialStaggerMs: 0, // all 8 eligible on the first step
      shedRecoveryMs: 0,
      rng: makeSeededRng(7),
      nowMs: () => 0,
    };
    const d = new LivingWorldDirector(rooms, opts);
    d.start();
    return d;
  }

  function poseOf(botId: string, from: CapturedSpawn[]): { x: number; y: number } {
    const hit = from.find((s) => s.botId === botId);
    expect(hit, `expected a captured spawn for ${botId}`).toBeDefined();
    return { x: hit!.x, y: hit!.y };
  }

  function respawnAll(d: LivingWorldDirector, delayMs = 0): void {
    const pool = pierce(d).pool;
    for (const rec of pool.values() as IterableIterator<BotRecord>) {
      pool.scheduleRespawn(rec, delayMs);
    }
  }

  it('the SAME bot respawning in a LATER epoch lands at a DIFFERENT pose (failed pre-fix: byte-identical forever)', () => {
    director = boot();
    const d = pierce(director);

    // Epoch 0: initial seed spawn.
    d.respawnStep(1_000);
    const first = poseOf('lwbot-0', [...spawns]);
    spawns.length = 0;

    // Kill the squad; respawn one full epoch later.
    respawnAll(director);
    d.respawnStep(1_000 + SQUAD_RESPAWN_EPOCH_MS);
    const second = poseOf('lwbot-0', [...spawns]);

    // Pre-fix squadEdgePose is time-blind: second === first exactly.
    const moved = Math.hypot(second.x - first.x, second.y - first.y);
    expect(moved).toBeGreaterThan(1);
  });

  it('squadmates respawning in the SAME epoch still cluster (the herd invariant is kept)', () => {
    director = boot();
    const d = pierce(director);

    d.respawnStep(1_000);
    expect(spawns.length).toBe(8);
    // Max pairwise gap well under a sector-wide scatter (the
    // livingWorldFormation lock uses gap < 1500 for a clustered spawn).
    let maxGap = 0;
    for (const a of spawns) {
      for (const b of spawns) {
        maxGap = Math.max(maxGap, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(maxGap).toBeLessThan(1500);
  });

  it('respawns within the SAME epoch keep the SAME anchor (retry stability)', () => {
    director = boot();
    const d = pierce(director);

    d.respawnStep(1_000);
    const first = poseOf('lwbot-0', [...spawns]);
    spawns.length = 0;

    respawnAll(director);
    d.respawnStep(2_000); // same epoch bucket
    const second = poseOf('lwbot-0', [...spawns]);

    expect(second.x).toBeCloseTo(first.x, 6);
    expect(second.y).toBeCloseTo(first.y, 6);
  });
});
