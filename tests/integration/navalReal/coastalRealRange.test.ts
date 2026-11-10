/**
 * Real-scale naval ranges (ranges plan slice 14, owner decision 2026-11-10),
 * through a real SectorRoom: under `EQX_NAVAL_RANGE=real` a coastal 16"
 * barbette engages a battleship ~30 km away (far past the legacy 5,376 u
 * reach) and its shell flies the ~30 s to it and hits.
 *
 * Runs only with the switch on: `pnpm test:naval-real` (vitest.naval-real.config.ts
 * sets the env before any module loads; the main integration config excludes
 * this folder because its single shared worker builds the catalogue once).
 *
 * The battery is the coastal-duel showcase's; the battleship sits due north of
 * the 16" barbette, inside its ±72° arc. `lockTimeCapS: 1` skips the long
 * heavy-gun lock (this test is about reach and flight, not lock time).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from '../sectorRoom/harness.js';
import { SHOWCASE_COASTAL_DUEL_OPTS, SHOWCASE_PILOT_ID } from '../../../src/server/rooms/showcaseRooms.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getWeapon, weaponAutoFireRange } from '../../../src/core/combat/WeaponCatalogue.js';
import { NAVAL_RANGE } from '../../../src/shared-types/combat/navalRange.js';
import { getStructureKind } from '../../../src/shared-types/structureKinds.js';

const RANGE = 30_000;

describe.runIf(NAVAL_RANGE === 'real')('real naval ranges — a 16" barbette vs a battleship at 30 km', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('the barbette engages at ~30 km and its shell reaches the battleship', { timeout: 90_000 }, async () => {
    const xl = getWeapon('naval_xl');
    expect(weaponAutoFireRange(xl), 'the switch is on: the 16" reaches 38.7 km').toBeGreaterThan(38_000);
    expect(getStructureKind('coastal_barbette_16in').weaponRange).toBeGreaterThan(38_000);

    const opts = structuredClone(SHOWCASE_COASTAL_DUEL_OPTS) as unknown as Record<string, unknown>;
    const barbettePose = (opts['prebuiltStructures'] as Array<{ kind: string; x: number; y: number }>)
      .find((s) => s.kind === 'coastal_barbette_16in')!;
    opts['dronePoses'] = [{ kind: 'battleship', x: barbettePose.x, y: barbettePose.y + RANGE, angle: Math.PI / 2 }];
    opts['lockTimeCapS'] = 1;
    harness = await bootSectorTestServer(opts as Parameters<typeof bootSectorTestServer>[0]);
    const cr = await harness.connectActive(SHOWCASE_PILOT_ID, { shipKind: 'fighter', initialHull: 1_000_000, noselfdmg: 1 });
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    const internal = room._internals;
    for (let i = 0; i < 5; i++) internal.pulseStructureGrid();

    const bs = [...internal.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship');
    expect(bs, 'the room has a battleship').toBeDefined();
    const barbette = [...internal.structureRegistry.all()].find((r) => r.kind === 'coastal_barbette_16in');
    expect(barbette).toBeDefined();
    const bsIds = new Set([bs!.id, `swarm-${bs!.entityId}`, String(bs!.entityId)]);

    // A 16" hit on the battleship, and where it landed.
    let hit: DamageEvent | null = null;
    let hitAtMs = 0;
    cr.onMessage('damage', (e: DamageEvent) => {
      if (hit === null && bsIds.has(e.targetId) && e.damage === xl.damage) { hit = e; hitAtMs = Date.now(); }
    });

    cr.send('test_aggro', { type: 'test_aggro' });
    let firedAtMs = 0;
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline && hit === null) {
      await new Promise((r) => setTimeout(r, 100));
      if (firedAtMs === 0 && barbette!.lastTurretFireMs !== undefined) firedAtMs = Date.now();
    }

    expect(firedAtMs, 'the 16" barbette fired at a battleship 30 km away').toBeGreaterThan(0);
    expect(hit, 'a 16" shell hit the battleship').not.toBeNull();
    const h = hit as unknown as DamageEvent;
    // It landed ~30 km from the barbette (the battleship may have moved a little).
    const d = Math.hypot((h.hitX ?? 0) - barbette!.x, (h.hitY ?? 0) - barbette!.y);
    // Measured 2026-11-10: hit at 29,664 u after 22.5 s.
    expect(d, 'the hit landed ~30 km out').toBeGreaterThan(25_000);
    // Time of flight real ÷ 3: 1,290 u/s, so ~19 s to 25 km and ~23 s to
    // 29.7 km. (The 11" fires too; the hit asserted is a 16" one by its damage.)
    expect(hitAtMs - firedAtMs, 'the shell flew for ~20 s').toBeGreaterThan(17_000);
  });
});
