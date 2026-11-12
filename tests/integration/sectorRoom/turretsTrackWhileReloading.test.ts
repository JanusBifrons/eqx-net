/**
 * A turret keeps tracking its target while it reloads (integration probe
 * report, 2026-11-12, showcase-capital-duel).
 *
 * Report: a hostile battleship locks a heavy cruiser 4,000 u off its beam,
 * its 16" turrets train on and fire a volley, then during the 30 s reload the
 * turrets slew back toward home at 4°/s although the target is still there.
 *
 * Finding: the turrets do NOT home because they are reloading. In the probe the
 * fight was started by ONE `test_aggro` and the pilot never fought back, so the
 * battleship's hostility decayed 30 s after the cue (`FORGET_TICKS`, the
 * owner's rule: 30 s after the last hit on the drone or the end of the pilot's
 * last lock on it). The volley lands at ~18-28 s, so the decay falls inside
 * the reload; the NPC lock drops on the next lock step and only then does the
 * turret, with no target, go home. That is the documented "no target ⇒ home".
 *
 * This test locks the contract the report asked for: while the battleship
 * stays hostile and keeps its lock, every 16" turret that has fired stays on
 * the bearing to its target for the whole reload. Hostility is kept alive by
 * re-sending `test_aggro` (standing in for a pilot who fights back), and the
 * test checks that premise on every sample so it can't pass vacuously.
 *
 * Layout: the duel room with the battleship turned so the pilot sits 40° off
 * its bow (the forward turrets bear in ~10 s instead of ~25 s), as in
 * spectateStillTargeted.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_CAPITAL_DUEL_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { ShellSalvo } from '../../../src/shared-types/messages/shellEvents.js';
import { getShipKind, type WeaponMount, type ShipKind } from '../../../src/shared-types/shipKinds.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { wrapPi } from '../../../src/core/ai/WeaponMountController.js';
import { SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase } from '../../../src/shared-types/sabLayout.js';

/** How far a fired 16" barrel may sit from the bearing to its target while it
 *  reloads. The aim is the shell's lead point, a few degrees off the bearing
 *  at most; a turret homing at 4°/s leaves this band in a few seconds. */
const MAX_OFF_BEARING_DEG = 10;

interface RoomPeek {
  mountTicker: { droneMountAngles: Map<string, Float32Array>; droneMountReload: Map<string, Int32Array> };
  sabF32: Float32Array;
  shipPoseCache: Map<string, { x: number; y: number }>;
  aiController: { getBehaviour(id: string): { hostileTo?: Set<string> } | undefined };
  npcLocks: { isLocked(npcId: string, pilotId: string): boolean };
  resolveSlotMounts(kind: ShipKind): ReadonlyArray<WeaponMount>;
}

describe('SectorRoom integration — capital turrets track while reloading', () => {
  let harness: SectorTestHarness;
  let keepHostile: ReturnType<typeof setInterval> | undefined;
  beforeEach(async () => {
    const d = SHOWCASE_CAPITAL_DUEL_OPTS;
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      peacefulDrones: d.peacefulDrones,
      pilotCapitals: d.pilotCapitals,
      prebuiltStructures: d.prebuiltStructures,
      defaultSpawnX: d.defaultSpawnX,
      defaultSpawnY: d.defaultSpawnY,
      dronePoses: [{ kind: 'battleship', x: 0, y: 0, angle: (-50 * Math.PI) / 180 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (keepHostile) clearInterval(keepHostile);
    keepHostile = undefined;
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a 16" turret that has fired stays on its locked target through the reload', { timeout: 90_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0,
    });
    const server = harness.getServerRoom() as unknown as SectorRoom;
    const peek = server as unknown as RoomPeek;
    const npc = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    expect(npc).toBeDefined();
    const mounts = peek.resolveSlotMounts(getShipKind('battleship'));
    const xl = mounts.map((m, i) => (m.weaponId === 'naval_xl' ? i : -1)).filter((i) => i >= 0);
    expect(xl.length).toBeGreaterThan(0);

    let firstSalvoAt = 0;
    cr.onMessage('shell_salvo', (m: ShellSalvo) => {
      if (m.w === 'naval_xl' && firstSalvoAt === 0) firstSalvoAt = Date.now();
    });
    const aggro = (): void => cr.send('test_aggro', { type: 'test_aggro' });
    aggro();
    keepHostile = setInterval(aggro, 5000);

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && firstSalvoAt === 0) await new Promise((r) => setTimeout(r, 100));
    expect(firstSalvoAt, 'the battleship never fired a 16" volley').toBeGreaterThan(0);

    const reloadMs = (getWeapon('naval_xl').cooldownTicks / 60) * 1000;
    const sampleUntil = firstSalvoAt + reloadMs - 3000; // inside the reload
    const b = slotBase(npc.slot);
    let samples = 0;
    while (Date.now() < sampleUntil) {
      await new Promise((r) => setTimeout(r, 500));
      // Premise: still hostile, still locked (else homing is correct).
      expect(peek.aiController.getBehaviour(npc.id)?.hostileTo?.has(pid), 'premise: battleship hostile').toBe(true);
      expect(peek.npcLocks.isLocked(npc.id, pid), 'premise: battleship holds its lock').toBe(true);
      const angles = peek.mountTicker.droneMountAngles.get(npc.id)!;
      const reload = peek.mountTicker.droneMountReload.get(npc.id)!;
      const pilot = peek.shipPoseCache.get(pid)!;
      const hx = peek.sabF32[b + SLOT_X_OFF]!, hy = peek.sabF32[b + SLOT_Y_OFF]!, ha = peek.sabF32[b + SLOT_ANGLE_OFF]!;
      const c = Math.cos(ha), s = Math.sin(ha);
      let checked = 0;
      for (const i of xl) {
        if (reload[i]! < 0) continue; // this turret hasn't fired yet
        const m = mounts[i]!;
        const mx = hx + (m.localX * c - m.localY * s);
        const my = hy + (m.localX * s + m.localY * c);
        const bearing = Math.atan2(-(pilot.x - mx), pilot.y - my);
        const barrel = ha + m.baseAngle + angles[i]!;
        const off = (Math.abs(wrapPi(barrel - bearing)) * 180) / Math.PI;
        expect(off, `${m.id} slewed ${off.toFixed(1)}° off its target ${((Date.now() - firstSalvoAt) / 1000).toFixed(1)} s into the reload`)
          .toBeLessThanOrEqual(MAX_OFF_BEARING_DEG);
        checked++;
      }
      expect(checked, 'no fired 16" turret to check').toBeGreaterThan(0);
      samples++;
    }
    expect(samples).toBeGreaterThan(20);
  });
});
