/**
 * MUST-FIX #1 (Phase 4 review, plan: effervescent-umbrella, invariant #13) —
 * the NON-PHYSICS stat upgrades (maxHull / shield / energy) MOVE the effective
 * value on the live authoritative hull. Before the fix, `deriveStatMultipliers`
 * returned all six factors but only `topSpeed`/`turnRate` were ever read by the
 * server, so spending points on hull/shield/energy was a SILENT no-op (and
 * typecheck + unit tests did NOT catch it).
 *
 * This drives the REAL `apply_ship_upgrade` message through a real galaxy room +
 * colyseus.js client (the same chain `shipUpgradeApply.test.ts` locks for
 * persistence) and asserts the LIVE ShipState's caps actually grow, plus the
 * respec/clamp (a respec that lowers a cap must not leave current above it).
 *
 * The companion damage proof lives at
 * `src/server/rooms/PlayerFireResolver.damageMul.test.ts`; the pure helper unit
 * lock at `src/core/leveling/shipStats.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import {
  effectiveShipMaxHealth,
  effectiveShipShieldMax,
  effectiveShipEnergyMax,
} from '../../../src/core/leveling/shipStats.js';
import type { DamageEvent, ShipUpgradeAppliedEvent } from '../../../src/shared-types/messages.js';

interface RoomInternals {
  applyDamage: (targetId: string, shooterId: string, damage: number) => void;
}
function internals(room: SectorRoom): RoomInternals {
  return (room as unknown as { _internals: RoomInternals })._internals;
}

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

function shipInstanceFor(room: SectorRoom, playerId: string): string {
  const state = (room as unknown as { state: SectorState }).state;
  for (const [shipInstanceId, ship] of state.ships) {
    if (ship.playerId === playerId && ship.isActive) return shipInstanceId;
  }
  throw new Error(`no active hull for ${playerId}`);
}

function nextEcho(
  room: { onMessage: (t: string, cb: (m: ShipUpgradeAppliedEvent) => void) => void },
  shipId: string,
  timeoutMs = 2000,
): Promise<ShipUpgradeAppliedEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ship_upgrade_applied echo')), timeoutMs);
    room.onMessage('ship_upgrade_applied', (m: ShipUpgradeAppliedEvent) => {
      if (m.shipInstanceId !== shipId) return;
      clearTimeout(timer);
      resolve(m);
    });
  });
}

describe('SectorRoom integration — non-physics stat upgrades move the value', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a hull/shield allocation raises the caps the client reads off the DamageEvent (the dead-code fix)', async () => {
    const player = randomUUID();
    const cr = await harness.connectActive(player, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === player });
    const room = getRoomById(cr.roomId);
    const shipId = shipInstanceFor(room, player);
    const state = (room as unknown as { state: SectorState }).state;
    // Read the ACTUAL spawned kind (the harness may not honour the requested
    // shipKind) so expectations are derived from the real hull.
    const ship0 = state.ships.get(shipId)!;
    const kind = getShipKind(ship0.kind);

    // Grant a budget (level 7 ⇒ 6 points) and spend on hull + shield.
    getPlayerShipStore().setProgress(shipId, { level: 7 });
    const alloc = { hull: 2, shield: 2 };

    const echoP = nextEcho(cr, shipId);
    cr.send('apply_ship_upgrade', { type: 'apply_ship_upgrade', shipId, alloc });
    await echoP;

    // The stored hull cap (durable field) reflects the upgrade.
    const ship = state.ships.get(shipId)!;
    const baseHull = effectiveShipMaxHealth(kind.maxHealth, {});
    const baseShield = effectiveShipShieldMax(kind.shieldMax, {});
    expect(effectiveShipMaxHealth(kind.maxHealth, alloc)).toBeGreaterThan(baseHull);
    expect(ship.maxHealth).toBe(effectiveShipMaxHealth(kind.maxHealth, alloc));

    // The CLIENT-FACING denominators ride the DamageEvent — capture one and
    // assert the server now computes the UPGRADED shieldMax + hullMax so a
    // maxHull/shield-upgraded ship's bars read correctly (the desync check).
    const dmgP = new Promise<DamageEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no damage event')), 2000);
      cr.onMessage('damage', (m: DamageEvent) => {
        if (m.targetId !== player) return;
        clearTimeout(timer);
        resolve(m);
      });
    });
    internals(room).applyDamage(player, '', 5);
    const dmg = await dmgP;

    expect(dmg.hullMax).toBe(effectiveShipMaxHealth(kind.maxHealth, alloc));
    expect(dmg.hullMax).toBeGreaterThan(baseHull);
    expect(dmg.shieldMax).toBe(effectiveShipShieldMax(kind.shieldMax, alloc));
    expect(dmg.shieldMax).toBeGreaterThan(baseShield);
  });

  it('a respec CLAMPS current hull/shield/energy down to the lowered cap (no over-max)', async () => {
    const player = randomUUID();
    const cr = await harness.connectActive(player, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === player });
    const room = getRoomById(cr.roomId);
    const shipId = shipInstanceFor(room, player);
    const state = (room as unknown as { state: SectorState }).state;
    const kind = getShipKind('fighter');

    getPlayerShipStore().setProgress(shipId, { level: 7 });

    // Upgrade hull/shield/energy first (caps grow, current values seeded full).
    const echo1 = nextEcho(cr, shipId);
    cr.send('apply_ship_upgrade', { type: 'apply_ship_upgrade', shipId, alloc: { hull: 2, shield: 2, energy: 2 } });
    await echo1;
    const upgraded = state.ships.get(shipId)!;
    const upgradedHull = upgraded.maxHealth;
    // Set current hull to the (raised) max so the clamp is observable on respec.
    upgraded.health = upgradedHull;
    upgraded.shield = effectiveShipShieldMax(kind.shieldMax, { shield: 2 });
    upgraded.energy = effectiveShipEnergyMax(kind.energyMax ?? 100, { energy: 2 });

    // Respec — caps drop back to the kind base; current values must clamp DOWN.
    const echo2 = nextEcho(cr, shipId);
    cr.send('respec_ship', { type: 'respec_ship', shipId });
    await echo2;

    const ship = state.ships.get(shipId)!;
    expect(ship.maxHealth).toBe(effectiveShipMaxHealth(kind.maxHealth, {}));
    expect(ship.health).toBeLessThanOrEqual(ship.maxHealth); // clamped, not above max
    expect(ship.shield).toBeLessThanOrEqual(effectiveShipShieldMax(kind.shieldMax, {}));
    expect(ship.energy).toBeLessThanOrEqual(effectiveShipEnergyMax(kind.energyMax ?? 100, {}));
    // The clamp must NOT have FREE-HEALED — hull stays at the new max (it was full).
    expect(ship.health).toBe(ship.maxHealth);
  });
});
