/**
 * Integration coverage for the SectorRoom Living World hooks
 * (`spawnLivingWorldBot` / `despawnLivingWorldBot` / `markBotHostile` /
 * `playerCount` / `hasFreeSlot`).
 *
 * Why integration, not a hand-rolled unit mock: these hooks reuse the
 * real swarm machinery (SwarmSpawner → physics worker SPAWN_OBSTACLE,
 * SwarmEntityRegistry, evictSwarmEntity) AND emit wire broadcasts
 * (`warp_in` / `warp_out` / `bot_aggro`). Per src/server/CLAUDE.md, a new
 * visible entity must be exercised across the real Colyseus WebSocket so
 * a marshalling / quiet-teardown regression can't hide in a mock.
 *
 * The single-sector harness is sufficient here — the cross-room hop
 * (BotTransitController / LivingWorldDirector) is covered separately once
 * the harness gains multi-sector support (Step 5).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type {
  WarpInEvent,
  WarpOutEvent,
  BotAggroEvent,
  DestroyEvent,
} from '../../../src/shared-types/messages.js';
import { SHIP_KINDS_LIST, getShipKind } from '../../../src/shared-types/shipKinds.js';

const KIND = SHIP_KINDS_LIST[0]!.id;

describe('SectorRoom — Living World Director hooks', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('spawns, aggros and quietly hands off a bot across the real wire', async () => {
    const pid = randomUUID();
    const room = await harness.connectActive(pid, { shipKind: KIND });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const warpIns: WarpInEvent[] = [];
    const warpOuts: WarpOutEvent[] = [];
    const aggros: BotAggroEvent[] = [];
    const destroys: DestroyEvent[] = [];
    room.onMessage('warp_in', (m: WarpInEvent) => warpIns.push(m));
    room.onMessage('warp_out', (m: WarpOutEvent) => warpOuts.push(m));
    room.onMessage('bot_aggro', (m: BotAggroEvent) => aggros.push(m));
    room.onMessage('destroy', (m: DestroyEvent) => destroys.push(m));

    const server = harness.getServerRoom() as unknown as SectorRoom;
    expect(server.playerCount()).toBe(1);
    expect(server.hasFreeSlot()).toBe(true);
    expect(server.despawnLivingWorldBot('not-a-bot')).toBeNull();

    // ── spawn ────────────────────────────────────────────────────────────
    const ok = server.spawnLivingWorldBot({ botId: 'lwbot-0', kind: KIND, x: 123, y: -456 });
    expect(ok).toBe(true);
    await harness.advance(200);
    const wi = warpIns.find((m) => Math.round(m.x) === 123 && Math.round(m.y) === -456);
    expect(wi).toBeDefined();
    expect(wi!.type).toBe('warp_in');

    // ── aggro (existing markHostile channel + discrete bot_aggro) ─────────
    server.markBotHostile('lwbot-0');
    await harness.advance(200);
    const ag = aggros.find((m) => m.targetPlayerId === pid);
    expect(ag).toBeDefined();
    expect(ag!.botEntityId.startsWith('swarm-')).toBe(true);
    expect(typeof ag!.tick).toBe('number');

    // ── quiet inter-sector handoff ───────────────────────────────────────
    const carry = server.despawnLivingWorldBot('lwbot-0');
    expect(carry).not.toBeNull();
    expect(carry!.kind).toBe(KIND);
    expect(carry!.health).toBe(getShipKind(KIND).maxHealth);
    await harness.advance(200);

    // warp_out is broadcast, but the bot's removal must NOT look like a
    // combat kill: no `destroy` message reaches the client (that is the
    // director's ENTITY_DESTROYED respawn trigger; a transit must not
    // fire it).
    expect(warpOuts.length).toBeGreaterThanOrEqual(1);
    expect(destroys.some((d) => d.shooterId === '' || d.targetId.startsWith('swarm-'))).toBe(false);

    // Slot was reclaimed by the reused evictSwarmEntity teardown.
    expect(server.hasFreeSlot()).toBe(true);
    expect(server.despawnLivingWorldBot('lwbot-0')).toBeNull();
  }, 25_000);
});
