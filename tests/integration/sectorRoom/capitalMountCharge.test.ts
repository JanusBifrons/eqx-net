/**
 * Charge-up on a capital turret through a real SectorRoom (plan step 6). No
 * catalogue weapon charges on a capital yet (the railgun comes later), so the
 * battleship's 5" gun is given a 'when-bearing', 'mount-glow' charge for the
 * test (the room runs in-process; restored after).
 *
 *  - The snapshot carries the charging turret's bit (`drones[].chargingMask`)
 *    and the charge's start tick (`chargeStartTick`), so a late joiner sees
 *    the charge at its true progress (#16).
 *  - The gun fires only after charging for `chargeTicks`: no 5" salvo leaves
 *    before the first charge was seen + `chargeTicks`.
 *  - The ship's death cancels its charges: the store drops them and no 5"
 *    salvo leaves afterwards.
 * The hold-while-not-bearing rule is locked deterministically in
 * tests/unit/capitalMountCharge.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import type { ShellSalvo } from '../../../src/shared-types/messages/shellEvents.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getWeapon, type WeaponDef } from '../../../src/core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

const CHARGE = 60;
type Mutable = { -readonly [K in keyof WeaponDef]?: WeaponDef[K] };

interface RoomPeek {
  mountTicker: { charges: { starts: Map<string, Int32Array> } };
}

describe('SectorRoom integration — capital turret charge-up', () => {
  let harness: SectorTestHarness;
  const def = getWeapon('naval_s') as Mutable;
  const saved = { chargeTicks: def.chargeTicks, chargeRelease: def.chargeRelease, chargeTelegraph: def.chargeTelegraph };
  beforeEach(async () => {
    def.chargeTicks = CHARGE;
    def.chargeRelease = 'when-bearing';
    def.chargeTelegraph = 'mount-glow';
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      // The pilot (origin) 40° off the battleship's bow, as capitalEngagement.
      dronePoses: [{ kind: 'battleship', x: 5000, y: 0, angle: (50 * Math.PI) / 180 }],
    });
  }, 15_000);
  afterEach(async () => {
    def.chargeTicks = saved.chargeTicks;
    def.chargeRelease = saved.chargeRelease;
    def.chargeTelegraph = saved.chargeTelegraph;
    if (harness) await harness.cleanup();
  }, 10_000);

  it('charges (snapshot mask + start), fires after chargeTicks, and death cancels the charge', { timeout: 60_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0, startHostile: true, instantLock: true,
    });
    const server = harness.getServerRoom() as unknown as SectorRoom;
    const npc = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    expect(npc).toBeDefined();
    const mounts = getShipKind('battleship').mounts;
    let sMask = 0;
    mounts.forEach((m, i) => { if (m.weaponId === 'naval_s' && i < 31) sMask |= 1 << i; });

    let firstStart = -1;
    let lastSnapMask = 0;
    let badBits = 0;
    let staleStart = false;
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      const d = snap.drones?.find((x) => x.id === npc.entityId);
      lastSnapMask = d?.chargingMask ?? 0;
      if (lastSnapMask === 0) return;
      badBits |= lastSnapMask & ~sMask;
      if (d!.chargeStartTick === undefined || d!.chargeStartTick > snap.serverTick) staleStart = true;
      if (firstStart < 0) firstStart = d!.chargeStartTick ?? -1;
    });
    const salvos: ShellSalvo[] = [];
    cr.onMessage('shell_salvo', (m: ShellSalvo) => { if (m.w === 'naval_s') salvos.push(m); });

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && salvos.length === 0) await new Promise((r) => setTimeout(r, 50));

    expect(firstStart, 'the snapshot never showed a charge').toBeGreaterThanOrEqual(0);
    expect(badBits, 'a non-charge mount reported charging').toBe(0);
    expect(staleStart, 'chargeStartTick missing or in the future').toBe(false);
    expect(salvos.length, 'the charged 5" never fired').toBeGreaterThan(0);
    for (const s of salvos) expect(s.t - firstStart, 'a 5" fired before its charge').toBeGreaterThanOrEqual(CHARGE);

    // Death mid-charge: wait for a charge, then kill the battleship.
    const until = Date.now() + 20_000;
    while (Date.now() < until && lastSnapMask === 0) await new Promise((r) => setTimeout(r, 20));
    expect(lastSnapMask, 'no second charge to cancel').not.toBe(0);
    const killTick = server._internals.serverTick;
    cr.send('test_kill_capitals', { type: 'test_kill_capitals' });
    const settle = Date.now() + 2 * (CHARGE / 60) * 1000 + 500;
    while (Date.now() < settle) await new Promise((r) => setTimeout(r, 50));
    const peek = server as unknown as RoomPeek;
    expect(peek.mountTicker.charges.starts.has(npc.id), 'the dead ship kept its charges').toBe(false);
    expect(salvos.filter((s) => s.t > killTick + 10).length, 'a dead ship fired its charge').toBe(0);
  });
});
