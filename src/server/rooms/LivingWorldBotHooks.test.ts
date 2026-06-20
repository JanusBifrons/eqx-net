/**
 * LivingWorldBotHooks — inline hostility at spawn (WS-E #15).
 *
 * USER REPORT (on-device): "Hostile attacking drones always show as neutral …
 * sometimes flagged hostile on arrival."
 *
 * ROOT CAUSE: there is NO per-drone hostile flag on the wire — disposition is
 * driven solely by the discrete `bot_aggro` broadcast, fired by
 * `markBotHostileToFaction`, which early-returns `if (!rec)`. The dominant race
 * is the warp `arrive` path: a squad member is SPAWNED on a macrotask AFTER the
 * control tick that ran `executeWaveStep('attack')` → `markSquadHostileToFaction`
 * — so when that tick marked the squad, the arriving member's swarm record did
 * NOT yet exist (`!rec` → early return). It stays neutral until the NEXT ~1.5 s
 * control tick re-pulses hostility.
 *
 * FIX: `spawnBot` accepts an optional `hostileToFaction` and marks hostility
 * INLINE, right after the record is created, so an arriving member of an
 * attacking squad is hostile (AI ledger) + `bot_aggro` fired in the SAME call as
 * spawn — no control-tick gap.
 *
 * This unit test drives the hooks class directly with hand-rolled deps (the
 * gold-standard mock style), so it FAILS today (spawnBot has no
 * `hostileToFaction` param → no inline mark) and passes once the param + inline
 * mark land.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LivingWorldBotHooks, type LivingWorldBotHooksDeps } from './LivingWorldBotHooks.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';
import type { BotAggroEvent } from '../../shared-types/messages.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';

/** Build a hooks instance over hand-rolled deps; expose the captured side
 *  effects (markHostile ledger writes + bot_aggro broadcasts). */
function makeHooks(): {
  hooks: LivingWorldBotHooks;
  marks: Array<{ droneId: string; targetId: string }>;
  aggros: BotAggroEvent[];
  registry: Map<string, SwarmEntityRecord>;
  sab: Float32Array;
} {
  const marks: Array<{ droneId: string; targetId: string }> = [];
  const aggros: BotAggroEvent[] = [];
  const registry = new Map<string, SwarmEntityRecord>();
  const sab = new Float32Array(64 * 1024);
  let nextEntityId = 1;
  let nextSlot = 0;

  const deps: LivingWorldBotHooksDeps = {
    serverTick: () => 42,
    sectorKey: () => 'emerald-span',
    sabF32: sab,
    playerToSlot: [],
    getActiveShip: () => undefined,
    swarmHealth: new Map<string, number>(),
    swarmRegistry: {
      get: (id: string) => registry.get(id),
    } as unknown as LivingWorldBotHooksDeps['swarmRegistry'],
    swarmSpawner: {
      // Mimic a successful spawn: create a registry record so the subsequent
      // markBotHostileToFaction can resolve `rec`.
      spawnDrone: (spec: { id: string }): boolean => {
        registry.set(spec.id, {
          id: spec.id,
          entityId: nextEntityId++,
          slot: nextSlot++,
        } as unknown as SwarmEntityRecord);
        return true;
      },
    } as unknown as LivingWorldBotHooksDeps['swarmSpawner'],
    aiController: {
      markHostile: (droneId: string, targetId: string): void => {
        marks.push({ droneId, targetId });
      },
    },
    evictSwarmEntity: () => {},
    extendBroadcastGrace: () => {},
    joinBroadcastGraceTicks: 300,
    broadcastWarpIn: () => {},
    broadcastWarpOut: () => {},
    broadcastBotAggro: (msg: BotAggroEvent): void => {
      aggros.push(msg);
    },
    bus: { emit: () => {} } as unknown as LivingWorldBotHooksDeps['bus'],
    clients: [] as unknown as LivingWorldBotHooksDeps['clients'],
  };

  return { hooks: new LivingWorldBotHooks(deps), marks, aggros, registry, sab };
}

describe('LivingWorldBotHooks.spawnBot — inline hostility at spawn (WS-E #15)', () => {
  let env: ReturnType<typeof makeHooks>;
  beforeEach(() => {
    env = makeHooks();
  });

  it('marks the bot hostile to the faction (player + structures) INLINE at spawn', () => {
    const ok = env.hooks.spawnBot({
      botId: 'lwbot-3',
      kind: DEFAULT_SHIP_KIND,
      x: 100,
      y: 200,
      hostileToFaction: { playerId: 'alice', structureIds: ['pstruct-1', 'pstruct-2'] },
    });
    expect(ok).toBe(true);

    // The pilot + every structure id were marked hostile IN THE SAME spawnBot
    // call (no control-tick gap) — this is the fix for "renders neutral on arrival".
    const targets = env.marks.filter((m) => m.droneId === 'lwbot-3').map((m) => m.targetId);
    expect(targets).toContain('alice');
    expect(targets).toContain('pstruct-1');
    expect(targets).toContain('pstruct-2');

    // And the owner's radar gets a bot_aggro for the pilot at spawn time.
    const aggro = env.aggros.find((a) => a.targetPlayerId === 'alice');
    expect(aggro).toBeDefined();
    expect(aggro!.type).toBe('bot_aggro');
    // The wire id is the swarm entity id, not the internal botId.
    expect(aggro!.botEntityId).toMatch(/^swarm-/);
  });

  it('does NOT mark hostility when spawned without a hostileToFaction (roaming/neutral spawn)', () => {
    const ok = env.hooks.spawnBot({ botId: 'lwbot-4', kind: DEFAULT_SHIP_KIND, x: 0, y: 0 });
    expect(ok).toBe(true);
    expect(env.marks).toHaveLength(0);
    expect(env.aggros).toHaveLength(0);
  });

  it('does NOT mark hostility when the spawn itself fails (no record to mark)', () => {
    // Force a spawn failure: swarmSpawner returns false.
    const marks: Array<{ droneId: string; targetId: string }> = [];
    const failHooks = new LivingWorldBotHooks({
      serverTick: () => 0,
      sectorKey: () => null,
      sabF32: new Float32Array(1024),
      playerToSlot: [],
      getActiveShip: () => undefined,
      swarmHealth: new Map(),
      swarmRegistry: { get: () => undefined } as unknown as LivingWorldBotHooksDeps['swarmRegistry'],
      swarmSpawner: { spawnDrone: () => false } as unknown as LivingWorldBotHooksDeps['swarmSpawner'],
      aiController: { markHostile: (d: string, t: string) => marks.push({ droneId: d, targetId: t }) },
      evictSwarmEntity: () => {},
      extendBroadcastGrace: () => {},
      joinBroadcastGraceTicks: 0,
      broadcastWarpIn: () => {},
      broadcastWarpOut: () => {},
      broadcastBotAggro: () => {},
      bus: { emit: () => {} } as unknown as LivingWorldBotHooksDeps['bus'],
      clients: [] as unknown as LivingWorldBotHooksDeps['clients'],
    });
    const ok = failHooks.spawnBot({
      botId: 'lwbot-9',
      kind: DEFAULT_SHIP_KIND,
      x: 0,
      y: 0,
      hostileToFaction: { playerId: 'bob', structureIds: ['s1'] },
    });
    expect(ok).toBe(false);
    expect(marks).toHaveLength(0);
  });
});
