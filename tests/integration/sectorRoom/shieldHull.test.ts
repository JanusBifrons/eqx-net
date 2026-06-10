/**
 * Phase 3a + 3b lock — server shield/hull authority + DISCRETE shield
 * broadcast through the real SectorRoom.applyDamage + tickShieldRegen
 * paths (plan: clever-wombat).
 *
 * COVERS:
 *   1. A spawned ship seeds shield to kind.shieldMax (fighter = 100);
 *      hull is unchanged from today (ship.health).
 *   2. Damage < shield is fully absorbed; hull untouched; the broadcast
 *      DamageEvent carries { newShield, shieldMax, hullMax, hitLayer }
 *      and newHealth stays the hull value.
 *   3. The FINAL hit before the shield drops is FULLY absorbed (1e9 hit
 *      on a 70 shield -> shield 0, hull still untouched — no spillover).
 *      `shield_broken` diagnostic fires for the shipInstanceId.
 *   4. Shield down -> damage reaches the hull; hitLayer:'hull'.
 *   5. (3b) The regen ramp is delivered as EXACTLY two discrete `shield`
 *      messages (restored, regen_complete) — never per-tick, and nothing
 *      at all during the post-damage delay. `shield_restored` fires once.
 *
 * applyDamage is private; accessed via a typed cast — same sanctioned
 * white-box lifecycle pattern as wreckDamage.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ServerRoom } from 'colyseus';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState, ShipState } from '../../../src/server/rooms/schema/SectorState.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

interface ApplyDamageInternals {
  applyDamage: (targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number) => void;
}
function getRoomById(roomId: string): ServerRoom<SectorState> {
  return matchMaker.getLocalRoomById(roomId) as unknown as ServerRoom<SectorState>;
}
const FIGHTER = getShipKind('fighter');

describe('SectorRoom integration — shield/hull authority', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  async function joinFighter(): Promise<{
    pid: string;
    cr: ClientRoom<SectorState>;
    room: ServerRoom<SectorState>;
    state: SectorState;
    shipInstanceId: string;
    hull0: number;
    hullMax: number;
  }> {
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind: 'fighter' })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    const room = getRoomById(cr.roomId);
    const state = room.state as SectorState;
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) {
        return { pid, cr, room, state, shipInstanceId: s.shipInstanceId, hull0: s.health, hullMax: s.maxHealth };
      }
    }
    throw new Error('ship not found after join');
  }
  function findShip(state: SectorState, pid: string): ShipState {
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s;
    throw new Error('ship gone');
  }

  it('shield absorbs, the final hit is fully absorbed (no spillover), then hull takes damage', async () => {
    const { pid, cr, room, state, shipInstanceId, hull0, hullMax } = await joinFighter();
    const internal = room as unknown as ApplyDamageInternals;
    const dmg: Array<Record<string, unknown>> = [];
    cr.onMessage('damage', (e: Record<string, unknown>) => dmg.push(e));
    const shooter = randomUUID();

    expect(findShip(state, pid).shield).toBe(FIGHTER.shieldMax); // seeded full (100)
    expect(findShip(state, pid).health).toBe(hull0);

    const waitDamage = async (pred: (e: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const hit = dmg.find(pred);
        if (hit) return hit;
        await harness.advance(40);
      }
      throw new Error('damage broadcast not received');
    };

    internal.applyDamage(pid, shooter, 30);
    expect(findShip(state, pid).shield).toBe(FIGHTER.shieldMax - 30); // 70
    expect(findShip(state, pid).health).toBe(hull0); // hull untouched
    const e1 = await waitDamage((e) => e['targetId'] === pid && e['damage'] === 30);
    expect(e1).toMatchObject({
      newShield: FIGHTER.shieldMax - 30,
      shieldMax: FIGHTER.shieldMax,
      hullMax,
      hitLayer: 'shield',
      newHealth: hull0,
    });

    internal.applyDamage(pid, shooter, 1_000_000_000);
    expect(findShip(state, pid).shield).toBe(0);
    expect(findShip(state, pid).health).toBe(hull0); // STILL untouched — no spillover
    const e2 = await waitDamage((e) => e['targetId'] === pid && e['damage'] === 1_000_000_000);
    expect(e2).toMatchObject({ newShield: 0, hitLayer: 'shield', newHealth: hull0 });
    const broke = await harness.events.waitFor(
      { tag: 'shield_broken', where: (d) => d['entityId'] === shipInstanceId },
      { timeoutMs: 2000 },
    );
    expect(broke.data['kindId']).toBe('fighter');

    internal.applyDamage(pid, shooter, 25);
    expect(findShip(state, pid).shield).toBe(0);
    expect(findShip(state, pid).health).toBe(hull0 - 25);
    const e3 = await waitDamage((e) => e['targetId'] === pid && e['damage'] === 25);
    expect(e3).toMatchObject({ newShield: 0, hitLayer: 'hull', newHealth: hull0 - 25 });
  }, 30_000);

  it('shield regenerates after the delay; restored fires exactly once on the 0-cross', async () => {
    const { pid, room, state, shipInstanceId } = await joinFighter();
    const internal = room as unknown as ApplyDamageInternals;

    internal.applyDamage(pid, randomUUID(), 1_000_000_000); // break the shield
    expect(findShip(state, pid).shield).toBe(0);

    findShip(state, pid).shieldLastDamageTick = -100_000; // skip the 5 s delay

    await harness.advance(400);
    expect(findShip(state, pid).shield).toBeGreaterThan(0); // regen started
    await harness.events.waitFor(
      { tag: 'shield_restored', where: (d) => d['entityId'] === shipInstanceId },
      { timeoutMs: 2000 },
    );

    await harness.advance(4000); // ramp to full
    expect(findShip(state, pid).shield).toBe(FIGHTER.shieldMax); // clamped

    expect(
      harness.events.count({ tag: 'shield_restored', where: (d) => d['entityId'] === shipInstanceId }),
    ).toBe(1);
  }, 30_000);

  it('3b: the regen ramp is exactly two discrete shield messages — no continuous traffic', async () => {
    const { pid, cr, room, state } = await joinFighter();
    const internal = room as unknown as ApplyDamageInternals;
    const shieldMsgs: Array<Record<string, unknown>> = [];
    cr.onMessage('shield', (e: Record<string, unknown>) => shieldMsgs.push(e));

    internal.applyDamage(pid, randomUUID(), 1_000_000_000); // break
    expect(findShip(state, pid).shield).toBe(0);

    // During the post-damage delay there must be ZERO shield traffic
    // (break is delivered via the damage event, not a shield message).
    await harness.advance(500);
    expect(shieldMsgs).toHaveLength(0);

    // Skip the delay and let the shield fully regenerate.
    findShip(state, pid).shieldLastDamageTick = -100_000;
    await harness.advance(5000);
    expect(findShip(state, pid).shield).toBe(FIGHTER.shieldMax);

    // The whole 0->full ramp (~120 ticks) produced EXACTLY two messages:
    // one 'restored' (0-cross-up) and one 'regen_complete' — never per-tick.
    const restored = shieldMsgs.filter((m) => m['phase'] === 'restored');
    const complete = shieldMsgs.filter((m) => m['phase'] === 'regen_complete');
    expect(restored).toHaveLength(1);
    expect(complete).toHaveLength(1);
    expect(shieldMsgs).toHaveLength(2);
    expect(restored[0]).toMatchObject({ type: 'shield', targetId: pid, shieldMax: FIGHTER.shieldMax });
    expect(restored[0]!['shield']).toBeGreaterThan(0);
    expect(restored[0]!['shield']).toBeLessThan(FIGHTER.shieldMax);
    expect(complete[0]).toMatchObject({ shield: FIGHTER.shieldMax, shieldMax: FIGHTER.shieldMax });
  }, 30_000);
});
