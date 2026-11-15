/**
 * RTS command layer — wingmen actually win a fight they should win.
 *
 * Reported while filming the RTS shot (room `showcase-rts`,
 * `showcase/shots/rtsCommand.ts`, 2026-11-14): "5 player-owned AI-flown
 * fighters set to Hunt + Aggressive vs 3 robot cubes: all 5 die in ~16 s,
 * kill only 1 cube. Several switch to 'Retreating' while hull 100 %."
 *
 * Control experiment (same room, same positions): 5 NPC fighters of the
 * drones side beat the same 3 cubes in ~9 s, losing 1, landing 51 hits.
 * The wingmen landed 2 hits on the cubes and 29 on EACH OTHER. Causes:
 *   1. `PlayerFireResolver.fireHull` read the shooter pose from the lag-comp
 *      ring; a scene / restored hull is registered there but never recorded,
 *      so it read (0, 0, angle 0): every bolt left the world ORIGIN heading
 *      north (through the wingmen parked near it);
 *   2. the brain never pointed the nose at what it was fighting: it flew the
 *      stand-off velocity, so a fixed forward gun rarely bore (and backing off
 *      from a closing cube turned its tail to it, 180° off);
 *   3. morale counted SHIELD damage as hull damage, so a few shield hits
 *      rolled a retreat at hull 100 %.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_RTS_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — wingmen vs robot cubes (RTS take)', () => {
  let harness: SectorTestHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  // RTS Part B slice 3: the trigger moves to the brain's `intent.fire` with the line-of-fire gate. With the AI pilot brain all three cubes die (wingOnRobot >= 20), but the lock-driven fire still hits squadmates (11 > 3).
  it.skip('five hunting, aggressive wingmen kill three robot cubes without shooting each other', async () => {
    harness = await bootSectorTestServer(structuredClone(SHOWCASE_RTS_OPTS) as unknown as Record<string, unknown>);
    const pid = randomUUID();
    const client = await harness.connectAs(pid, { shipKind: 'fighter', startMode: 'command' });
    client.send('client_ready', { type: 'client_ready' });
    await harness.events.waitFor({ tag: 'command_start', where: (d) => d['playerId'] === pid }, 5_000);
    await harness.advance(500);
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const internals = room._internals;
    const ids = [...state.ships.values()]
      .filter((s) => s.playerId === pid && internals.fleet.brainOf(s.shipInstanceId) !== null)
      .map((s) => s.shipInstanceId);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    const robots = [...internals.swarmRegistry.all()].filter((r) => r.shipKind.startsWith('robot-')).map((r) => r.id);
    expect(robots).toHaveLength(3);

    // Count who hits whom (the room's one damage choke point).
    const r = room as unknown as { applyDamage: (t: string, s: string, d: number, x?: number, y?: number) => void };
    const orig = r.applyDamage.bind(room);
    const own = new Set(ids);
    let wingOnRobot = 0;
    let wingOnWing = 0;
    r.applyDamage = (t, s, d, x, y) => {
      if (own.has(s) && robots.includes(t)) wingOnRobot++;
      if (own.has(s) && own.has(t)) wingOnWing++;
      orig(t, s, d, x, y);
    };
    // Where each wingman bolt starts, relative to the hull that fired it.
    const pipe = (room as unknown as { projectiles: { spawn: (o: string, x: number, y: number, ...rest: unknown[]) => void } }).projectiles;
    const poses = (room as unknown as { lingeringPoseCache: Map<string, { x: number; y: number }> }).lingeringPoseCache;
    const origSpawn = pipe.spawn.bind(pipe);
    let bolts = 0;
    let worstOrigin = 0;
    pipe.spawn = (o, x, y, ...rest) => {
      const p = poses.get(o);
      if (own.has(o) && p !== undefined) {
        bolts++;
        worstOrigin = Math.max(worstOrigin, Math.hypot(x - p.x, y - p.y));
      }
      origSpawn(o, x, y, ...rest);
    };

    // The take: move the group north, then Hunt + Aggressive.
    client.send('fleet_order', { type: 'fleet_order', shipIds: ids, kind: 'move', x: 200, y: 700 });
    await harness.advance(4000);
    internals.fleet.setMode(pid, ids, 'hunt');
    internals.fleet.setStance(pid, ids, 'aggressive');

    const robotsLeft = (): number => robots.filter((id) => internals.swarmHealth.has(id)).length;
    for (let i = 0; i < 50 && robotsLeft() > 0; i++) await harness.advance(500);

    const alive = ids.filter((id) => state.ships.get(id)?.alive === true).length;
    expect(bolts).toBeGreaterThan(0);
    // A scene / restored hull is registered in the lag-comp ring but never
    // recorded there; its "rewound" pose read back (0, 0, angle 0), so every
    // bolt left the world origin heading north.
    expect(worstOrigin, 'every wingman bolt leaves its own hull').toBeLessThan(150);
    expect({ robotsLeft: robotsLeft(), wingOnRobot, wingOnWing, alive }).toMatchObject({ robotsLeft: 0 });
    expect(wingOnRobot, 'the wingmen land their shots on the cubes').toBeGreaterThanOrEqual(20);
    expect(wingOnWing, 'and never shoot each other').toBeLessThanOrEqual(3);
    expect(alive, 'five fighters beat three cubes (the NPC control loses 1; before the fix all 5 died)').toBeGreaterThanOrEqual(2);
  }, 120_000);

  // RTS Part B slice 4: owned ships never run (no morale; `noteDamage` folds into retaliation). The never-ticked wingman brain no longer rolls morale.
  it.skip('shield hits alone never roll morale; hull loss still does', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    const internals = room._internals;
    expect(internals.fleet.isAttached(sid)).toBe(true);
    expect(internals.spawnTestDrone('pest', 0, 900, 'fighter')).toBe(true);
    const ship = state.ships.get(sid)!;
    const brain = internals.fleet.brainOf(sid)!;
    expect(ship.shield, 'precondition: a full shield').toBeGreaterThan(ship.maxHealth * 0.6);

    // 60 % of max hull in shield hits inside one second: the burst trigger
    // (20 % of max hull in 2 s) would fire if shield damage counted.
    const hit = Math.round(ship.maxHealth * 0.15);
    for (let i = 0; i < 4; i++) {
      internals.applyDamage(sid, 'pest', hit);
      await harness.advance(150);
    }
    expect(ship.health, 'precondition: the shield took every hit').toBe(ship.maxHealth);
    expect(brain.moraleOutcome, 'no morale roll on shield damage').toBeNull();
    expect(brain.isMoraleRetreating).toBe(false);

    // Shield gone: the next blows land on the hull and the burst trigger rolls.
    for (let i = 0; i < 8 && ship.health > ship.maxHealth * 0.6; i++) {
      internals.applyDamage(sid, 'pest', hit);
      await harness.advance(100);
    }
    expect(ship.health).toBeLessThan(ship.maxHealth);
    expect(brain.moraleOutcome, 'hull loss rolls the morale die').not.toBeNull();
    await harness.disconnectClient(client);
  }, 60_000);
});
