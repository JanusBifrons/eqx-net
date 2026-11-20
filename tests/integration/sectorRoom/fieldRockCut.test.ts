/**
 * Field rock cut, slice 1C-b, through the REAL room: mining-laser hits on a
 * cut-FIELD rock (`applyDamage` → `onWreckHit` → `RockCutter`) wake it, wear
 * it and break it into wreck pieces like an ordinary rock; the break marks
 * it consumed (`field_consumed` to the live client, the welcome's
 * `cutField.consumed` for a late joiner) and its wreck descriptor carries
 * its field key (`rock.fk`, shape 0) in the joiner's welcome wreck list.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { WelcomeSchema } from '../../../src/shared-types/messages/snapshotMessages.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

describe('SectorRoom integration — the mining laser cuts field rocks (1C-b)', () => {
  it('a field rock breaks and late joiners see it consumed', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: 60_000, defaultSpawnY: 0 });
    const pid = randomUUID();
    const live = await harness.connectActive(pid, { shipKind: 'fighter', instantLock: true });
    const heard: unknown[] = [];
    live.onMessage('field_consumed', (m: unknown) => { heard.push(m); });
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    type FieldRec = { id: string; fieldRock?: boolean; fieldKey?: number; radius?: number };
    let rock: FieldRec | undefined;
    const deadline = Date.now() + 20_000;
    while (!rock && Date.now() < deadline) {
      await harness.advance(500);
      for (const r of int.swarmRegistry.all() as Iterable<FieldRec>) if (r.fieldRock === true) { rock = r; break; }
    }
    expect(rock?.fieldKey, 'a field rock streamed in').toBeTypeOf('number');
    const id = rock!.id, key = rock!.fieldKey!, radius = rock!.radius ?? 40;
    int.setWreckSeed(9);

    // The mining laser, beamed up through the rock just off its centre.
    let hits = 0;
    while (int.swarmRegistry.get(id) != null && hits < 400) {
      const p = int.swarmPose(id)!;
      int.applyDamage(id, pid, 5_000, p.x + 4, p.y - radius * 0.9, 0, 1, 'mining_laser');
      hits++;
      if (hits % 20 === 0) await harness.advance(20);
    }
    expect(int.swarmRegistry.get(id) ?? null, 'the field rock broke and left').toBeNull();
    expect(int.cutFieldSub!.isConsumed(key)).toBe(true);
    const desc = int.wreckDescriptors().find((d) => d.rock?.id === id)!;
    expect(desc, 'a rock wreck descriptor').toBeDefined();
    expect(desc.rock).toMatchObject({ shape: 0, fk: key });
    await harness.advance(200);
    expect(heard).toEqual([{ k: key }]);

    const joiner = await harness.connectAs(randomUUID());
    let welcome: unknown;
    joiner.onMessage('welcome', (m: unknown) => { welcome = m; });
    joiner.send('client_ready', { type: 'client_ready' });
    const until = Date.now() + 10_000;
    while (welcome === undefined && Date.now() < until) await harness.advance(100);
    expect(WelcomeSchema.safeParse(welcome).success, 'the welcome passes the client schema').toBe(true);
    const w = welcome as { cutField?: { consumed?: number[] }; wrecks?: Array<{ rock?: { fk?: number } }> };
    expect(w.cutField?.consumed).toContain(key);
    expect(w.wrecks?.some((d) => d.rock?.fk === key), 'the joiner gets the field rock wreck').toBe(true);
  });
});
