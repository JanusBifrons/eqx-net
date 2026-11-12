/**
 * A battleship against a coastal battery, through a real SectorRoom.
 *
 * Reported 2026-11-10 from a frame-by-frame review of the `coastal-duel`
 * showcase shot (room `showcase-coastal-duel`) filmed on main: "The battleship
 * never fires. Its main turrets stay trained fore and aft for the whole clip
 * and never turn toward the coastal battery."
 *
 * Root cause (a real bug, older than lock-to-fire: the room behaves the same
 * on the commit before #385): NPC capital turrets only ever took PILOTS as
 * targets (`WeaponMountTicker.tickDrone` built the candidate list from
 * players) and a capital never fires as a hull (`AiFireResolver.resolve`
 * returns early for it), so a battleship could not shoot a structure at all,
 * even one that was shelling it.
 *
 * This test uses the showcase room's battery but parks the battleship where
 * every gun and the battleship's 16" guns can reach (~3,100-3,550 u). The
 * showcase room's own 5,200 u is out of the 8" casemate's (3,542 u) and 11"
 * turret's (4,862 u) reach, and of the battleship's guns (~3,584 u), by
 * layout; that is reported, not changed.
 *
 * The pilot joins as the shot does (fighter, huge hull) and sends
 * `test_aggro`. No `instantLock`: every gun completes a real lock (#19).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_COASTAL_DUEL_OPTS, SHOWCASE_PILOT_ID } from '../../../src/server/rooms/showcaseRooms.js';
import type { ShellSalvo } from '../../../src/shared-types/messages/shellEvents.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

const BATTERY = ['coastal_casemate_8in', 'coastal_turret_11in', 'coastal_barbette_16in'] as const;

describe('SectorRoom integration — battleship vs coastal battery', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('the battery fires on the battleship, and the battleship trains on the battery and fires back', { timeout: 60_000 }, async () => {
    const opts = structuredClone(SHOWCASE_COASTAL_DUEL_OPTS) as unknown as Record<string, unknown>;
    // In reach of the whole battery (8" casemate at x -1800 is the far one:
    // ~3,500 u) and of the battleship's own 16" guns.
    opts['dronePoses'] = [{ kind: 'battleship', x: -900, y: 2700, angle: Math.PI / 2 }];
    harness = await bootSectorTestServer(opts);
    const cr = await harness.connectActive(SHOWCASE_PILOT_ID, { shipKind: 'fighter', initialHull: 1_000_000, noselfdmg: 1 });
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    const internal = room._internals;
    for (let i = 0; i < 5; i++) internal.pulseStructureGrid();

    const bs = [...internal.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship');
    expect(bs, 'the room has a battleship').toBeDefined();
    const guns = [...internal.structureRegistry.all()].filter((r) => (BATTERY as readonly string[]).includes(r.kind));
    expect(guns.map((g) => g.kind).sort()).toEqual([...BATTERY].sort());
    const gunIds = new Set(guns.map((g) => g.id));
    const allIds = new Set([...internal.structureRegistry.all()].map((r) => r.id));

    // The battleship's shells, and whether a turret of it is on a structure.
    const bsOwner = `swarm-${bs!.entityId}`;
    let bsShells = 0;
    // Naval shells travel as events (shell-events.md slice 4).
    cr.onMessage('shell_salvo', (m: ShellSalvo) => {
      if (m.o === bsOwner) bsShells += m.sh.length;
    });
    const mountTargets = (room as unknown as { mountTicker: { droneMountTargetIds: Map<string, (string | null)[]> } })
      .mountTicker.droneMountTargetIds;
    let bsOnBattery = false;

    cr.send('test_aggro', { type: 'test_aggro' });
    const done = (): boolean => bsShells > 0 && bsOnBattery && guns.every((g) => g.lastTurretFireMs !== undefined);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !done()) {
      await new Promise((r) => setTimeout(r, 200));
      if ((mountTargets.get(bs!.id) ?? []).some((t) => t !== null && allIds.has(t))) bsOnBattery = true;
    }

    for (const g of guns) expect(g.lastTurretFireMs, `the ${g.kind} trained on the battleship and fired`).toBeDefined();
    expect(bsOnBattery, 'a battleship turret trained on a structure of the battery').toBe(true);
    expect(bsShells, 'the battleship fired at the battery').toBeGreaterThan(0);
    expect(gunIds.size).toBe(3);
  });
});
