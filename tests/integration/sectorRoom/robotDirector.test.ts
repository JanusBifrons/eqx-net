/**
 * Living World P1b (plan peppy-jumping-pinwheel) — the ROBOT director: a second
 * `LivingWorldDirector` instance run with `ROBOT_DIRECTOR_OPTIONS` over real
 * SectorRooms.
 *
 * Locks the three things that make it a different SIDE rather than more drones:
 *   1. its bots are `rbot-` ids in MIXED-TIER squads (hexagon lead, two
 *      circles, three cubes) — real swarm entities with those hull kinds;
 *   2. it NEVER dispatches a wave, even at a READY base that the drone director
 *      would wave immediately (robots fight on sight via the stance table —
 *      the room AI does the fighting, not the director);
 *   3. a kill of a robot bot respawns it (the director's lifecycle works for a
 *      non-`lwbot-` prefix — `isDirectorBotId` / pool ownership).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { getRecentAudit, clearAuditRing } from '../../../src/server/audit/GameplayAuditLog.js';
import { ROBOT_DIRECTOR_OPTIONS, ROBOT_SQUAD_LAYOUT } from '../../../src/server/livingworld/robotDirector.js';

const READY_BASE = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'solar', x: 250, y: 0 },
  { kind: 'miner', x: -350, y: 0 },
  { kind: 'turret', x: 0, y: 350 },
];

describe('SectorRoom integration — robot director (Living World P1b)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('spawns rbot- mixed-tier squads and never waves a ready base', async () => {
    clearAuditRing();
    h = await bootLivingWorldTestServer({
      // greenfall = the only entry sector here (the squad homes there);
      // emerald-span holds a READY base that a drone director would wave.
      sectors: ['greenfall', 'emerald-span'],
      botCount: 6,
      seed: 11,
      bases: [{ sector: 'emerald-span', owner: 'base-owner', structures: READY_BASE }],
      director: {
        ...ROBOT_DIRECTOR_OPTIONS,
        botCount: 6,
        squadLayout: { ...ROBOT_SQUAD_LAYOUT, squadCount: 1 },
        // Same fast cadence the wave tests use — a DRONE director dispatches
        // at this base within ~1 control tick with these settings.
        dispatchIntervalMs: 1,
        controlIntervalMs: 50,
      },
    });

    await h.waitUntil(() => h!.director.snapshot().active === 6, 8000, 'all 6 robots warped in');

    // 1. Real swarm entities: rbot- ids carrying the per-slot robot hulls.
    const room = h.getRoom('greenfall');
    const bots = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1);
    expect(bots).toHaveLength(6);
    expect(bots.every((b) => b.id.startsWith('rbot-'))).toBe(true);
    const tally: Record<string, number> = {};
    for (const b of bots) tally[b.shipKind ?? '?'] = (tally[b.shipKind ?? '?'] ?? 0) + 1;
    expect(tally).toEqual({ 'robot-hexagon': 1, 'robot-circle': 2, 'robot-square': 3 });

    // 2. No wave, ever — let many control ticks pass with the ready base up.
    await h.advance(1500);
    const sq = h.director.squadSnapshot();
    expect(sq.byState.warping).toBe(0);
    expect(sq.byState.attacking).toBe(0);
    expect(getRecentAudit().some((e) => e.event === 'wave_dispatched')).toBe(false);
  }, 25_000);

  it('a killed robot respawns into its squad (lifecycle works for the rbot- prefix)', async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall'],
      botCount: 6,
      seed: 12,
      director: {
        ...ROBOT_DIRECTOR_OPTIONS,
        botCount: 6,
        squadLayout: { ...ROBOT_SQUAD_LAYOUT, squadCount: 1 },
      },
    });
    await h.waitUntil(() => h!.director.snapshot().active === 6, 8000, 'all 6 robots warped in');

    // Faithful kill (see livingWorldDirector.test.ts): quiet-remove the body,
    // then emit the ENTITY_DESTROYED the director subscribes to.
    const room = h.getRoom('greenfall');
    room.despawnLivingWorldBot('rbot-2');
    room.eventBus().emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: 'rbot-2' });
    await h.waitUntil(() => h!.director.snapshot().active === 5, 3000, 'kill observed');
    await h.waitUntil(() => h!.director.snapshot().active === 6, 6000, 'robot respawned');
    expect(room._internals.swarmRegistry.get('rbot-2')?.shipKind).toBe('robot-circle');
  }, 25_000);
});
