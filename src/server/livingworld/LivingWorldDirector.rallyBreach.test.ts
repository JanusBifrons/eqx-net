/**
 * Campaign 4.2 (anti-patterns review A3 row 2 / Part D #6b) — "squads of 8 but
 * only 1-2 ever seen".
 *
 * Wave members advance INDEPENDENTLY one graph hop per control tick, so each
 * member breached into the target sector ALONE the moment it reached the
 * penultimate sector — the assault trickled in 1-2 at a time and the defender
 * never saw a squad. (The code's own comment admitted "stragglers keep hopping
 * in"; the cohesive doorstep-breach was the deferred piece.)
 *
 * The fix is RALLY-BEFORE-BREACH: while a WAVE squad is in its `warping`
 * phase, members whose next hop IS the goal (the rally ring) are HELD there
 * until every other traversing member has reached the ring too — then all
 * begin the final approach in the SAME control tick (sharing the long
 * `waveApproachSpoolMs` telegraph), so the squad breaches together. The hold
 * is time-boxed (`rallyMaxMs`) so a perpetual respawn-straggler cycle can't
 * stall the wave forever, and it applies ONLY pre-breach: once the squad is
 * `attacking`, reinforcements flow in unheld exactly as before.
 *
 * Harness mirrors `respawnPose`/`arrivalResolvers`: the REAL production
 * director + real SquadPool, fake rooms whose buses capture every
 * BOT_TRANSIT_STARTED. Geography is real: vega-reach is sol-prime's
 * neighbour (the rally ring); orion-belt is 2 hops out.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  LivingWorldDirector,
  decideRallyRelease,
  type LivingWorldOptions,
} from './LivingWorldDirector.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { HunterBotPool, BotRecord } from './director/HunterBotPool.js';
import type { SquadPool, SquadRecord } from './director/SquadPool.js';
import { makeSeededRng } from './population.js';
import { Bus } from '../../core/events/Bus.js';

interface TransitStart {
  botId: string;
  from: string;
  to: string;
}

function makeRoom(started: TransitStart[]): LivingWorldRoom {
  const bus = new Bus();
  bus.on('BOT_TRANSIT_STARTED', (e) => {
    const evt = e as unknown as TransitStart;
    started.push({ botId: evt.botId, from: evt.from, to: evt.to });
  });
  return {
    eventBus: () => bus,
    playerCount: () => 0,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: () => true,
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

type DirectorInternals = {
  pool: HunterBotPool;
  squadPool: SquadPool;
  advanceMembersTowardGoal(squad: SquadRecord): number;
};
const pierce = (d: LivingWorldDirector): DirectorInternals => d as unknown as DirectorInternals;

const RALLY_MAX_MS = 90_000;

describe('LivingWorldDirector — rally-before-breach group arrival (campaign 4.2)', () => {
  let director: LivingWorldDirector | undefined;
  let now = 0;
  const started: TransitStart[] = [];

  afterEach(() => {
    director?.stop();
    director = undefined;
    started.length = 0;
    now = 0;
  });

  function boot(): { d: DirectorInternals; squad: SquadRecord } {
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', makeRoom(started)], // the wave goal
      ['vega-reach', makeRoom(started)], // its neighbour — the rally ring
      ['orion-belt', makeRoom(started)], // 2 hops out (via vega-reach)
    ]);
    const opts: Partial<LivingWorldOptions> & { rng: () => number; nowMs: () => number } = {
      botCount: 8,
      controlIntervalMs: 1_000_000,
      initialStaggerMs: 0,
      rallyMaxMs: RALLY_MAX_MS,
      rng: makeSeededRng(3),
      nowMs: () => now,
    };
    director = new LivingWorldDirector(rooms, opts);
    director.start();
    const d = pierce(director);
    const squad = d.squadPool.squadOf('lwbot-0')!;
    d.squadPool.assignTarget(squad, 'sol-prime', 'alice');
    d.squadPool.setState(squad, 'warping');
    return { d, squad };
  }

  /** Force a member ACTIVE at a sector (the harness's scripted board). */
  function placeActive(d: DirectorInternals, botId: string, sectorKey: string): void {
    const rec = d.pool.get(botId) as BotRecord;
    rec.state = 'active';
    rec.sectorKey = sectorKey;
    rec.controller = null;
  }

  const toGoal = (): TransitStart[] => started.filter((s) => s.to === 'sol-prime');

  it('HOLDS ring members while squadmates are still traversing (failed pre-fix: they breached alone)', () => {
    const { d, squad } = boot();
    for (let i = 0; i < 6; i++) placeActive(d, `lwbot-${i}`, 'vega-reach');
    placeActive(d, 'lwbot-6', 'orion-belt');
    placeActive(d, 'lwbot-7', 'orion-belt');

    now = 10_000;
    d.advanceMembersTowardGoal(squad);

    // Pre-fix the 6 ring members began the final leg immediately — a 1-2 drip
    // into the defended sector. They must WAIT for the stragglers.
    expect(toGoal()).toEqual([]);
    // The stragglers still advance toward the ring (traversal is not stalled).
    expect(started.filter((s) => s.botId === 'lwbot-6' && s.to === 'vega-reach').length).toBe(1);
    expect(started.filter((s) => s.botId === 'lwbot-7' && s.to === 'vega-reach').length).toBe(1);
  });

  it('releases the WHOLE squad in one tick once every member is staged at the ring', () => {
    const { d, squad } = boot();
    for (let i = 0; i < 8; i++) placeActive(d, `lwbot-${i}`, 'vega-reach');

    now = 10_000;
    d.advanceMembersTowardGoal(squad);

    // All 8 begin the final approach in the SAME control tick — the group breach.
    expect(toGoal().length).toBe(8);
  });

  it('time-boxes the hold: a perpetual straggler cannot stall the wave past rallyMaxMs', () => {
    const { d, squad } = boot();
    for (let i = 0; i < 7; i++) placeActive(d, `lwbot-${i}`, 'vega-reach');
    placeActive(d, 'lwbot-7', 'orion-belt');

    now = 10_000;
    d.advanceMembersTowardGoal(squad); // starts the hold window (straggler pending)
    expect(toGoal()).toEqual([]);

    now = 10_000 + RALLY_MAX_MS + 1;
    d.advanceMembersTowardGoal(squad);
    // The 7 staged members breach anyway; the straggler keeps flowing in later.
    expect(toGoal().length).toBe(7);
  });

  it('never holds an ATTACKING squad — reinforcements flow into the fight unheld', () => {
    const { d, squad } = boot();
    d.squadPool.setState(squad, 'attacking');
    for (let i = 0; i < 6; i++) placeActive(d, `lwbot-${i}`, 'sol-prime'); // already fighting
    placeActive(d, 'lwbot-6', 'vega-reach');
    placeActive(d, 'lwbot-7', 'orion-belt');

    now = 10_000;
    d.advanceMembersTowardGoal(squad);

    // The ring reinforcement joins the fight immediately (no rally hold).
    expect(started.filter((s) => s.botId === 'lwbot-6' && s.to === 'sol-prime').length).toBe(1);
  });
});

describe('decideRallyRelease (pure)', () => {
  it('releases when nothing is at the ring or everyone is staged', () => {
    expect(decideRallyRelease(0, 3, null, 0, 1000)).toBe(true);
    expect(decideRallyRelease(5, 0, null, 0, 1000)).toBe(true);
  });

  it('holds while members are pending, until the time-box expires', () => {
    expect(decideRallyRelease(5, 2, null, 0, 1000)).toBe(false); // starts the window
    expect(decideRallyRelease(5, 2, 0, 999, 1000)).toBe(false);
    expect(decideRallyRelease(5, 2, 0, 1000, 1000)).toBe(true);
  });
});
