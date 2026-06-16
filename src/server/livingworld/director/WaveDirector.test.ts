import { describe, it, expect } from 'vitest';
import { WaveDirector } from './WaveDirector.js';
import { SquadPool, SQUAD_SIZE, LIVING_WORLD_SQUAD_COUNT } from './SquadPool.js';
import { WaveSquadBehaviour } from './SquadBehaviour.js';
import { EscalatingWavePattern } from './WavePattern.js';
import { FACTION_PEACEFUL_TIMEOUT_TICKS } from '../../../core/faction/Faction.js';
import type { HunterBotPool } from './HunterBotPool.js';
import type { FactionBaseReadiness, LivingWorldRoom } from '../LivingWorldRoom.js';

function botIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `lwbot-${i}`);
}

/** Fake room exposing only `factionBaseReadiness`; the other hooks are no-ops
 *  (the director, not the WaveDirector, calls them). */
function fakeRoom(readiness: FactionBaseReadiness[]): LivingWorldRoom {
  return {
    eventBus: () => ({}) as never,
    playerCount: () => 1,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: () => true,
    despawnLivingWorldBot: () => null,
    markBotHostile: () => {},
    factionBaseReadiness: () => readiness,
    setFactionUnderWave: () => {},
    markSquadHostileToFaction: () => {},
  };
}

/** Fake hunter pool — only `get(botId).state/.sectorKey` is read. */
function fakeHunterPool(states: Map<string, { state: string; sectorKey: string }>): HunterBotPool {
  return { get: (id: string) => states.get(id) } as unknown as HunterBotPool;
}

const readyFaction = (over: Partial<FactionBaseReadiness> = {}): FactionBaseReadiness => ({
  factionId: 'alice',
  sectorKey: 'vega',
  ready: true,
  ownerPresent: true,
  minerCount: 1,
  hostileToDrones: false,
  underWave: false,
  lastDealtDamageTick: -Infinity,
  serverTick: 0,
  ...over,
});

function setup(opts: {
  readiness: FactionBaseReadiness[];
  hunterStates?: Map<string, { state: string; sectorKey: string }>;
  dispatchIntervalMs?: number;
}): { wave: WaveDirector; squadPool: SquadPool } {
  const squadPool = new SquadPool();
  squadPool.seed(botIds(LIVING_WORLD_SQUAD_COUNT * SQUAD_SIZE), () => 'sol-prime', () => 'fighter');
  const rooms = new Map<string, LivingWorldRoom>([['vega', fakeRoom(opts.readiness)]]);
  const wave = new WaveDirector({
    rooms,
    squadPool,
    hunterPool: fakeHunterPool(opts.hunterStates ?? new Map()),
    behaviour: new WaveSquadBehaviour(),
    pattern: new EscalatingWavePattern(),
    ...(opts.dispatchIntervalMs !== undefined ? { dispatchIntervalMs: opts.dispatchIntervalMs } : {}),
  });
  return { wave, squadPool };
}

const countAssignedTo = (squadPool: SquadPool, factionId: string): number =>
  [...squadPool.all()].filter((s) => s.targetFactionId === factionId).length;

describe('WaveDirector — assignment + advancement', () => {
  it('assigns an idle squad to a ready faction and emits a warp step', () => {
    const { wave, squadPool } = setup({ readiness: [readyFaction()] });
    squadPool.setState(squadPool.get('squad-0')!, 'idle');
    const steps = wave.plan(0);
    const sq = squadPool.get('squad-0')!;
    expect(sq.targetFactionId).toBe('alice');
    expect(sq.sectorKey).toBe('vega');
    expect(steps).toContainEqual({ kind: 'warp', squad: sq, to: 'vega' });
  });

  it('dispatches the NEAREST idle squad to the ready base (graph distance)', () => {
    // The user's directive: "review the pools of drones … direct the nearest
    // roaming groups towards the player." Two idle squads at different sectors;
    // the one CLOSEST to the ready base (by galaxy-graph hops) is assigned.
    const { wave, squadPool } = setup({ readiness: [readyFaction({ sectorKey: 'orion-belt' })] });
    const far = squadPool.get('squad-0')!; // seeded at sol-prime → 1 hop to orion-belt
    const near = squadPool.get('squad-1')!;
    near.sectorKey = 'orion-belt'; // already at the base → 0 hops
    squadPool.setState(far, 'idle');
    squadPool.setState(near, 'idle');

    wave.plan(0);

    expect(near.targetFactionId).toBe('alice'); // nearest wins
    expect(far.targetFactionId).toBeNull(); // farther squad stays idle (v1 = 1 squad)
  });

  it('does NOT assign when no squad is idle', () => {
    const { wave, squadPool } = setup({ readiness: [readyFaction()] });
    // all squads left 'forming'
    const steps = wave.plan(0);
    expect(steps).toEqual([]);
    expect(squadPool.get('squad-0')!.targetFactionId).toBeNull();
  });

  it('does NOT assign to an unready base', () => {
    const { wave, squadPool } = setup({ readiness: [readyFaction({ ready: false })] });
    squadPool.setState(squadPool.get('squad-0')!, 'idle');
    expect(wave.plan(0)).toEqual([]);
    expect(squadPool.get('squad-0')!.targetFactionId).toBeNull();
  });

  it('STILL assigns to a ready base whose owner is OFFLINE (Equinox: attack regardless of presence)', () => {
    const { wave, squadPool } = setup({ readiness: [readyFaction({ ownerPresent: false })] });
    squadPool.setState(squadPool.get('squad-0')!, 'idle');
    const steps = wave.plan(0);
    const sq = squadPool.get('squad-0')!;
    // The presence gate was removed — a ready base draws a wave even when the
    // owner is offline (their turrets defend; an undefended base de-escalates).
    expect(sq.targetFactionId).toBe('alice');
    expect(steps).toContainEqual({ kind: 'warp', squad: sq, to: 'vega' });
  });

  it('does not double-assign two squads to the same faction (v1 = 1 squad)', () => {
    const { wave, squadPool } = setup({ readiness: [readyFaction()] });
    squadPool.setState(squadPool.get('squad-0')!, 'idle');
    squadPool.setState(squadPool.get('squad-1')!, 'idle');
    wave.plan(0);
    const assigned = [...squadPool.all()].filter((s) => s.targetFactionId === 'alice');
    expect(assigned).toHaveLength(1);
  });

  it('warping squad with members arrived → attack step', () => {
    const states = new Map([['lwbot-0', { state: 'active', sectorKey: 'vega' }]]);
    const { wave, squadPool } = setup({ readiness: [readyFaction()], hunterStates: states });
    const sq = squadPool.get('squad-0')!;
    squadPool.assignTarget(sq, 'vega', 'alice');
    squadPool.setState(sq, 'warping');
    const steps = wave.plan(0);
    expect(steps).toContainEqual({ kind: 'attack', squad: sq, factionId: 'alice', sectorKey: 'vega' });
  });

  it('attacking squad whose faction de-escalated (no miners + peaceful) → retreat', () => {
    const states = new Map([['lwbot-0', { state: 'active', sectorKey: 'vega' }]]);
    const { wave, squadPool } = setup({
      readiness: [
        readyFaction({
          ready: false, // no miner ⇒ not ready
          minerCount: 0,
          hostileToDrones: true,
          underWave: true,
          lastDealtDamageTick: 0, // long ago
          serverTick: FACTION_PEACEFUL_TIMEOUT_TICKS + 100, // peaceful window elapsed
        }),
      ],
      hunterStates: states,
    });
    const sq = squadPool.get('squad-0')!;
    squadPool.assignTarget(sq, 'vega', 'alice');
    squadPool.setState(sq, 'attacking');
    const steps = wave.plan(0);
    expect(steps).toContainEqual({ kind: 'retreat', squad: sq, factionId: 'alice', sectorKey: 'vega' });
  });

  it('attacking squad stays attacking while miners survive (no de-escalation)', () => {
    const states = new Map([['lwbot-0', { state: 'active', sectorKey: 'vega' }]]);
    const { wave, squadPool } = setup({
      readiness: [
        readyFaction({
          minerCount: 2,
          hostileToDrones: true,
          underWave: true,
          serverTick: FACTION_PEACEFUL_TIMEOUT_TICKS + 100,
        }),
      ],
      hunterStates: states,
    });
    const sq = squadPool.get('squad-0')!;
    squadPool.assignTarget(sq, 'vega', 'alice');
    squadPool.setState(sq, 'attacking');
    const steps = wave.plan(0);
    expect(steps).toContainEqual({ kind: 'attack', squad: sq, factionId: 'alice', sectorKey: 'vega' });
  });

  it('re-triggers: a stood-down squad re-engages when the faction rebuilds (req #8)', () => {
    // After a de-escalation the director clears the squad's target and returns
    // it to idle. If the faction rebuilds a Miner (ready again), the next plan()
    // must re-assign + re-warp — no special state, purely readiness-driven.
    const { wave, squadPool } = setup({ readiness: [readyFaction()] });
    const sq = squadPool.get('squad-0')!;
    // Simulate the post-retreat state: idle, target cleared.
    squadPool.setState(sq, 'idle');
    sq.targetFactionId = null;
    const steps = wave.plan(0);
    expect(sq.targetFactionId).toBe('alice');
    expect(steps).toContainEqual({ kind: 'warp', squad: sq, to: 'vega' });
  });

  it('rate-caps dispatch to one squad per dispatchIntervalMs per faction', () => {
    const { wave, squadPool } = setup({ readiness: [readyFaction()], dispatchIntervalMs: 1000 });
    // First dispatch at t=0 — an idle squad is committed (no prior record).
    squadPool.setState(squadPool.get('squad-0')!, 'idle');
    wave.plan(0);
    expect(countAssignedTo(squadPool, 'alice')).toBe(1);

    // The wave stands down: squad-0 returns to idle, target cleared. A SECOND
    // idle squad is now available, but within the dispatch window the faction
    // must NOT receive a fresh squad.
    const sq0 = squadPool.get('squad-0')!;
    squadPool.setState(sq0, 'idle');
    sq0.targetFactionId = null;
    squadPool.setState(squadPool.get('squad-1')!, 'idle');
    wave.plan(500); // < 1000 ms since the last dispatch
    expect(countAssignedTo(squadPool, 'alice')).toBe(0);

    // Once the window elapses, the next plan re-dispatches exactly one squad.
    wave.plan(1500);
    expect(countAssignedTo(squadPool, 'alice')).toBe(1);
  });

  it('attacking squad whose base vanished entirely → retreat', () => {
    const states = new Map([['lwbot-0', { state: 'active', sectorKey: 'vega' }]]);
    const { wave, squadPool } = setup({ readiness: [], hunterStates: states });
    const sq = squadPool.get('squad-0')!;
    squadPool.assignTarget(sq, 'vega', 'alice');
    squadPool.setState(sq, 'attacking');
    const steps = wave.plan(0);
    expect(steps).toContainEqual({ kind: 'retreat', squad: sq, factionId: 'alice', sectorKey: 'vega' });
  });
});

describe('WaveDirector — serialize/restore (director-state persistence, Phase 5)', () => {
  it('serialize captures the wave bookkeeping maps; restore round-trips', () => {
    const { wave, squadPool } = setup({ readiness: [readyFaction()], dispatchIntervalMs: 1000 });
    squadPool.setState(squadPool.get('squad-0')!, 'idle');
    wave.plan(0); // dispatches → waveCount{alice:1}, lastDispatchAtMs{alice:0}
    const saved = wave.serialize();
    expect(saved.waveCount).toEqual([['alice', 1]]);
    expect(saved.lastDispatchAtMs).toEqual([['alice', 0]]);

    const { wave: fresh } = setup({ readiness: [readyFaction()], dispatchIntervalMs: 1000 });
    fresh.restore(saved);
    expect(fresh.serialize()).toEqual(saved);
  });

  it('restore clears prior maps before repopulating', () => {
    const { wave } = setup({ readiness: [readyFaction()] });
    wave.restore({ waveCount: [['old', 5]], lastDispatchAtMs: [['old', 99]] });
    expect(wave.serialize()).toEqual({ waveCount: [['old', 5]], lastDispatchAtMs: [['old', 99]] });
    wave.restore({ waveCount: [], lastDispatchAtMs: [] });
    expect(wave.serialize()).toEqual({ waveCount: [], lastDispatchAtMs: [] });
  });

  it('restored lastDispatchAtMs still gates the rate-cap across a "restart"', () => {
    // Dispatch once, persist, then rebuild the director (fresh squadPool +
    // WaveDirector) and restore. The restored last-dispatch wall-clock must
    // still rate-cap an immediate re-dispatch, then release after the window.
    const { wave, squadPool } = setup({ readiness: [readyFaction()], dispatchIntervalMs: 1000 });
    squadPool.setState(squadPool.get('squad-0')!, 'idle');
    wave.plan(0);
    const saved = wave.serialize();

    const { wave: rebuilt, squadPool: pool2 } = setup({
      readiness: [readyFaction()],
      dispatchIntervalMs: 1000,
    });
    rebuilt.restore(saved);
    pool2.setState(pool2.get('squad-0')!, 'idle');
    rebuilt.plan(500); // < 1000 ms since the persisted dispatch ⇒ capped
    expect(countAssignedTo(pool2, 'alice')).toBe(0);
    rebuilt.plan(1500); // window elapsed ⇒ re-dispatch
    expect(countAssignedTo(pool2, 'alice')).toBe(1);
  });
});
