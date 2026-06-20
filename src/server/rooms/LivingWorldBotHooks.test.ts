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
import type { BotAggroEvent, WarpOutEvent } from '../../shared-types/messages.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';

/** Build a hooks instance over hand-rolled deps; expose the captured side
 *  effects (markHostile ledger writes + bot_aggro broadcasts). */
function makeHooks(): {
  hooks: LivingWorldBotHooks;
  marks: Array<{ droneId: string; targetId: string }>;
  aggros: BotAggroEvent[];
  warpOuts: WarpOutEvent[];
  evicted: SwarmEntityRecord[];
  registry: Map<string, SwarmEntityRecord>;
  sab: Float32Array;
} {
  const marks: Array<{ droneId: string; targetId: string }> = [];
  const aggros: BotAggroEvent[] = [];
  const warpOuts: WarpOutEvent[] = [];
  const evicted: SwarmEntityRecord[] = [];
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
      // markBotHostileToFaction / despawnBot can resolve `rec`. `slot` lets the
      // despawn-carry test write a known SAB pose at the record's slot.
      spawnDrone: (spec: { id: string; kind?: string }): boolean => {
        registry.set(spec.id, {
          id: spec.id,
          entityId: nextEntityId++,
          slot: nextSlot++,
          shipKind: spec.kind ?? DEFAULT_SHIP_KIND,
        } as unknown as SwarmEntityRecord);
        return true;
      },
    } as unknown as LivingWorldBotHooksDeps['swarmSpawner'],
    aiController: {
      markHostile: (droneId: string, targetId: string): void => {
        marks.push({ droneId, targetId });
      },
    },
    evictSwarmEntity: (rec: SwarmEntityRecord): void => {
      evicted.push(rec);
    },
    extendBroadcastGrace: () => {},
    joinBroadcastGraceTicks: 300,
    broadcastWarpIn: () => {},
    broadcastWarpOut: (msg: WarpOutEvent): void => {
      warpOuts.push(msg);
    },
    broadcastBotAggro: (msg: BotAggroEvent): void => {
      aggros.push(msg);
    },
    bus: { emit: () => {} } as unknown as LivingWorldBotHooksDeps['bus'],
    clients: [] as unknown as LivingWorldBotHooksDeps['clients'],
  };

  return { hooks: new LivingWorldBotHooks(deps), marks, aggros, warpOuts, evicted, registry, sab };
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

/**
 * LivingWorldBotHooks.despawnBot — carries the LIVE SAB world pose (WS-E #13/#19).
 *
 * ADVERSARIAL-REVIEW FIX. The first-round carry-over lock
 * (`HunterBotWarpController.test.ts`) HARDCODES the carry `{x,y}` in its mock
 * `despawnLivingWorldBot`, so reverting the REAL `despawnBot` SAB read left it
 * green. This test drives the REAL `despawnBot`: it writes a KNOWN world pose
 * into the SAB at the bot's slot offsets, despawns, and asserts the returned
 * carry carries THAT pose (x/y/vx/vy/angle/angvel). Revert the SAB x/y capture
 * ⇒ this goes RED (carry.x/y read 0, not the seeded pose). It also confirms the
 * despawn is QUIET (evict with no destroyed/broadcast — the despawn must not look
 * like a kill, the director's respawn trigger).
 */
describe('LivingWorldBotHooks.despawnBot — carries the live SAB world pose (WS-E #13/#19)', () => {
  let env: ReturnType<typeof makeHooks>;
  beforeEach(() => {
    env = makeHooks();
  });

  it('reads the bot\'s live SAB x/y/vx/vy/angle/angvel into the carry', () => {
    // Spawn so the registry holds a record at slot 0.
    expect(env.hooks.spawnBot({ botId: 'lwbot-7', kind: DEFAULT_SHIP_KIND, x: 0, y: 0 })).toBe(true);
    const rec = env.registry.get('lwbot-7')!;

    // Write a KNOWN live world pose into the SAB at the record's slot — this is
    // what the physics worker would have written; despawn must read it back.
    const b = slotBase(rec.slot);
    const sab = env.sab;
    sab[b + SLOT_X_OFF] = 1234.5;
    sab[b + SLOT_Y_OFF] = -987.25;
    sab[b + SLOT_VX_OFF] = 7.5;
    sab[b + SLOT_VY_OFF] = -3.25;
    sab[b + SLOT_ANGLE_OFF] = 1.5;
    sab[b + SLOT_ANGVEL_OFF] = -0.5;

    const carry = env.hooks.despawnBot('lwbot-7');

    expect(carry).not.toBeNull();
    // The HEADLINE lock for #13/#19: the despawn captures the LIVE SAB position,
    // so a hop can arrive near where the bot left (vs the old all-stack-at-edge).
    expect(carry!.x).toBe(1234.5);
    expect(carry!.y).toBe(-987.25);
    expect(carry!.vx).toBe(7.5);
    expect(carry!.vy).toBe(-3.25);
    expect(carry!.angle).toBe(1.5);
    expect(carry!.angvel).toBe(-0.5);

    // The warp_out broadcast carries the SAME live pose (the visual hop-out).
    const out = env.warpOuts.find((w) => w.playerId === 'lwbot-7');
    expect(out).toBeDefined();
    expect(out!.x).toBe(1234.5);
    expect(out!.y).toBe(-987.25);

    // QUIET despawn: the record is evicted (transit, not a kill).
    expect(env.evicted).toContain(rec);
  });

  it('returns null when the bot is not in the registry (already gone)', () => {
    expect(env.hooks.despawnBot('lwbot-unknown')).toBeNull();
  });
});
