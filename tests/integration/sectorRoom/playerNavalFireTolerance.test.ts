/**
 * A player's naval turrets fire only when they will hit the aim point, like
 * the NPC capitals' (`TURRET_FIRE_MISS`), never while still slewing.
 *
 * Owner report (2026-11-12, long-guns clip): "The ship we are watching
 * hopelessly misses the broadside? The rear cannons missing by miles." The
 * player's fire gate (`PlayerFireResolver` → `mountBearsOnLock`) accepted any
 * barrel within `FC_MOUNT_FIRE_TOLERANCE` = 0.2 rad (11.5°) of the target. At
 * 30 km that is a ~6 km miss: the fore and aft turrets, training from their
 * bow and stern homes, fired 3-4° early and their shells fanned past both ends
 * of the target, while the NPC battleship's turrets (60 u rule) hit.
 *
 * Repro: a player battleship facing +y, a hostile battleship 5 km out 15° off
 * the bow. The forward 16" turrets start at home (dead ahead) and train at
 * 4°/s, so the old gate let them fire after ~1 s, still ~3.5° off. Every
 * accepted salvo must instead head at the target (within the 60 u miss rule).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { TURRET_FIRE_MISS } from '../../../src/core/combat/mountFireControl.js';
import { navalTurret, navalBarrelOffset } from '../../../src/core/combat/muzzle.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

const RANGE = 5_000;
const OFF_BOW = (15 * Math.PI) / 180;
// Ship-angle convention: forward = (-sin b, cos b).
const TX = -Math.sin(OFF_BOW) * RANGE;
const TY = Math.cos(OFF_BOW) * RANGE;

describe('SectorRoom integration — player naval turrets fire only on target', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, pilotCapitals: true, asteroidConfig: [],
      dronePoses: [{ kind: 'battleship', x: TX, y: TY, angle: Math.PI / 2 }],
    });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('every accepted main-battery salvo heads at the target, none fired while slewing', async () => {
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, {
      shipKind: 'battleship', spawnX: 0, spawnY: 0, initialHull: 1_000_000,
      groupMode: 'manual', instantLock: true, startHostile: true,
    })) as ClientRoom<SectorState>;
    const salvos: Array<{ x: number; y: number; vx: number; vy: number }> = [];
    room.onMessage('shell_salvo', (m: { o: string; sh: Array<[string, number, number, number, number]> }) => {
      if (m.o !== pid) return;
      for (const [, x, y, vx, vy] of m.sh) salvos.push({ x, y, vx, vy });
    });
    room.onMessage('*', () => { /* drain other messages */ });

    const server = harness.getServerRoom() as unknown as SectorRoom;
    const target = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    expect(target, 'the hostile battleship is in the room').toBeTruthy();
    // The pilot's groups and the target's pose settle a few ticks after join.
    const lockBy = Date.now() + 5_000;
    for (;;) {
      try { harness.lockTarget(pid, `s:${target.entityId}`, 'main'); break; } catch (e) {
        if (Date.now() > lockBy) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Ask the main battery to fire every 100 ms for 8 s, as a held trigger does,
    // while the forward turrets train the 15° from their home onto the target.
    for (let i = 0; i < 80; i++) {
      const tick = server._internals.serverTick;
      room.send('fire', { type: 'fire', tick, clientShotId: `m${i}`, weapon: 'naval_xl', dirAngle: 0, slotId: 'main' });
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(salvos.length, 'the battery fired once it was on target').toBeGreaterThan(0);
    // Each barrel fires parallel to the turret's aim from its own tip (#479),
    // so a shell may also pass up to its barrel's sideways offset off the line.
    const kind = getShipKind('battleship');
    const turret = navalTurret(kind, kind.mounts.find((m) => m.id === 'main-1'))!;
    let barrelSpread = 0;
    for (let k = 0; k < turret.barrels; k++) barrelSpread = Math.max(barrelSpread, Math.abs(navalBarrelOffset(turret, k)));
    for (const s of salvos) {
      const dx = TX - s.x;
      const dy = TY - s.y;
      const dist = Math.hypot(dx, dy);
      // Perpendicular miss distance of the shell's line from the target.
      const miss = Math.abs(dx * s.vy - dy * s.vx) / Math.hypot(s.vx, s.vy);
      expect(miss, `shell from (${s.x.toFixed(0)}, ${s.y.toFixed(0)}) passes ${miss.toFixed(0)} u from a target ${dist.toFixed(0)} u away`)
        .toBeLessThanOrEqual(TURRET_FIRE_MISS * 2 + barrelSpread);
    }
  }, 30_000);
});
