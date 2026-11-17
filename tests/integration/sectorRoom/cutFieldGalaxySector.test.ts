/**
 * Macro terrain F4 slice 2: a real `asteroid`-marked galaxy sector, booted
 * with exactly the options `resolveSectorConfig` gives `gameServer.define`,
 * has its one cut field on:
 *  - the joiner's welcome carries the sector's seed and pocket clearings (and
 *    passes the strict client schema);
 *  - every planned NPC base still grows in full (its pocket is a clearing);
 *  - the joiner spawns in open space, not inside a field rock.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { resolveSectorConfig } from '../../../src/server/galaxy/GalaxyRegistry.js';
import { cutFieldOpts, fieldRocksInBox } from '../../../src/core/terrain/chunkStreamer.js';
import { WelcomeSchema } from '../../../src/shared-types/messages/snapshotMessages.js';

const KEY = 'sol-prime';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

describe('SectorRoom integration — a galaxy sector with its cut field (F4)', () => {
  it(`${KEY}: welcome carries the field, bases grow in full, the joiner spawns clear of rocks`, { timeout: 90_000 }, async () => {
    const cfg = resolveSectorConfig(KEY);
    expect(cfg.cutField, `${KEY} is asteroid-marked`).toBeDefined();
    type Internals = SectorRoom['_internals'];
    const npcOf = (i: Internals): string[] => [...i.structureRegistry.all()]
      .filter((r) => r.owner.startsWith('npc:')).map((r) => r.owner + '|' + r.kind).sort();

    // The same sector without the field: what its NPC bases and gates grow to.
    harness = await bootSectorTestServer({
      sectorKey: KEY, droneCount: 0, testMode: true, asteroidConfig: cfg.asteroidConfig as never,
      galaxyBases: cfg.galaxyBases, alienGates: cfg.alienGates,
    });
    await harness.connectActive(randomUUID());
    const bare = npcOf((harness.getServerRoom() as unknown as SectorRoom)._internals);
    await harness.cleanup();

    harness = await bootSectorTestServer({
      sectorKey: KEY, droneCount: 0, testMode: true, asteroidConfig: cfg.asteroidConfig as never,
      galaxyBases: cfg.galaxyBases, alienGates: cfg.alienGates, cutField: cfg.cutField,
    });

    const pid = randomUUID();
    const cr = await harness.connectAs(pid);
    let welcome: unknown;
    cr.onMessage('welcome', (m: unknown) => { welcome = m; });
    cr.send('client_ready', { type: 'client_ready' });
    const until = Date.now() + 15_000;
    while (welcome === undefined && Date.now() < until) await harness.advance(100);
    expect(WelcomeSchema.safeParse(welcome).success, 'the welcome passes the client schema').toBe(true);
    expect((welcome as { cutField?: unknown }).cutField).toEqual({ seed: cfg.cutField!.seed, clearings: cfg.cutField!.clearings });

    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    expect(int.cutFieldSub, 'the room built its cut field').toBeDefined();

    // Every NPC structure the sector grows without a field is placed with it:
    // none refused for a field rock (the base pockets are clearings).
    const withField = npcOf(int);
    expect(withField.length).toBeGreaterThan(0);
    expect(withField, 'the field refuses no NPC structure').toEqual(bare);

    // The joiner is in open space.
    harness.sendThrust(cr);
    const snap = await harness.waitForSnapshot(cr, 5_000);
    const me = Object.values(snap.states).find((s) => s.playerId === pid)!;
    expect(me).toBeDefined();
    const o = { ...cutFieldOpts(cfg.cutField!.seed, cfg.cutField!.clearings) };
    const near = fieldRocksInBox(o, me.x - 3000, me.y - 3000, me.x + 3000, me.y + 3000)
      .filter((r) => Math.hypot(r.x - me.x, r.y - me.y) < r.radius + 100);
    expect(near, `spawn at (${Math.round(me.x)}, ${Math.round(me.y)})`).toEqual([]);
  });
});
