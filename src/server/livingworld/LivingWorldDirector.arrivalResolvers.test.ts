/**
 * LivingWorldDirector — the REAL arrival resolvers (WS-E #15 + #13/#19).
 *
 * ADVERSARIAL-REVIEW FIX. The first-round locks for these two bugs sat BELOW
 * where the bug lives:
 *
 *  - `HunterBotWarpController.test.ts` INJECTS a fake `hostileSpecFor` /
 *    `arrivalPoseFor` and HARDCODES the carry `{x,y}`, so reverting the
 *    director's REAL resolver bodies left it green.
 *  - `LivingWorldBotHooks.test.ts` only proves `spawnBot` marks WHEN HANDED a
 *    spec — never the director's resolution of WHAT spec to hand it.
 *
 * So the director's REAL resolution — `squadPool.squadOf(botId).targetFactionId`
 * + `squad.sectorKey === arrival sector` + the destination room's
 * `factionHostility()` (#15), and `squadOf().targetFactionId != null ⇒
 * clampToSectorBounds(carry)` else `null` (#13/#19) — had ZERO coverage.
 *
 * These tests construct the PRODUCTION director (real `SquadPool`, real
 * `start()` seed), assign a real squad a real wave target via the real
 * `SquadPool.assignTarget`, then call the director's REAL private
 * `hostileSpecFor` / `arrivalPoseFor` (the SAME bodies wired into the
 * `HunterBotWarpController` at construction). Reverting either body goes RED
 * here. No injected fakes, no hardcoded carry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  LivingWorldDirector,
  type LivingWorldOptions,
} from './LivingWorldDirector.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { SquadPool, SquadRecord } from './director/SquadPool.js';
import type { BotCarry } from './botTypes.js';
import { Bus } from '../../core/events/Bus.js';
import { makeSeededRng } from './population.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';

/** Two REAL galaxy sectors so `getSector()` resolves; `factionHostility`
 *  returns a deterministic per-faction member set keyed off the room. */
function makeRoom(sectorKey: string): LivingWorldRoom {
  const bus = new Bus();
  return {
    eventBus: () => bus,
    playerCount: () => 0,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: () => true,
    despawnLivingWorldBot: () => null,
    markBotHostile: () => {},
    // The destination room owns the faction's structure ids — the resolver under
    // test must consult THIS, not synthesise its own. Tag the sector so the test
    // can prove the spec came from the ARRIVAL room's resolver.
    factionHostility: (id) => ({ playerId: id, structureIds: [`${sectorKey}:struct:${id}`] }),
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

const OPTS: Partial<LivingWorldOptions> & { rng: () => number; nowMs: () => number } = {
  botCount: 8, // one full squad: lwbot-0..7 ⇒ squad-0
  controlIntervalMs: 1_000_000, // the control timer never fires during the test
  rng: makeSeededRng(1),
  nowMs: () => 0,
};

/** Reach the director's PRIVATE resolvers + squad pool. They are the SAME bodies
 *  the director wires into HunterBotWarpController at construction (lines 354/358)
 *  — so locking them here locks the production warp-arrive path. */
type DirectorInternals = {
  squadPool: SquadPool;
  hostileSpecFor(
    botId: string,
    sectorKey: string,
  ): { hostileToFaction?: { playerId: string; structureIds: readonly string[] } };
  arrivalPoseFor(
    botId: string,
    to: string,
    carry: BotCarry,
  ): { x: number; y: number; vx: number; vy: number } | null;
};
const pierce = (d: LivingWorldDirector): DirectorInternals => d as unknown as DirectorInternals;

function carryAt(x: number, y: number, vx = 0, vy = 0): BotCarry {
  return { kind: DEFAULT_SHIP_KIND, health: 33, x, y, vx, vy, angle: 0, angvel: 0 };
}

describe('LivingWorldDirector.hostileSpecFor — REAL squad+sector+factionHostility resolution (WS-E #15)', () => {
  let director: LivingWorldDirector | undefined;
  afterEach(() => {
    director?.stop();
    director = undefined;
  });

  function bootWithAttackingSquad(targetSector: string, factionId: string): {
    director: LivingWorldDirector;
    squad: SquadRecord;
    memberId: string;
  } {
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', makeRoom('sol-prime')],
      ['orion-belt', makeRoom('orion-belt')],
    ]);
    const d = new LivingWorldDirector(rooms, OPTS);
    d.start(); // seeds squad-0 with lwbot-0..7
    const sp = pierce(d).squadPool;
    const squad = sp.squadOf('lwbot-0')!;
    // The REAL wave-assignment path the WaveDirector uses: target a faction at a
    // sector. The resolver under test must read THIS to decide hostility.
    sp.assignTarget(squad, targetSector, factionId);
    return { director: d, squad, memberId: 'lwbot-0' };
  }

  it('resolves the ARRIVAL room\'s faction-hostility spec when the member lands AT its squad\'s target sector', () => {
    const boot = bootWithAttackingSquad('sol-prime', 'alice');
    director = boot.director;

    // REAL resolution: squadOf(lwbot-0).targetFactionId === 'alice', squad.sectorKey
    // === 'sol-prime' === arrival, so it consults the SOL-PRIME room's factionHostility.
    const spec = pierce(director).hostileSpecFor(boot.memberId, 'sol-prime');

    expect(spec.hostileToFaction).toEqual({
      playerId: 'alice',
      // Proves the spec came from the ARRIVAL room's resolver (sol-prime tag),
      // not a synthesised default — locks the `room.factionHostility(target)` line.
      structureIds: ['sol-prime:struct:alice'],
    });
  });

  it('returns NO spec on an INTERMEDIATE hop (squad target sector !== arrival sector)', () => {
    // Squad targets 'sol-prime' but the member is arriving at 'orion-belt' mid-traverse.
    const boot = bootWithAttackingSquad('sol-prime', 'alice');
    director = boot.director;

    const spec = pierce(director).hostileSpecFor(boot.memberId, 'orion-belt');
    expect(spec.hostileToFaction).toBeUndefined();
  });

  it('returns NO spec for a ROAMING squad (no targetFactionId)', () => {
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', makeRoom('sol-prime')],
      ['orion-belt', makeRoom('orion-belt')],
    ]);
    director = new LivingWorldDirector(rooms, OPTS);
    director.start();
    // squad-0 stays unassigned (targetFactionId === null) — a roaming pack.
    const spec = pierce(director).hostileSpecFor('lwbot-0', 'sol-prime');
    expect(spec.hostileToFaction).toBeUndefined();
  });
});

describe('LivingWorldDirector.arrivalPoseFor — REAL carry-clamp vs edge-fallback resolution (WS-E #13/#19)', () => {
  let director: LivingWorldDirector | undefined;
  afterEach(() => {
    director?.stop();
    director = undefined;
  });

  it('a WAVE hop arrives at the CARRY pose, CLAMPED to sector bounds', () => {
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', makeRoom('sol-prime')],
      ['orion-belt', makeRoom('orion-belt')],
    ]);
    director = new LivingWorldDirector(rooms, OPTS);
    director.start();
    const sp = pierce(director).squadPool;
    sp.assignTarget(sp.squadOf('lwbot-0')!, 'sol-prime', 'alice');

    // Carry pose deliberately PAST the playable bound on x so the clamp is observable.
    const over = SECTOR_PLAYABLE_HALF_EXTENT + 1234;
    const pose = pierce(director).arrivalPoseFor('lwbot-0', 'sol-prime', carryAt(over, -987, 7, -3));

    expect(pose).not.toBeNull();
    // x clamped to the bound; y in-bounds passes through; velocity carried verbatim.
    expect(pose!.x).toBe(SECTOR_PLAYABLE_HALF_EXTENT);
    expect(pose!.y).toBe(-987);
    expect(pose!.vx).toBe(7);
    expect(pose!.vy).toBe(-3);
  });

  it('an in-bounds WAVE carry passes through unclamped', () => {
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', makeRoom('sol-prime')],
      ['orion-belt', makeRoom('orion-belt')],
    ]);
    director = new LivingWorldDirector(rooms, OPTS);
    director.start();
    const sp = pierce(director).squadPool;
    sp.assignTarget(sp.squadOf('lwbot-0')!, 'sol-prime', 'alice');

    const pose = pierce(director).arrivalPoseFor('lwbot-0', 'sol-prime', carryAt(1234, -987, 1, 2));
    expect(pose).toEqual({ x: 1234, y: -987, vx: 1, vy: 2 });
  });

  it('a ROAMING hop returns null ⇒ the controller falls back to the EDGE spawn', () => {
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', makeRoom('sol-prime')],
      ['orion-belt', makeRoom('orion-belt')],
    ]);
    director = new LivingWorldDirector(rooms, OPTS);
    director.start();
    // Unassigned squad-0 (targetFactionId null) ⇒ roaming ⇒ null (edge fallback).
    const pose = pierce(director).arrivalPoseFor('lwbot-0', 'sol-prime', carryAt(1234, -987));
    expect(pose).toBeNull();
  });
});
