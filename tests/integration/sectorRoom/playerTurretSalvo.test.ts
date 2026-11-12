/**
 * A player's multi-barrel naval turret fires every barrel, like an NPC's.
 *
 * Owner report (2026-11-12, long-guns clip): "Are the enemy shells brighter
 * for a reason? Is it because the focused ship isn't firing 9 shells?" A
 * probe of a beam-on battleship duel logged every 16" salvo: the NPC's
 * turrets fired 3 shells (one per barrel, `AiFireResolver`), the player's
 * fired 1 (`PlayerFireResolver` fired once per mount from the turret's
 * centreline). The rule (src/server/CLAUDE.md, fire gate) is that a
 * multi-barrel turret fires all its barrels together.
 *
 * Repro: a player battleship facing +y, a hostile battleship 5 km off its
 * starboard beam; hold the main battery's trigger. Every player main-battery
 * salvo must carry one shell per barrel, each from its own barrel tip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

const RANGE = 5_000;

describe('SectorRoom integration — a player turret fires all its barrels', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, pilotCapitals: true, asteroidConfig: [],
      dronePoses: [{ kind: 'battleship', x: RANGE, y: 0, angle: 0 }],
    });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('every main-battery salvo has one shell per barrel, from distinct barrel tips', async () => {
    const barrels = getShipKind('battleship').mounts.find((m) => m.id === 'main-1')!.barrels ?? 1;
    expect(barrels, 'the 16" turret has several barrels').toBeGreaterThan(1);
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, {
      shipKind: 'battleship', spawnX: 0, spawnY: 0, initialHull: 10_000_000,
      groupMode: 'manual', instantLock: true, startHostile: true,
    })) as ClientRoom<SectorState>;
    const salvos: Array<Array<[string, number, number, number, number]>> = [];
    room.onMessage('shell_salvo', (m: { o: string; w: string; sh: Array<[string, number, number, number, number]> }) => {
      if (m.o === pid && m.w === 'naval_xl') salvos.push(m.sh);
    });
    room.onMessage('*', () => { /* drain other messages */ });

    const server = harness.getServerRoom() as unknown as SectorRoom;
    const target = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    const lockBy = Date.now() + 5_000;
    for (;;) {
      try { harness.lockTarget(pid, `s:${target.entityId}`, 'main'); break; } catch (e) {
        if (Date.now() > lockBy) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // Hold the trigger until a salvo has gone (the turrets train ~90° at 4°/s first).
    const deadline = Date.now() + 40_000;
    for (let i = 0; Date.now() < deadline && salvos.length === 0; i++) {
      const tick = server._internals.serverTick;
      room.send('fire', { type: 'fire', tick, clientShotId: `m${i}`, weapon: 'naval_xl', dirAngle: 0, slotId: 'main' });
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));

    expect(salvos.length, 'the main battery fired').toBeGreaterThan(0);
    for (const sh of salvos) {
      expect(sh.length, `a 16" turret salvo: ${sh.length} shell(s) for ${barrels} barrels`).toBe(barrels);
      const tips = new Set(sh.map((s) => `${Math.round(s[1])},${Math.round(s[2])}`));
      expect(tips.size, 'each shell leaves its own barrel tip').toBe(barrels);
    }
  }, 60_000);
});
